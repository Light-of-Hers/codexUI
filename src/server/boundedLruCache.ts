type BoundedLruCacheOptions = {
  maxEntries: number
  maxWeight: number
  maxIdleMs: number
  now?: () => number
}

type CacheEntry<T> = {
  value: T
  weight: number
  accessedAt: number
}

export class BoundedLruCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>()
  private readonly now: () => number
  private totalWeight = 0

  constructor(private readonly options: BoundedLruCacheOptions) {
    this.now = options.now ?? Date.now
  }

  get size(): number {
    this.pruneExpired()
    return this.entries.size
  }

  get weight(): number {
    this.pruneExpired()
    return this.totalWeight
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    const now = this.now()
    if (now - entry.accessedAt > this.options.maxIdleMs) {
      this.delete(key)
      return undefined
    }
    entry.accessedAt = now
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: T, weight = 1): void {
    this.delete(key)
    const normalizedWeight = Number.isFinite(weight) ? Math.max(0, weight) : this.options.maxWeight
    this.entries.set(key, { value, weight: normalizedWeight, accessedAt: this.now() })
    this.totalWeight += normalizedWeight
    this.prune()
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key)
    if (!entry) return false
    this.entries.delete(key)
    this.totalWeight = Math.max(0, this.totalWeight - entry.weight)
    return true
  }

  clear(): void {
    this.entries.clear()
    this.totalWeight = 0
  }

  private pruneExpired(): void {
    const cutoff = this.now() - this.options.maxIdleMs
    for (const [key, entry] of this.entries) {
      if (entry.accessedAt > cutoff) break
      this.delete(key)
    }
  }

  private prune(): void {
    this.pruneExpired()
    while (
      this.entries.size > this.options.maxEntries
      || this.totalWeight > this.options.maxWeight
    ) {
      const oldestKey = this.entries.keys().next().value
      if (!oldestKey) break
      this.delete(oldestKey)
    }
  }
}
