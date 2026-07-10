/**
 * LRU + TTL cache for AI intent results, keyed by the hash of the NORMALIZED
 * input. A cache hit bypasses the model entirely — repeated or near-identical
 * phrasings never re-bill. The cached value is the model's canonical command
 * STRING (or null), never a parsed command: it is still re-parsed through the
 * deterministic pipeline on every hit, so the firewall holds for cached results
 * exactly as it does for fresh ones.
 */

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class IntentCache<V> {
  private readonly map = new Map<string, Entry<V>>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) {
      this.misses++;
      return undefined;
    }
    if (e.expiresAt <= this.now()) {
      this.map.delete(key);
      this.misses++;
      return undefined;
    }
    // Refresh recency (LRU): re-insert at the tail.
    this.map.delete(key);
    this.map.set(key, e);
    this.hits++;
    return e.value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  stats(): { size: number; hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      size: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }
}
