/**
 * Property-based tests for `client/math.ts`.
 *
 * Goal: assert the *invariants* the rest of the codebase relies on, not
 * specific numbers. Specific numbers are unit tests; invariants catch the
 * sign-flip / off-by-one / NaN-propagation bugs that example-based tests
 * miss because they only ever exercise the cases the author imagined.
 *
 * Every property runs ~100 random inputs by default (vitest+fast-check
 * defaults). The arbitraries are bounded to realistic crypto / FX ranges
 * so we don't burn cycles testing impossible price regimes.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import BN from 'bn.js';
import {
  priceToNumber,
  liquidationPriceEstimate,
  pnlUsd,
  effectiveLeverage,
  feeUsdEstimate,
  liquidationDistance,
} from '../../src/client/math.js';

// ─── Arbitraries ──────────────────────────────────────────────────────────

/** Realistic asset price: $0.0001 to $1M. Covers shitcoins → BTC → indices. */
const realisticPrice = () => fc.double({
  min: 0.0001,
  max: 1_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Realistic perp leverage: 1× to 100×. */
const realisticLeverage = () => fc.double({
  min: 1,
  max: 100,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Realistic position size in USD: $1 to $10M. */
const realisticSize = () => fc.double({
  min: 1,
  max: 10_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Pyth-style exponent: -18 to 0. */
const pythExponent = () => fc.integer({ min: -18, max: 0 });

/** Side picker. */
const side = () => fc.constantFrom<'long' | 'short'>('long', 'short');

// ─── priceToNumber ────────────────────────────────────────────────────────

describe('priceToNumber', () => {
  it('returns a finite number for any finite (price, exponent) within bounds', () => {
    // Use maxSafeInteger directly — fc.integer maxes out lower than that.
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 2 ** 30 }),
      pythExponent(),
      (raw, exponent) => {
        const result = priceToNumber({ price: new BN(raw), exponent });
        expect(Number.isFinite(result)).toBe(true);
      },
    ));
  });

  it('returns 0 for an out-of-range exponent', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 1_000_000 }),
      fc.integer({ min: 1, max: 100 }),
      (raw, badExp) => {
        // Positive exponents are rejected.
        expect(priceToNumber({ price: new BN(raw), exponent: badExp })).toBe(0);
        // Far-negative exponents (< -18) are rejected.
        expect(priceToNumber({ price: new BN(raw), exponent: -19 - badExp })).toBe(0);
      },
    ));
  });

  it('round-trips with usdToOracle-style scaling within encoding resolution', () => {
    fc.assert(fc.property(
      realisticPrice(),
      pythExponent(),
      (usdPrice, exponent) => {
        // The encoder's resolution is 10^exponent USD per BN unit. A
        // round-trip can lose AT MOST half that on each direction (Math.round
        // bounds), so the round-trip error is bounded by 10^exponent.
        const step = Math.pow(10, exponent);
        // Skip cases where the price is below the encoding resolution —
        // the BN would round to 0 and the round-trip is a degenerate
        // "0 vs price" comparison that no codec could win.
        if (usdPrice < step) return;
        const scaled = Math.round(usdPrice * Math.pow(10, -exponent));
        if (scaled > Number.MAX_SAFE_INTEGER) return;
        const decoded = priceToNumber({ price: new BN(scaled), exponent });
        // Tolerance: one encoding step + a small relative term for float drift.
        const tol = step + Math.abs(usdPrice) * 1e-9;
        expect(Math.abs(decoded - usdPrice)).toBeLessThan(tol);
      },
    ));
  });

  it('handles undefined / null / missing-price defensively', () => {
    expect(priceToNumber(undefined)).toBe(0);
    expect(priceToNumber(null)).toBe(0);
    expect(priceToNumber({} as never)).toBe(0);
  });
});

// ─── liquidationPriceEstimate ─────────────────────────────────────────────

describe('liquidationPriceEstimate', () => {
  it('long liq is BELOW entry for any positive leverage and haircut', () => {
    fc.assert(fc.property(
      realisticPrice(),
      realisticLeverage(),
      fc.double({ min: 0.01, max: 0.999, noNaN: true, noDefaultInfinity: true }),
      (entry, lev, haircut) => {
        const liq = liquidationPriceEstimate(entry, lev, 'long', haircut);
        expect(liq).toBeGreaterThan(0);
        expect(liq).toBeLessThan(entry);
      },
    ));
  });

  it('short liq is ABOVE entry for any positive leverage and haircut', () => {
    fc.assert(fc.property(
      realisticPrice(),
      realisticLeverage(),
      fc.double({ min: 0.01, max: 0.999, noNaN: true, noDefaultInfinity: true }),
      (entry, lev, haircut) => {
        const liq = liquidationPriceEstimate(entry, lev, 'short', haircut);
        expect(liq).toBeGreaterThan(entry);
      },
    ));
  });

  it('liq distance equals (haircut / leverage) exactly', () => {
    fc.assert(fc.property(
      realisticPrice(),
      realisticLeverage(),
      fc.double({ min: 0.01, max: 0.999, noNaN: true, noDefaultInfinity: true }),
      side(),
      (entry, lev, haircut, s) => {
        const liq = liquidationPriceEstimate(entry, lev, s, haircut);
        const expectedRatio = haircut / lev;
        const actualRatio = Math.abs(liq - entry) / entry;
        // Float tolerance — the formula is exact algebraically but
        // multiplication introduces rounding.
        expect(Math.abs(actualRatio - expectedRatio)).toBeLessThan(1e-9);
      },
    ));
  });

  it('higher leverage → tighter liq (closer to entry)', () => {
    fc.assert(fc.property(
      realisticPrice(),
      fc.double({ min: 1, max: 50, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 50.0001, max: 100, noNaN: true, noDefaultInfinity: true }),
      side(),
      (entry, lowLev, highLev, s) => {
        const lowLiq = liquidationPriceEstimate(entry, lowLev, s);
        const highLiq = liquidationPriceEstimate(entry, highLev, s);
        const lowDist = Math.abs(entry - lowLiq);
        const highDist = Math.abs(entry - highLiq);
        // High-lev liq must be CLOSER to entry than low-lev liq.
        expect(highDist).toBeLessThan(lowDist);
      },
    ));
  });

  it('returns 0 for invalid inputs', () => {
    expect(liquidationPriceEstimate(0, 5, 'long')).toBe(0);
    expect(liquidationPriceEstimate(100, 0, 'long')).toBe(0);
    expect(liquidationPriceEstimate(100, -5, 'long')).toBe(0);
    expect(liquidationPriceEstimate(NaN, 5, 'long')).toBe(0);
    expect(liquidationPriceEstimate(100, NaN, 'long')).toBe(0);
    expect(liquidationPriceEstimate(Infinity, 5, 'long')).toBe(0);
    expect(liquidationPriceEstimate(100, 5, 'long', 1.5)).toBe(0); // haircut > 1
    expect(liquidationPriceEstimate(100, 5, 'long', -0.1)).toBe(0); // haircut < 0
  });
});

// ─── pnlUsd ───────────────────────────────────────────────────────────────

describe('pnlUsd', () => {
  it('PnL is zero when mark === entry, regardless of side', () => {
    fc.assert(fc.property(
      realisticPrice(),
      realisticSize(),
      side(),
      (price, size, s) => {
        expect(pnlUsd(price, price, size, s)).toBe(0);
      },
    ));
  });

  it('long PnL is monotonically increasing in mark', () => {
    fc.assert(fc.property(
      realisticPrice(),
      realisticPrice(),
      realisticPrice(),
      realisticSize(),
      (entry, m1, m2, size) => {
        if (m1 === m2) return;
        const lo = Math.min(m1, m2);
        const hi = Math.max(m1, m2);
        const pnlLo = pnlUsd(entry, lo, size, 'long');
        const pnlHi = pnlUsd(entry, hi, size, 'long');
        expect(pnlHi).toBeGreaterThanOrEqual(pnlLo);
      },
    ));
  });

  it('short PnL is monotonically decreasing in mark', () => {
    fc.assert(fc.property(
      realisticPrice(),
      realisticPrice(),
      realisticPrice(),
      realisticSize(),
      (entry, m1, m2, size) => {
        if (m1 === m2) return;
        const lo = Math.min(m1, m2);
        const hi = Math.max(m1, m2);
        const pnlLo = pnlUsd(entry, lo, size, 'short');
        const pnlHi = pnlUsd(entry, hi, size, 'short');
        expect(pnlHi).toBeLessThanOrEqual(pnlLo);
      },
    ));
  });

  it('long(p) === −short(p) at fixed size (zero-sum)', () => {
    fc.assert(fc.property(
      realisticPrice(),
      realisticPrice(),
      realisticSize(),
      (entry, mark, size) => {
        const longPnl = pnlUsd(entry, mark, size, 'long');
        const shortPnl = pnlUsd(entry, mark, size, 'short');
        // Float tolerance — both formulas re-arrange the same multiplication.
        expect(Math.abs(longPnl + shortPnl)).toBeLessThan(Math.max(Math.abs(longPnl) * 1e-9, 1e-9));
      },
    ));
  });

  it('PnL is bounded by ±sizeUsd × max-move (sanity)', () => {
    fc.assert(fc.property(
      realisticPrice(),
      realisticPrice(),
      realisticSize(),
      side(),
      (entry, mark, size, s) => {
        const pnl = pnlUsd(entry, mark, size, s);
        // For a long, PnL <= size * (mark/entry - 1); both finite — abs < size * (max_ratio).
        const maxAbs = size * (Math.max(mark / entry, entry / mark));
        expect(Math.abs(pnl)).toBeLessThanOrEqual(maxAbs + 1e-6);
      },
    ));
  });

  it('returns 0 for invalid inputs', () => {
    expect(pnlUsd(0, 100, 1000, 'long')).toBe(0);
    expect(pnlUsd(100, 0, 1000, 'long')).toBe(0);
    expect(pnlUsd(100, 100, 0, 'long')).toBe(0);
    expect(pnlUsd(NaN, 100, 1000, 'long')).toBe(0);
    expect(pnlUsd(100, NaN, 1000, 'long')).toBe(0);
    expect(pnlUsd(Infinity, 100, 1000, 'long')).toBe(0);
  });
});

// ─── effectiveLeverage ────────────────────────────────────────────────────

describe('effectiveLeverage', () => {
  it('returns sizeUsd / collateralUsd when both finite-positive', () => {
    fc.assert(fc.property(
      realisticSize(),
      realisticSize(),
      (size, collateral) => {
        const lev = effectiveLeverage(size, collateral);
        expect(Number.isFinite(lev)).toBe(true);
        expect(Math.abs(lev - size / collateral)).toBeLessThan(1e-9);
      },
    ));
  });

  it('returns 0 when collateral is zero / negative / NaN / Infinity', () => {
    expect(effectiveLeverage(1000, 0)).toBe(0);
    expect(effectiveLeverage(1000, -10)).toBe(0);
    expect(effectiveLeverage(1000, NaN)).toBe(0);
    expect(effectiveLeverage(1000, Infinity)).toBe(0);
    // Critical: never propagates Infinity into UI.
    expect(Number.isFinite(effectiveLeverage(1000, 0))).toBe(true);
  });
});

// ─── feeUsdEstimate ───────────────────────────────────────────────────────

describe('feeUsdEstimate', () => {
  it('fee is always non-negative', () => {
    fc.assert(fc.property(
      realisticSize(),
      fc.integer({ min: 0, max: 10_000 }),
      (size, bps) => {
        expect(feeUsdEstimate(size, bps)).toBeGreaterThanOrEqual(0);
      },
    ));
  });

  it('fee is bounded by sizeUsd (a fee can never exceed its own notional)', () => {
    fc.assert(fc.property(
      realisticSize(),
      fc.integer({ min: 0, max: 9_999 }),
      (size, bps) => {
        // bps < 10_000 means rate < 100%, so fee < size by definition.
        expect(feeUsdEstimate(size, bps)).toBeLessThan(size);
      },
    ));
  });

  it('fee scales linearly with sizeUsd', () => {
    fc.assert(fc.property(
      realisticSize(),
      fc.integer({ min: 1, max: 100 }),
      fc.integer({ min: 2, max: 100 }),
      (size, bps, k) => {
        const f1 = feeUsdEstimate(size, bps);
        const fk = feeUsdEstimate(size * k, bps);
        // fk should be ~k * f1 within float tolerance.
        expect(Math.abs(fk - k * f1)).toBeLessThan(Math.max(f1 * 1e-9, 1e-9));
      },
    ));
  });

  it('returns 0 for invalid inputs', () => {
    expect(feeUsdEstimate(0, 4)).toBe(0);
    expect(feeUsdEstimate(-100, 4)).toBe(0);
    expect(feeUsdEstimate(NaN, 4)).toBe(0);
    expect(feeUsdEstimate(1000, NaN)).toBe(0);
    expect(feeUsdEstimate(1000, -1)).toBe(0);
  });
});

// ─── liquidationDistance ──────────────────────────────────────────────────

describe('liquidationDistance', () => {
  it('long: distance is 1 when mark === entry, 0 when mark === liq', () => {
    const entry = 100;
    const liq = 80;
    expect(liquidationDistance(entry, entry, liq, 'long')).toBeCloseTo(1, 9);
    expect(liquidationDistance(entry, liq, liq, 'long')).toBeCloseTo(0, 9);
  });

  it('short: distance is 1 when mark === entry, 0 when mark === liq', () => {
    const entry = 100;
    const liq = 120;
    expect(liquidationDistance(entry, entry, liq, 'short')).toBeCloseTo(1, 9);
    expect(liquidationDistance(entry, liq, liq, 'short')).toBeCloseTo(0, 9);
  });

  it('long: distance decreases monotonically as mark approaches liq from above', () => {
    fc.assert(fc.property(
      fc.double({ min: 100, max: 1000, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 0.5, max: 0.95, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 0.96, max: 0.99, noNaN: true, noDefaultInfinity: true }),
      (entry, liqRatio, markRatio) => {
        const liq = entry * liqRatio;
        const markFar = entry; // at entry — distance should be 1
        const markNear = entry * markRatio; // closer to liq
        const farDist = liquidationDistance(entry, markFar, liq, 'long');
        const nearDist = liquidationDistance(entry, markNear, liq, 'long');
        expect(farDist).toBeGreaterThan(nearDist);
      },
    ));
  });

  it('returns 0 (not Infinity / NaN) when entry === liq', () => {
    expect(liquidationDistance(100, 105, 100, 'long')).toBe(0);
    expect(liquidationDistance(100, 95, 100, 'short')).toBe(0);
  });

  it('returns 0 for invalid inputs', () => {
    expect(liquidationDistance(0, 100, 80, 'long')).toBe(0);
    expect(liquidationDistance(100, 0, 80, 'long')).toBe(0);
    expect(liquidationDistance(100, 90, 0, 'long')).toBe(0);
    expect(liquidationDistance(NaN, 100, 80, 'long')).toBe(0);
  });
});
