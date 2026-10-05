import { ref, shallowRef, triggerRef, watch, watchEffect, nextTick } from 'vue'
import { memoize } from './lru'
import { createScheduler } from './scheduler'
import { createStreamBuffer } from './stream'

/**
 * 边界用例行为断言：全部基于真实响应式行为，不允许硬编码结果。
 * 每个用例返回 { name, pass, detail }。
 */

export interface SelfTestResult {
  name: string
  pass: boolean
  detail: string
}

export async function runSelfTests(): Promise<SelfTestResult[]> {
  const results: SelfTestResult[] = []
  const push = (name: string, pass: boolean, detail: string): void => {
    results.push({ name, pass, detail })
  }

  /* 1. shallowRef + triggerRef：漏 trigger 的静默不更新必须可观测 */
  {
    const s = shallowRef({ nested: { v: 0 } })
    let runs = 0
    const stop = watchEffect(() => {
      void s.value.nested.v
      runs++
    })
    const afterMount = runs
    s.value.nested.v = 1 // 深路径写入，不 trigger
    await nextTick()
    const silentOk = runs === afterMount // 断言：确实静默不更新（这是要规避的坑）
    s.value.nested.v = 2
    triggerRef(s) // 批量收尾手动触发
    await nextTick()
    const triggeredOk = runs === afterMount + 1
    s.value = { nested: { v: 3 } } // 整包替换自动触发
    await nextTick()
    const replacedOk = runs === afterMount + 2
    stop()
    push(
      'shallowRef/triggerRef 边界',
      silentOk && triggeredOk && replacedOk,
      `深写无trigger不更新=${silentOk} triggerRef后更新=${triggeredOk} 替换更新=${replacedOk} (runs=${runs})`,
    )
  }

  /* 2. watcher pause/resume：恢复后不丢依赖 */
  {
    const src = ref(0)
    const seen: number[] = []
    const h = watch(src, (v) => seen.push(v))
    src.value = 1
    await nextTick()
    h.pause()
    src.value = 2
    src.value = 3
    await nextTick()
    const pausedOk = seen.length === 1 // 暂停期不触发
    h.resume()
    await nextTick()
    const resumedOk = seen.length === 2 && seen[1] === 3 // 恢复补一次最新值
    src.value = 4
    await nextTick()
    const aliveOk = seen.length === 3 && seen[2] === 4 // 依赖未丢
    h()
    push(
      'watcher pause/resume',
      pausedOk && resumedOk && aliveOk,
      `暂停不触发=${pausedOk} 恢复补最新=${resumedOk} 恢复后仍响应=${aliveOk} seen=[${seen.join(',')}]`,
    )
  }

  /* 3. LRU：对象身份键、淘汰顺序、版本失效 */
  {
    let calls = 0
    const f = memoize((o: { a: number }, k: number) => {
      calls++
      return o.a + k
    }, { maxSize: 2 })
    const o1 = { a: 1 }
    const o2 = { a: 1 } // 同内容不同身份：JSON.stringify 会误判同键
    f(o1, 1)
    f(o2, 1)
    const identityOk = calls === 2 && f(o1, 1) === 2 && calls === 2
    const o3 = { a: 1 }
    f(o3, 1) // 容量 2：淘汰最久未用 (o2,1)，o1 因刚命中而保留
    const callsBefore = calls
    const hitOk = f(o1, 1) === 2 && calls === callsBefore // o1 仍命中
    f(o2, 1)
    const evictedOk = calls === callsBefore + 1 // o2 被淘汰 → 重算
    let ver = 0
    const vf = memoize((x: number) => x * 2, { version: () => ver })
    vf(5)
    const vMissBefore = vf.misses
    ver = 1 // 版本换代 → 整体失效
    vf(5)
    const versionOk = vf.misses === vMissBefore + 1
    push(
      'LRU 记忆化键与失效',
      identityOk && evictedOk && hitOk && versionOk,
      `对象身份键=${identityOk} LRU淘汰=${evictedOk} 命中保持=${hitOk} 版本失效=${versionOk}`,
    )
  }

  /* 4. 调度器：完成性、优先级、取消、错误传播、重入 flush */
  {
    const order: number[] = []
    const errs: unknown[] = []
    const sched = createScheduler({ frameBudgetMs: 8, onError: (e) => errs.push(e) })
    for (let i = 0; i < 40; i++) {
      sched.schedule({ priority: 'idle', run: () => { order.push(i) } })
    }
    const cancelled = sched.schedule({ priority: 'idle', run: () => { order.push(999) } })
    cancelled.cancel()
    sched.schedule({ priority: 'idle', run: () => { throw new Error('boom') } })
    sched.schedule({ priority: 'critical', run: () => { order.push(-1) } })
    await sched.whenIdle()
    const completeOk = order.filter((n) => n >= 0 && n < 40).length === 40
    const cancelOk = !order.includes(999)
    const errorOk = errs.length === 1
    const priorityOk = order[0] === -1 // critical 插队到最前

    // 重入 flush 边界：分片任务内写响应式状态并 await nextTick
    const src = ref(0)
    let stage = 0
    let flushCount = 0
    const stopWatch = watch(src, () => flushCount++)
    const s2 = createScheduler({ frameBudgetMs: 8 })
    s2.schedule({
      priority: 'critical',
      run: async () => {
        src.value = 1
        await nextTick() // 等 Vue flush 重入完成
        stage = 1
        src.value = 2
        await nextTick()
        stage = 2
      },
    })
    await s2.whenIdle()
    stopWatch()
    const reentrantOk = stage === 2 && flushCount === 2 && src.value === 2
    push(
      '分片调度器边界',
      completeOk && cancelOk && errorOk && priorityOk && reentrantOk,
      `完成=${completeOk} 取消=${cancelOk} 错误传播=${errorOk} 优先级=${priorityOk} 重入flush=${reentrantOk}`,
    )
  }

  /* 5. 流缓冲背压：三种丢弃策略语义 */
  {
    const b1 = createStreamBuffer<number>(3, 'drop-oldest')
    b1.pushBatch([1, 2, 3, 4, 5])
    const oldestOk = b1.drain().join(',') === '3,4,5' && b1.dropped === 2
    const b2 = createStreamBuffer<number>(3, 'drop-newest')
    b2.pushBatch([1, 2, 3, 4, 5])
    const newestOk = b2.drain().join(',') === '1,2,3' && b2.dropped === 2
    const b3 = createStreamBuffer<number>(3, 'unbounded')
    b3.pushBatch([1, 2, 3, 4, 5])
    const unboundedOk = b3.drain().length === 5 && b3.dropped === 0
    push(
      '流缓冲背压策略',
      oldestOk && newestOk && unboundedOk,
      `丢最旧=${oldestOk} 拒最新=${newestOk} 不丢弃=${unboundedOk}`,
    )
  }

  return results
}
