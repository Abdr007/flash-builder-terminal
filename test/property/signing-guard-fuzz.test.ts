/**
 * Property-based fuzzing of the signing guard — the money-path cap gate.
 *
 * The one invariant that MUST hold for user safety: a configured positive cap
 * (collateral / size / leverage) can NEVER be bypassed, for any input, and the
 * check never throws. Non-finite / negative parameters must always be refused
 * (they'd otherwise slip past a `>` comparison). Unit tests cover examples;
 * this hammers every combination of caps × trade params.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fc from 'fast-check';
import { initSigningGuard, getSigningGuard } from '../../src/security/signing-guard.js';

// Rate limit off so it never masks a trade-limit verdict in this fuzz.
const baseCaps = { maxTradesPerMinute: 0, minDelayBetweenTradesMs: 0 };

const capsArb = fc.record({
  maxCollateralPerTrade: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 1_000_000 })),
  maxPositionSize: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 10_000_000 })),
  maxLeverage: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 100 })),
});

const numArb = fc.oneof(
  fc.double({ min: -1e9, max: 1e9, noNaN: false }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -0, -5, 1e12),
);
const paramsArb = fc.record({ collateral: numArb, leverage: numArb, sizeUsd: numArb, market: fc.constant('SOL') });

describe('signing guard fuzz — caps are un-bypassable', () => {
  beforeEach(() => initSigningGuard({ maxCollateralPerTrade: 0, maxPositionSize: 0, maxLeverage: 0, ...baseCaps }));

  it('checkTradeLimits never throws for any caps × params', () => {
    fc.assert(
      fc.property(capsArb, paramsArb, (caps, p) => {
        initSigningGuard({ ...caps, ...baseCaps });
        expect(() => getSigningGuard().checkTradeLimits(p)).not.toThrow();
      }),
      { numRuns: 8000 },
    );
  });

  it('a positive cap is NEVER bypassed; non-finite/negative always refused', () => {
    fc.assert(
      fc.property(capsArb, paramsArb, (caps, p) => {
        initSigningGuard({ ...caps, ...baseCaps });
        const { allowed } = getSigningGuard().checkTradeLimits(p);

        // Poison inputs must always be refused.
        const poison =
          !Number.isFinite(p.collateral) || !Number.isFinite(p.leverage) || !Number.isFinite(p.sizeUsd) ||
          p.collateral < 0 || p.leverage < 0 || p.sizeUsd < 0;
        if (poison) { expect(allowed).toBe(false); return; }

        // A finite/non-negative trade that exceeds ANY configured positive cap
        // must be refused — the cap can never be silently exceeded.
        const exceeds =
          (caps.maxCollateralPerTrade > 0 && p.collateral > caps.maxCollateralPerTrade) ||
          (caps.maxPositionSize > 0 && p.sizeUsd > caps.maxPositionSize) ||
          (caps.maxLeverage > 0 && p.leverage > caps.maxLeverage);
        if (exceeds) expect(allowed).toBe(false);
      }),
      { numRuns: 12000 },
    );
  });
});
