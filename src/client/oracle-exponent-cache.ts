/**
 * Per-instance oracle-exponent cache.
 *
 * Pyth feeds publish prices with a per-feed exponent (typically -8 for
 * crypto-USD, -5/-4 for FX/equities/metals). When the CLI serializes an
 * outbound trigger price (TP/SL/limit), it MUST use the same exponent the
 * chain stores — otherwise a TP at $200 on a -5-feed gets serialized as a
 * -8 number and ends up firing at $0.002 (or never).
 *
 * The cache observes exponents from live oracle reads + quote responses
 * and replays them on outbound encode. Each `MagicTradeClient` owns one
 * `OracleExponentCache` — keeping the cache per-instance prevents a
 * devnet client in the same process from poisoning a mainnet client's
 * exponents (or vice versa) when feed scales differ across pools.
 *
 * A module-level fallback (`globalFallback`) is read as a tier-2 hint
 * when the per-instance map misses, so a sibling client's earlier
 * observation is still better than the hard-coded -8 default.
 */

import BN from 'bn.js';

/** Bounds on a realistic Pyth exponent. */
const MIN_EXPONENT = -18;
const MAX_EXPONENT = 0;

/**
 * Module-level fallback. Written by every instance's `remember` so a
 * fresh client picks up the previous one's observations as a "best
 * guess" before its own first oracle read. Never used as the primary
 * source.
 */
const globalFallback = new Map<string, number>();

export class OracleExponentCache {
  private readonly map = new Map<string, number>();

  /**
   * Record an observed exponent. Bounds-check defensively — a corrupted
   * account read could produce NaN / out-of-range values that would
   * otherwise pollute the cache.
   */
  remember(symbol: string, exponent: number): void {
    if (!Number.isFinite(exponent)) return;
    if (exponent > MAX_EXPONENT || exponent < MIN_EXPONENT) return;
    const key = symbol.toUpperCase();
    this.map.set(key, exponent);
    globalFallback.set(key, exponent);
  }

  /**
   * Look up the exponent for `symbol`. Returns:
   *   - per-instance map hit  → that value
   *   - module fallback hit   → that value (tier-2, populated by siblings)
   *   - miss                  → null  (caller decides default)
   */
  lookup(symbol: string): number | null {
    const key = symbol.toUpperCase();
    return this.map.get(key) ?? globalFallback.get(key) ?? null;
  }

  /**
   * Convert a USD price to the on-chain `OraclePrice` shape using the
   * cached exponent. When the cache misses, falls back to -8 (crypto-USD
   * default). Returns the exponent it actually used so callers can log /
   * warn on the miss path.
   */
  encode(symbol: string, usd: number): { price: BN; exponent: number; usedDefault: boolean } {
    const known = this.lookup(symbol);
    const exponent = known ?? -8;
    const scaled = Math.round(usd * Math.pow(10, -exponent));
    return {
      price: new BN(scaled),
      exponent,
      usedDefault: known === null,
    };
  }
}
