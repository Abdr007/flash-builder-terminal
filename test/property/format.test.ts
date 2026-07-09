/**
 * Property-based tests for `utils/format.ts`.
 *
 * These formatters render trade cards, dashboards, and the monitor TUI.
 * A NaN / Infinity / undefined leak in any of them produces "$NaN" or
 * "$Infinity" strings that look like real prices to the user — which
 * is the kind of bug that costs money. The properties below assert
 * each formatter:
 *   1. ALWAYS returns a finite, printable string
 *   2. NEVER renders 'NaN', 'Infinity', or 'undefined'
 *   3. Sign characters are correct for the value's actual sign
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  formatUsd,
  formatUsdExact,
  formatPrice,
  formatPercent,
  formatLatency,
  formatDuration,
  sumDecimal,
} from '../../src/utils/format.js';

const NEVER_RENDER = /(NaN|Infinity|undefined|null)/;

describe('formatUsd', () => {
  it('never emits NaN / Infinity / undefined for any number', () => {
    fc.assert(fc.property(fc.double({ noNaN: true }), (v) => {
      const s = formatUsd(v);
      expect(s).not.toMatch(NEVER_RENDER);
    }));
  });

  it('returns "N/A" for NaN / Infinity / undefined', () => {
    expect(formatUsd(NaN)).toBe('N/A');
    expect(formatUsd(Infinity)).toBe('N/A');
    expect(formatUsd(-Infinity)).toBe('N/A');
  });

  it('correct sign character for any non-trivial magnitude', () => {
    fc.assert(fc.property(
      fc.double({ min: 0.01, max: 1e12, noNaN: true, noDefaultInfinity: true }),
      (v) => {
        expect(formatUsd(v).startsWith('$')).toBe(true);
        expect(formatUsd(-v).startsWith('-$')).toBe(true);
      },
    ));
  });

  it('clamps near-zero values to $0.00', () => {
    expect(formatUsd(0.001)).toBe('$0.00');
    expect(formatUsd(-0.001)).toBe('$0.00');
  });
});

describe('formatUsdExact', () => {
  it('never emits NaN / Infinity / undefined', () => {
    fc.assert(fc.property(fc.double({ noNaN: true }), (v) => {
      const s = formatUsdExact(v);
      expect(s).not.toMatch(NEVER_RENDER);
    }));
  });

  it('always has exactly two decimals for finite inputs', () => {
    fc.assert(fc.property(
      fc.double({ min: 0.01, max: 1e9, noNaN: true, noDefaultInfinity: true }),
      (v) => {
        const s = formatUsdExact(v);
        expect(s).toMatch(/\.\d{2}$/);
      },
    ));
  });
});

describe('formatPrice', () => {
  it('never emits NaN / Infinity / undefined', () => {
    fc.assert(fc.property(fc.double({ noNaN: true }), (v) => {
      const s = formatPrice(v);
      expect(s).not.toMatch(NEVER_RENDER);
    }));
  });

  it('sub-bp precision: shows ≥4 decimals for $1–$1000', () => {
    fc.assert(fc.property(
      fc.double({ min: 1.01, max: 999.99, noNaN: true, noDefaultInfinity: true }),
      (v) => {
        const s = formatPrice(v);
        // Either matches at least 4 decimals OR is exponent notation
        // (latter only kicks in below 0.0001, which we excluded).
        expect(s).toMatch(/\.\d{4,}/);
      },
    ));
  });
});

describe('formatPercent', () => {
  it('never emits NaN / Infinity / undefined', () => {
    fc.assert(fc.property(fc.double({ noNaN: true }), (v) => {
      const s = formatPercent(v);
      expect(s).not.toMatch(NEVER_RENDER);
    }));
  });

  it('shows + prefix for positive, - for negative, + for zero', () => {
    expect(formatPercent(1.5)).toMatch(/^\+/);
    expect(formatPercent(-1.5)).toMatch(/^-/);
    expect(formatPercent(0)).toMatch(/^\+/);
  });
});

describe('formatLatency', () => {
  it('never emits NaN / Infinity / undefined', () => {
    fc.assert(fc.property(fc.double({ noNaN: true }), (v) => {
      const s = formatLatency(v);
      expect(s).not.toMatch(NEVER_RENDER);
    }));
  });

  it('always renders as decimal seconds (uniform with latencyPill)', () => {
    expect(formatLatency(0.5)).toMatch(/s$/);
    expect(formatLatency(500)).toMatch(/^0\.50s$/);
    expect(formatLatency(1500)).toMatch(/^1\.50s$/);
    expect(formatLatency(60)).toMatch(/^0\.06s$/);
  });
});

describe('formatDuration', () => {
  it('never emits NaN / Infinity / undefined', () => {
    fc.assert(fc.property(fc.double({ noNaN: true }), (v) => {
      const s = formatDuration(v);
      expect(s).not.toMatch(NEVER_RENDER);
    }));
  });
});

describe('sumDecimal', () => {
  it('returns a finite number for any sane-range array (incl. NaN/Inf entries)', () => {
    // Bound the magnitudes — real PnL / balance / fee aggregates are never
    // anywhere near Number.MAX_VALUE, and sums that overflow legitimately
    // return Infinity. The assertion we care about is "no silent NaN
    // poisoning when SOME entries are bad" — those are dropped by the
    // filter inside sumDecimal.
    fc.assert(fc.property(
      fc.array(
        fc.oneof(
          fc.double({ min: -1e9, max: 1e9, noNaN: true, noDefaultInfinity: true }),
          fc.constant(NaN),
          fc.constant(Infinity),
          fc.constant(-Infinity),
        ),
        { maxLength: 200 },
      ),
      (xs) => {
        const result = sumDecimal(xs);
        expect(Number.isFinite(result)).toBe(true);
      },
    ));
  });

  it('matches naive sum within float epsilon for all-finite arrays', () => {
    fc.assert(fc.property(
      fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }), { maxLength: 200 }),
      (xs) => {
        const ours = sumDecimal(xs);
        const naive = xs.reduce((a, b) => a + b, 0);
        const tol = Math.max(Math.abs(naive) * 1e-9, 1e-9);
        expect(Math.abs(ours - naive)).toBeLessThan(tol);
      },
    ));
  });

  it('drops NaN / Infinity entries silently', () => {
    expect(sumDecimal([1, NaN, 2, Infinity, 3])).toBe(6);
  });
});
