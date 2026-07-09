/**
 * Non-invasive blockhash cache for a Solana `Connection`.
 *
 * Background — the SDK's ER tx send path calls `connection.getLatestBlockhash()`
 * once per transaction. That round-trip is ~30-80 ms and dominates the warm
 * latency of an `open` / `close`. The original cache implementation mutated
 * the SDK's Connection instance in place by overwriting `getLatestBlockhash`
 * with a closure that consulted a private cache. It worked, but had three
 * sharp edges:
 *
 *   1. The mutation was visible to anything else holding a reference to the
 *      same Connection (test harnesses, future SDK code) — a leak across
 *      ownership boundaries.
 *   2. Shutdown had to capture-and-restore the original method to avoid
 *      poisoning a re-created client built on the same Connection.
 *   3. If the SDK ever swapped its Connection field at runtime, our patch
 *      would silently stop working.
 *
 * The Proxy approach below sidesteps all three. The original Connection is
 * captured by reference inside the Proxy and is NEVER mutated. We intercept
 * `getLatestBlockhash` and forward every other call (including websocket
 * subscriptions and any private-field accessors) to the underlying instance
 * with `this` correctly bound — so methods that touch `Connection`'s
 * `#privateFields` keep working untouched.
 *
 * Limitations: a Connection method that internally calls
 * `this.getLatestBlockhash()` would bypass the cache (because we bind `this`
 * to the original target, not the Proxy, to keep private-field access
 * working). In practice the SDK calls `getLatestBlockhash` from outside the
 * Connection — e.g. `await connection.getLatestBlockhash()` from the send
 * path — which goes through the Proxy and hits the cache. If a future SDK
 * change starts calling internally, that call pays the RPC cost but is
 * still correct.
 */

import type { Connection } from '@solana/web3.js';

export interface BlockhashCacheEntry {
  blockhash: string;
  lastValidBlockHeight: number;
  fetchedAt: number;
}

/** Mutable cache slot. Held externally so the warmer can write to it. */
export interface BlockhashCacheRef {
  ref: BlockhashCacheEntry | null;
}

export interface WrapOpts {
  /** Max age before a cached entry is considered stale and refreshed inline. */
  maxAgeMs: number;
  /** Cache slot — caller keeps a reference for refresh/evict. */
  cache: BlockhashCacheRef;
}

/**
 * Return a `Connection`-shaped Proxy that serves cached blockhashes for
 * `maxAgeMs` and forwards every other call straight through to `inner`.
 *
 * The returned object is `instanceof Connection` (Proxy preserves the
 * prototype chain by default), so SDK code that does `instanceof` checks
 * keeps working.
 */
export function wrapConnectionWithBlockhashCache(
  inner: Connection,
  opts: WrapOpts,
): Connection {
  const { maxAgeMs, cache } = opts;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'getLatestBlockhash') {
        // Cached path. Return type matches Connection['getLatestBlockhash'].
        return async (
          ...args: Parameters<Connection['getLatestBlockhash']>
        ): ReturnType<Connection['getLatestBlockhash']> => {
          const cached = cache.ref;
          if (cached && Date.now() - cached.fetchedAt < maxAgeMs) {
            return {
              blockhash: cached.blockhash,
              lastValidBlockHeight: cached.lastValidBlockHeight,
            };
          }
          const fresh = await target.getLatestBlockhash(...args);
          cache.ref = { ...fresh, fetchedAt: Date.now() };
          return fresh;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      // Bind every method to the original target so `this` is correct for
      // any method that touches Connection's private fields. Without this
      // bind, calling `wrapped.getAccountInfo(...)` would have `this ===
      // wrappedProxy`, and Connection's private-field reads on `this`
      // would throw.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Connection;
}
