/**
 * Pure money math — extracted from magic-client.ts so it can be unit
 * tested in isolation, property-tested for invariants, and reused
 * without dragging in the SDK / RPC stack.
 *
 * Every function here MUST be:
 *   - Pure: no I/O, no `this`, no module-level mutable state.
 *   - Total: returns a finite number (or 0) for every input. Never throws.
 *   - Defensive: NaN / Infinity / negative-zero / out-of-range exponents
 *     all collapse to 0 instead of propagating poison values into UI or
 *     trade-sizing code.
 *
 * If you find yourself adding I/O, you're in the wrong file.
 */

import BN from 'bn.js';

/** Tolerated bounds for Pyth-style oracle exponents. */
const MIN_EXPONENT = -18;
const MAX_EXPONENT = 0;

/**
 * Convert an on-chain `OraclePrice` shape (`{ price: BN, exponent }`) into
 * a JS number. Returns 0 for any value that's NaN, Infinity, beyond
 * safe-int range, or has an exponent outside the realistic envelope.
 *
 * The caller is responsible for caching & re-fetching — this is just the
 * decoder. Used by both the trading client and the orders-listing path.
 */
export function priceToNumber(p: { price: BN; exponent: number } | undefined | null): number {
  if (!p || !p.price) return 0;
  let raw: number;
  try {
    raw = Number(p.price.toString());
  } catch {
    return 0;
  }
  if (!Number.isFinite(raw)) return 0;
  if (raw > Number.MAX_SAFE_INTEGER || raw < -Number.MAX_SAFE_INTEGER) return 0;
  if (!Number.isFinite(p.exponent) || p.exponent > MAX_EXPONENT || p.exponent < MIN_EXPONENT) return 0;
  const out = raw * Math.pow(10, p.exponent);
  return Number.isFinite(out) ? out : 0;
}

/**
 * Linear liquidation-price estimate. Used both by the synthesized quote
 * fast-path (`open` without an SDK simulate) and by the reverse-position
 * fallback (when chain-truth lookup fails).
 *
 * Long  →  liq = entry × (1 - haircut / leverage)
 * Short →  liq = entry × (1 + haircut / leverage)
 *
 * `haircut` ∈ [0, 1] models the maintenance margin (program reserves a
 * sliver of the move for fees + funding). Default 0.95 matches the Magic
 * Trade program's observed behaviour.
 *
 * Invariants (verified by property tests):
 *   - Long  liq < entry  for any leverage > 0 and haircut > 0
 *   - Short liq > entry  for any leverage > 0 and haircut > 0
 *   - |liq − entry| / entry === haircut / leverage (exact, no slippage)
 *   - Output is finite for any finite, positive entry and leverage
 *   - Returns 0 for invalid inputs (zero / negative / NaN / Infinity)
 */
export function liquidationPriceEstimate(
  entryPrice: number,
  leverage: number,
  side: 'long' | 'short',
  haircut = 0.95,
): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return 0;
  if (!Number.isFinite(leverage) || leverage <= 0) return 0;
  if (!Number.isFinite(haircut) || haircut < 0 || haircut > 1) return 0;
  const factor = haircut / leverage;
  const liq = side === 'long'
    ? entryPrice * (1 - factor)
    : entryPrice * (1 + factor);
  return Number.isFinite(liq) && liq > 0 ? liq : 0;
}

/**
 * Unrealized PnL for a perp position, in USD.
 *
 * Long  →  pnl = sizeUsd × (mark / entry − 1)
 * Short →  pnl = sizeUsd × (1 − mark / entry)
 *
 * Equivalent to `(mark − entry) × tokens` for long since
 * `tokens = sizeUsd / entry`. This formulation keeps everything in USD
 * units and avoids carrying the token-decimal scale through the call.
 *
 * Invariants (verified by property tests):
 *   - Long PnL is monotonically increasing in mark
 *   - Short PnL is monotonically decreasing in mark
 *   - PnL = 0 when mark === entry
 *   - long(entry, mark) === −short(entry, mark)  (zero-sum at fixed size)
 *   - Returns 0 for invalid inputs
 */
export function pnlUsd(
  entryPrice: number,
  markPrice: number,
  sizeUsd: number,
  side: 'long' | 'short',
): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return 0;
  if (!Number.isFinite(markPrice) || markPrice <= 0) return 0;
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) return 0;
  const ratio = markPrice / entryPrice;
  const pnl = side === 'long'
    ? sizeUsd * (ratio - 1)
    : sizeUsd * (1 - ratio);
  return Number.isFinite(pnl) ? pnl : 0;
}

/**
 * Effective leverage = sizeUsd / collateralUsd. Returns 0 when
 * collateral is zero or non-finite (avoids `Infinity` poisoning the UI).
 */
export function effectiveLeverage(sizeUsd: number, collateralUsd: number): number {
  if (!Number.isFinite(sizeUsd) || sizeUsd < 0) return 0;
  if (!Number.isFinite(collateralUsd) || collateralUsd <= 0) return 0;
  const lev = sizeUsd / collateralUsd;
  return Number.isFinite(lev) ? lev : 0;
}

/**
 * Open-fee estimate at `bps` basis points of size. The synthesized quote
 * fast-path uses ~4 bp by default, matching the program's observed entry
 * fee. Marked as estimate by the caller (see `OpenPositionResult.feeIsEstimate`).
 */
export function feeUsdEstimate(sizeUsd: number, bps = 4): number {
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) return 0;
  if (!Number.isFinite(bps) || bps < 0) return 0;
  const fee = sizeUsd * (bps / 10_000);
  return Number.isFinite(fee) ? fee : 0;
}

/**
 * Liquidation-distance ratio — how close the mark is to the liq, on a
 * 0..1 scale. 1 = at entry, 0 = at liq, < 0 = past liq (already toast).
 *
 * Used by the risk-monitor to bucket positions into SAFE / WARNING /
 * CRITICAL with the hysteresis thresholds defined elsewhere.
 *
 *   distance = (mark − liq) / (entry − liq)   for long
 *   distance = (liq − mark) / (liq − entry)   for short
 *
 * Returns 0 when `entry === liq` (degenerate input) so the consumer
 * doesn't divide by zero.
 */
export function liquidationDistance(
  entryPrice: number,
  markPrice: number,
  liqPrice: number,
  side: 'long' | 'short',
): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return 0;
  if (!Number.isFinite(markPrice) || markPrice <= 0) return 0;
  if (!Number.isFinite(liqPrice) || liqPrice <= 0) return 0;
  if (entryPrice === liqPrice) return 0;
  const numerator = side === 'long' ? markPrice - liqPrice : liqPrice - markPrice;
  const denominator = side === 'long' ? entryPrice - liqPrice : liqPrice - entryPrice;
  if (!Number.isFinite(denominator) || denominator === 0) return 0;
  const ratio = numerator / denominator;
  return Number.isFinite(ratio) ? ratio : 0;
}
