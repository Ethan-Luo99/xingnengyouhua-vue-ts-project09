/**
 * LRU 记忆化模块
 * 键设计: 对象入参经 WeakMap 分配稳定 id, 禁止 JSON.stringify 大对象作键(键生成 O(n) 比不缓存还慢)
 * 失效策略:
 *  1. 版本失效(首选): version() 返回的数据版本变化时整体清空
 *  2. LRU 容量上限: 超出 max 淘汰最久未使用
 *  3. 对象 id 基于 WeakMap: 对象被 GC 后其键自然失效, 无手工清理
 */

const objectIds = new WeakMap<object, number>()
let nextObjectId = 1

export function objectId(obj: object): number {
  let id = objectIds.get(obj)
  if (id === undefined) {
    id = nextObjectId++
    objectIds.set(obj, id)
  }
  return id
}

/** 默认键: 标量直接用值, 对象/函数用 WeakMap 分配的 id */
export function defaultKey(args: unknown[]): string {
  let key = ''
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const t = typeof a
    if (a === null) key += 'n'
    else if (t === 'object' || t === 'function') key += 'o' + objectId(a as object)
    else if (t === 'string') key += 's' + (a as string)
    else if (t === 'number') key += 'i' + (a as number)
    else if (t === 'boolean') key += 'b' + (a ? '1' : '0')
    else key += t
    if (i < args.length - 1) key += '|'
  }
  return key
}

export interface MemoOptions<A extends unknown[]> {
  max?: number
  key?: (...args: A) => string
  /** 数据版本号访问器; 版本变化 -> 整体失效 */
  version?: () => number
}

export interface MemoStats {
  calls: number
  hits: number
  misses: number
  evictions: number
  invalidations: number
  size: number
}

export interface Memoized<A extends unknown[], R> {
  (...args: A): R
  readonly stats: MemoStats
  clear(): void
}

export function memoizeLru<A extends unknown[], R>(fn: (...args: A) => R, opts: MemoOptions<A> = {}): Memoized<A, R> {
  const max = opts.max ?? 1000
  const cache = new Map<string, R>()
  const stats: MemoStats = { calls: 0, hits: 0, misses: 0, evictions: 0, invalidations: 0, size: 0 }
  let lastVersion = opts.version?.()

  const wrapped = (...args: A): R => {
    stats.calls++
    if (opts.version) {
      const v = opts.version()
      if (v !== lastVersion) {
        cache.clear()
        stats.invalidations++
        stats.size = 0
        lastVersion = v
      }
    }
    const k = opts.key ? opts.key(...args) : defaultKey(args)
    const hit = cache.get(k)
    if (hit !== undefined || cache.has(k)) {
      stats.hits++
      // LRU: 命中后重插到最新位置
      cache.delete(k)
      cache.set(k, hit as R)
      return hit as R
    }
    stats.misses++
    const v = fn(...args)
    cache.set(k, v)
    if (cache.size > max) {
      const oldest = cache.keys().next()
      if (!oldest.done) {
        cache.delete(oldest.value)
        stats.evictions++
      }
    }
    stats.size = cache.size
    return v
  }

  wrapped.stats = stats
  wrapped.clear = () => {
    cache.clear()
    stats.size = 0
  }
  return wrapped as Memoized<A, R>
}
