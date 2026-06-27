interface CacheEntry<T> {
  expiresAt: number
  value: T
}

/** Simple in-process TTL cache (per Node worker). */
export class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>()

  constructor(private ttlMs: number) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs })
  }

  delete(key: string): void {
    this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }
}
