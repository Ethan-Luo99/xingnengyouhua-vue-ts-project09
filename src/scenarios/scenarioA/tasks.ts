import { reactive, watch, effectScope, onScopeDispose, type EffectScope } from 'vue'
import { count } from '../../perf/metrics'
import type { ChunkScheduler } from '../../perf/scheduler'

/** 卸载后残留副作用探针: 优化模式卸载后必须全部归零 */
export const residue = reactive({
  intervals: 0,
  listeners: 0,
  watchers: 0,
  /** 泄漏探针: 卸载后仍在跳动即证明有游离定时器 */
  leakedTicks: 0,
})

export function residueTotal(): number {
  return residue.intervals + residue.listeners + residue.watchers
}

export type Priority = 'critical' | 'visible' | 'idle'

export interface InitTask {
  id: number
  priority: Priority
  deps: number[]
  run: (ctx: TaskContext) => void
}

export interface TaskContext {
  results: number[]
  registerEffect: (kind: 'interval' | 'listener' | 'watcher') => void
}

/** 确定性 CPU 负载: 模拟一个真实初始化函数的计算量 */
function burn(seed: number, iterations: number): number {
  let acc = seed
  for (let i = 0; i < iterations; i++) {
    acc = (acc * 1103515245 + 12345 + i) % 2147483647
    acc ^= Math.floor(Math.sqrt(acc % 9973) * 1000)
  }
  return acc
}

/** 共享 tick, 部分任务的 watcher 依赖它(模拟初始化时订阅全局状态) */
export const sharedTick = reactive({ value: 0 })

/** 基线模式的游离副作用登记(模块级, 不随组件销毁) —— 真实世界反模式的复现 */
const leakedCleanups: (() => void)[] = []
let leakedScope: EffectScope | null = null

/** 测试卫生: 基准跑完基线后强制清理, 避免页面越用越慢影响后续测量 */
export function forceCleanupBaseline() {
  for (const fn of leakedCleanups.splice(0)) fn()
  leakedScope?.stop()
  leakedScope = null
  residue.intervals = 0
  residue.listeners = 0
  residue.watchers = 0
}

export function buildTasks(total = 320): InitTask[] {
  const tasks: InitTask[] = []
  for (let i = 0; i < total; i++) {
    const priority: Priority = i < 40 ? 'critical' : i < 160 ? 'visible' : 'idle'
    const deps: number[] = []
    if (i > 0 && i % 4 === 0) deps.push(i - 1)
    if (i > 7 && i % 9 === 0) deps.push(i - 8)
    // 闭包状态: 每个任务捕获自己的局部状态
    const closure = { seed: i * 7919, acc: 0 }
    const iterations = 3000 + (i % 5) * 2500
    tasks.push({
      id: i,
      priority,
      deps,
      run(ctx: TaskContext) {
        count('A 任务执行数')
        let acc = burn(closure.seed, iterations)
        for (const d of deps) acc = (acc + (ctx.results[d] ?? 0)) % 2147483647
        closure.acc = acc
        ctx.results[i] = acc
        // 约 1/5 的任务注册副作用(定时器/全局监听/响应式订阅)
        if (i % 5 === 0) ctx.registerEffect(i % 15 === 0 ? 'interval' : i % 10 === 0 ? 'listener' : 'watcher')
      },
    })
  }
  return tasks
}

/** 拓扑序(依赖只指向更小 id, Kahn 即可; 这里按依赖深度排序保证依赖先执行) */
export function topoSort(tasks: InitTask[]): InitTask[] {
  const depth = new Map<number, number>()
  const depthOf = (t: InitTask): number => {
    const cached = depth.get(t.id)
    if (cached !== undefined) return cached
    const d = t.deps.length ? 1 + Math.max(...t.deps.map((id) => depthOf(tasks[id]!))) : 0
    depth.set(t.id, d)
    return d
  }
  return [...tasks].sort((a, b) => depthOf(a) - depthOf(b) || a.id - b.id)
}

export const priorityWeight: Record<Priority, number> = { critical: 0, visible: 1, idle: 2 }

/** 优化模式: 在 pageScope 内注册副作用, scope.stop() 即零残留 */
export function makeScopedRegisterEffect(scope: EffectScope): (kind: 'interval' | 'listener' | 'watcher') => void {
  return (kind) => {
    scope.run(() => {
      if (kind === 'interval') {
        residue.intervals++
        const id = setInterval(() => {
          residue.leakedTicks++
        }, 250)
        onScopeDispose(() => {
          clearInterval(id)
          residue.intervals--
        })
        return
      }
      if (kind === 'listener') {
        residue.listeners++
        const handler = () => count('A 全局监听触发')
        window.addEventListener('resize', handler)
        onScopeDispose(() => {
          window.removeEventListener('resize', handler)
          residue.listeners--
        })
        return
      }
      residue.watchers++
      watch(sharedTick, () => count('A watcher 触发'))
      onScopeDispose(() => {
        residue.watchers--
      })
    })
  }
}

/** 基线模式: 模块级散管, 组件卸载后不清理(泄漏) */
export function makeLeakyRegisterEffect(): (kind: 'interval' | 'listener' | 'watcher') => void {
  return (kind) => {
    if (kind === 'interval') {
      residue.intervals++
      const id = setInterval(() => {
        residue.leakedTicks++
      }, 250)
      leakedCleanups.push(() => clearInterval(id))
      return
    }
    if (kind === 'listener') {
      residue.listeners++
      const handler = () => count('A 全局监听触发')
      window.addEventListener('resize', handler)
      leakedCleanups.push(() => window.removeEventListener('resize', handler))
      return
    }
    residue.watchers++
    leakedScope ??= effectScope(true)
    leakedScope.run(() => {
      watch(sharedTick, () => count('A watcher 触发'))
    })
  }
}

/** 当前挂载实例使用的调度器(供基准等待全部任务完成) */
export let currentScheduler: ChunkScheduler | null = null
export function setCurrentScheduler(s: ChunkScheduler | null) {
  currentScheduler = s
}

export const runState = reactive({
  mounted: false,
  done: 0,
  total: 320,
  phase: '未运行' as string,
})
