import { reactive, ref, watchEffect, onScopeDispose, getCurrentScope, type EffectScope } from 'vue'
import { createScheduler, type Scheduler } from '../../perf/scheduler'

/**
 * 场景 A：挂载阶段集中执行 360 个注册任务。
 * 任务含不同优先级（critical/visible/idle）、闭包状态、相互依赖（拓扑序）。
 * 基线与优化执行完全相同的任务体，差别只在调度方式与作用域治理。
 */

export const TASK_COUNT = 360
/** 每任务派生计算量（真实 CPU 工作：构建查找表） */
export const TASK_WORK = 5000

export const PROBE_EVENT = 'perf-a-probe'
/** 模块级共享源：用于卸载后探针断言 watcher 是否残留 */
export const probeSource = ref(0)

export interface InitTask {
  id: number
  priority: 'critical' | 'visible' | 'idle'
  deps: number[]
  seed: number
}

export interface Registry {
  listenerFires: number
  watcherFires: number
  intervalTicks: number
  listeners: Array<() => void>
  intervals: number[]
  scope: EffectScope | null
  disposeAll: () => void
}

export function createRegistry(): Registry {
  const registry: Registry = {
    listenerFires: 0,
    watcherFires: 0,
    intervalTicks: 0,
    listeners: [],
    intervals: [],
    scope: null,
    disposeAll: () => {
      for (const fn of registry.listeners) window.removeEventListener(PROBE_EVENT, fn)
      registry.listeners.length = 0
      for (const id of registry.intervals) clearInterval(id)
      registry.intervals.length = 0
      registry.scope?.stop()
      registry.scope = null
    },
  }
  return registry
}

export function buildTasks(count: number): InitTask[] {
  const tasks: InitTask[] = []
  for (let i = 0; i < count; i++) {
    const deps: number[] = []
    if (i > 0 && i % 4 === 0) deps.push(i - 1) // 链式依赖
    if (i >= 5 && i % 10 === 0) deps.push(i - 5) // 跨步依赖
    tasks.push({
      id: i,
      priority: i < count * 0.1 ? 'critical' : i < count * 0.4 ? 'visible' : 'idle',
      deps,
      seed: (i * 2654435761) % 1000003,
    })
  }
  return tasks
}

export interface TaskCtx {
  results: Map<number, number>
  registry: Registry
}

/**
 * 单个注册任务体（基线/优化共用）：
 * 1. 真实派生计算（构建查找表，结果供依赖者读取）
 * 2. 闭包状态 + 响应式状态
 * 3. 注册 window 监听器（闭包捕获 table/state）
 * 4. 创建 watchEffect（挂在当前 effectScope 上）
 * 5. 部分任务注册 interval
 */
export function executeTask(task: InitTask, ctx: TaskCtx): void {
  let acc = task.seed
  for (const dep of task.deps) {
    acc = (acc + (ctx.results.get(dep) ?? 0)) % 1000003
  }
  const table = new Map<number, number>()
  for (let k = 0; k < TASK_WORK; k++) {
    acc = (acc * 31 + k) % 1000003
    table.set(k, acc)
  }
  const state = reactive({ count: 0, seed: task.seed })
  const listener = (): void => {
    ctx.registry.listenerFires++
    state.count += table.get(0) ?? 0
  }
  window.addEventListener(PROBE_EVENT, listener)
  ctx.registry.listeners.push(listener)
  if (getCurrentScope()) {
    onScopeDispose(() => window.removeEventListener(PROBE_EVENT, listener))
  }
  watchEffect(() => {
    if (probeSource.value >= 0) ctx.registry.watcherFires++
  })
  if (task.id % 24 === 0) {
    const iv = window.setInterval(() => {
      ctx.registry.intervalTicks++
    }, 50)
    ctx.registry.intervals.push(iv)
    if (getCurrentScope()) {
      onScopeDispose(() => clearInterval(iv))
    }
  }
  ctx.results.set(task.id, acc)
}

/** 基线路径：同步循环一次跑完全部任务（长任务），scope 由调用方给定 */
export function runAllSync(tasks: InitTask[], ctx: TaskCtx, scope: EffectScope): void {
  scope.run(() => {
    for (const task of tasks) executeTask(task, ctx)
  })
}

/** 优化路径：经自适应分片调度器按优先级逐帧消费 */
export function runAllChunked(
  tasks: InitTask[],
  ctx: TaskCtx,
  scope: EffectScope,
  onDone: (scheduler: Scheduler) => void,
): Scheduler {
  const scheduler = createScheduler({ frameBudgetMs: 8 })
  for (const task of tasks) {
    scheduler.schedule({
      priority: task.priority,
      run: () => {
        scope.run(() => executeTask(task, ctx))
      },
    })
  }
  void scheduler.whenIdle().then(() => onDone(scheduler))
  return scheduler
}
