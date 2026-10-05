/**
 * LRU 记忆化模块（手段 8）。
 *
 * 键设计：禁止 JSON.stringify 大对象。默认键为“参数身份字典树”：
 * 每层用 Map 按参数索引，对象参数按引用身份（Map 键即对象本身，
 * 不序列化、不展开），原始参数按值。同内容不同引用的两个对象
 * 是不同键（正确：函数可能读取对象的可变字段）。
 *
 * 失效策略（可组合）：
 * 1. LRU 容量淘汰：超过 maxSize 淘汰最久未用条目（Map 插入序）。
 * 2. 版本失效：提供 version() 时，版本号变化即整体清空
 *    （适用于“源数据换代”场景，O(1) 失效）。
 * 3. 手动 invalidate()。
 */

export interface MemoizeOptions<Args extends unknown[]> {
  maxSize?: number
  /** 自定义键（仅当参数可安全转字符串时使用）；默认身份字典树 */
  key?: (...args: Args) => string
  /** 版本号源；返回值变化时整体失效 */
  version?: () => number
}

export interface Memoized<Args extends unknown[], R> {
  (...args: Args): R
  invalidate: () => void
  readonly size: number
  readonly hits: number
  readonly misses: number
}

interface TrieNode {
  children: Map<unknown, TrieNode>
  hasValue: boolean
  value: unknown
  /** LRU 链表序：用 Map 的插入序即可，trie 叶子另存于 lru Map */
}

export function memoize<Args extends unknown[], R>(
  fn: (...args: Args) => R,
  options: MemoizeOptions<Args> = {},
): Memoized<Args, R> {
  const maxSize = options.maxSize ?? 256
  const keyFn = options.key
  const versionFn = options.version

  // 字符串键路径与字典树路径共用同一个 LRU Map（键为 string 或 TrieNode 对象）
  const lru = new Map<unknown, R>()
  const root: TrieNode = { children: new Map(), hasValue: false, value: undefined }
  let hits = 0
  let misses = 0
  let lastVersion = versionFn?.()

  function lookupTrie(args: Args): TrieNode {
    let node = root
    for (let i = 0; i < args.length; i++) {
      const arg: unknown = args[i]
      let next = node.children.get(arg)
      if (next === undefined) {
        next = { children: new Map(), hasValue: false, value: undefined }
        node.children.set(arg, next)
      }
      node = next
    }
    return node
  }

  function checkVersion(): void {
    if (versionFn === undefined) return
    const v = versionFn()
    if (v !== lastVersion) {
      lastVersion = v
      lru.clear()
      root.children.clear()
    }
  }

  const memoized = (...args: Args): R => {
    checkVersion()
    const cacheKey: unknown = keyFn ? keyFn(...args) : lookupTrie(args)
    const cached = lru.get(cacheKey)
    if (cached !== undefined || lru.has(cacheKey)) {
      hits++
      // LRU：重新插入到最新位置
      lru.delete(cacheKey)
      lru.set(cacheKey, cached as R)
      return cached as R
    }
    misses++
    const result = fn(...args)
    lru.set(cacheKey, result)
    if (lru.size > maxSize) {
      // Map 迭代序 = 插入序，第一个键即最久未用
      const oldest = lru.keys().next()
      if (!oldest.done) lru.delete(oldest.value)
    }
    return result
  }

  memoized.invalidate = () => {
    lru.clear()
    root.children.clear()
  }
  Object.defineProperty(memoized, 'size', { get: () => lru.size })
  Object.defineProperty(memoized, 'hits', { get: () => hits })
  Object.defineProperty(memoized, 'misses', { get: () => misses })
  return memoized as Memoized<Args, R>
}
