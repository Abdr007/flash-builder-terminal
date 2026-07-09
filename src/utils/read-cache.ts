/**
 * Generic TTL cache for read-side operations.
 *
 * The CLI's hot path is "user runs 5 commands in 10 seconds, each
 * touching `getPortfolio` / `getMarketData` / `getAvailableBalances`".
 * Without a cache, every command pays the 100-300ms RPC round-trip.
 * With a 1.5-second TTL the second-through-fifth land instantly while
 * the first absorbs the cold-start cost.
 *
 * Design constraints:
 *  - **Per-key, per-instance**: each (symbol, side, wallet) triple is its
 *    own cache key. No global shared cache — the SDK's caches already
 *    cover protocol-level invariants; this layer covers the user-flow
 *    invariant ("two reads in a second can be the same").
 *  - **TTL is short** (default 1500 ms): trading data must stay fresh.
 *    Long enough to coalesce burst commands, short enough that the user
 *    never sees stale state at a meaningful trade-decision boundary.
 *  - **Bounded**: 256-entry LRU per instance. A long session that walks
 *    every market never grows the cache without bound.
 *  - **Coalesces concurrent fetches**: two parallel `get(k)` calls with
 *    the same key share one underlying fetch. This is the single most
 *    common cause of "5× same RPC in 50 ms" the audit flagged.
 *  - **Invalidation hooks**: write paths (open, close, deposit, ...) call
 *    `bust(prefix)` so a `portfolio` immediately after `open SOL long`
 *    sees the new state, not a stale cache.
 *  - **Off under NO_DNA**: agents typically want fresh reads; auto-disable
 *    when `process.env.NO_DNA` is set so they get a chain-truth answer
 *    every call.
 */

const DEFAULT_TTL_MS = 1500;
const DEFAULT_MAX_ENTRIES = 256;

interface Entry<V> {
  value: V;
  expiresAt: number;
}

interface Pending<V> {
  promise: Promise<V>;
  startedAt: number;
  /** Identity sentinel — finally block uses this to check if the slot is still ours. */
  id: symbol;
}

export interface ReadCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** Disable the cache entirely. Useful for agents that need chain-truth. */
  disabled?: boolean;
}

export class ReadCache<V> {
  private store = new Map<string, Entry<V>>();
  private inflight = new Map<string, Pending<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly disabled: boolean;
  // Telemetry — surfaced by `magic perf`.
  private hits = 0;
  private misses = 0;
  private coalesced = 0;

  constructor(opts: ReadCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.disabled = opts.disabled ?? Boolean(process.env.NO_DNA);
  }

  /**
   * Cache-aware read. If a fresh entry exists, returns it. If a fetch is
   * already in flight for the same key, joins it (no duplicate RPC). Else
   * runs `loader()` and caches the result.
   *
   * Errors from `loader()` are NOT cached — failed reads are retried on
   * the next call so transient RPC blips don't lock in a bad result.
   */
  /**
   * Per-key epoch counter — incremented every time a key is busted (or
   * `clear()` runs). The cold-path captures the epoch at fetch start; if
   * the epoch advances during the await (a write path called `bust()`
   * mid-fetch), the loader's stale result is discarded instead of being
   * committed. Without this, a write that lands during an in-flight read
   * silently leaks pre-write state into the cache for the next TTL window.
   */
  private epoch = new Map<string, number>();

  async get(key: string, loader: () => Promise<V>): Promise<V> {
    if (this.disabled) return loader();

    // Fresh hit — return immediately.
    const cached = this.store.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.hits++;
      // LRU touch: re-insert so the entry moves to the most-recent slot.
      this.store.delete(key);
      this.store.set(key, cached);
      return cached.value;
    }

    // In-flight coalesce — share the existing fetch.
    const inflight = this.inflight.get(key);
    if (inflight) {
      this.coalesced++;
      return inflight.promise;
    }

    // Cold path — fire the loader, expose the promise to subsequent
    // concurrent callers via `inflight`, then commit on success.
    this.misses++;
    const startEpoch = this.epoch.get(key) ?? 0;
    // We use a sentinel object on the inflight Pending — the finally block
    // checks `current.id === id` rather than reaching for a forward-declared
    // promise variable, which TS rejects under strict use-before-assign.
    const id = Symbol(key);
    const promise = (async (): Promise<V> => {
      try {
        const value = await loader();
        // Stale-write guard: if the key was busted while the loader was in
        // flight, the result reflects pre-write chain state. Drop it.
        if ((this.epoch.get(key) ?? 0) !== startEpoch) {
          return value;
        }
        // Commit to cache.
        if (this.store.size >= this.maxEntries) {
          // Evict the oldest entry (Map iteration order = insertion order).
          const oldest = this.store.keys().next().value;
          if (oldest !== undefined) this.store.delete(oldest);
        }
        this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        return value;
      } finally {
        // Only clear the in-flight slot if it's still ours — a bust() that
        // ran during the await may have already replaced it. Without this
        // check, a chained `.finally` from a stale promise can null out
        // the in-flight entry of a freshly-issued one.
        const current = this.inflight.get(key);
        if (current && current.id === id) this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, { promise, startedAt: Date.now(), id });
    return promise;
  }

  /**
   * Invalidate every key whose name starts with `prefix`. Call this from
   * write paths so the next read sees fresh state. Examples:
   *   bust('portfolio:')        // after open/close/increase/decrease
   *   bust('vault:')            // after deposit/withdraw/settle
   *   bust('markets:')          // after rpc-set (rare)
   *
   * In-flight loaders for matching keys also get their epoch bumped — when
   * they resolve, their results are discarded instead of being written to
   * the cache. This closes the "write lands during read" stale-leak window.
   */
  bust(prefix: string): void {
    for (const k of Array.from(this.store.keys())) {
      if (k.startsWith(prefix)) this.store.delete(k);
    }
    // Bump epoch for matching keys (covers in-flight loaders too).
    for (const k of Array.from(this.inflight.keys())) {
      if (k.startsWith(prefix)) this.epoch.set(k, (this.epoch.get(k) ?? 0) + 1);
    }
  }

  /** Wipe the entire cache. Used on wallet switch and explicit `magic refresh`. */
  clear(): void {
    // Bump every in-flight key's epoch so any pending loader's commit is
    // discarded — same staleness window as `bust()` but for a full clear.
    for (const k of this.inflight.keys()) {
      this.epoch.set(k, (this.epoch.get(k) ?? 0) + 1);
    }
    this.store.clear();
    this.inflight.clear();
  }

  /** Size + telemetry — `magic perf` reads this. */
  stats(): { size: number; maxEntries: number; ttlMs: number; hits: number; misses: number; coalesced: number; hitRate: number } {
    const total = this.hits + this.misses + this.coalesced;
    return {
      size: this.store.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      hits: this.hits,
      misses: this.misses,
      coalesced: this.coalesced,
      hitRate: total > 0 ? (this.hits + this.coalesced) / total : 0,
    };
  }
}
