/**
 * Unit tests for `matchFingerprints` — the race-safety pillar of the
 * background trigger-cancellation flow.
 *
 * Behaviour we MUST preserve:
 *   1. Trigger captured pre-close, still alive with same size+price → match.
 *   2. Trigger captured pre-close, replaced by a NEW open in the same
 *      orderId slot with different size/price → DO NOT match (the
 *      whole point of this function).
 *   3. Trigger captured pre-close, slot now empty (size=0) → DO NOT match.
 *   4. Basket with no orders / null → empty result, no throw.
 */

import { describe, it, expect } from 'vitest';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import {
  matchFingerprints,
  type TriggerFingerprint,
  type BasketShape,
} from '../src/client/magic-client.js';

// PublicKey requires 32 bytes — use deterministic test keypairs.
const MARKET_A = new PublicKey(new Uint8Array(32).fill(1));
const MARKET_B = new PublicKey(new Uint8Array(32).fill(2));

function fp(args: Partial<TriggerFingerprint> & { market?: PublicKey }): TriggerFingerprint {
  return {
    market: args.market ?? MARKET_A,
    orderId: args.orderId ?? 0,
    isStopLoss: args.isStopLoss ?? false,
    triggerSizeRaw: args.triggerSizeRaw ?? '1000000',
    triggerPriceRaw: args.triggerPriceRaw ?? '50000000000',
    triggerPriceExponent: args.triggerPriceExponent ?? -8,
  };
}

function basket(orders: BasketShape['orders']): BasketShape {
  return { orders };
}

describe('matchFingerprints', () => {
  it('matches when trigger is still alive with identical size + price', () => {
    const captured = [fp({ orderId: 0, isStopLoss: false })];
    const live = basket([
      {
        market: MARKET_A,
        order: {
          takeProfitOrders: [
            { triggerSize: new BN('1000000'), triggerPrice: { price: new BN('50000000000'), exponent: -8 } },
          ],
        },
      },
    ]);
    expect(matchFingerprints(live, captured)).toEqual(captured);
  });

  it('skips when slot has been re-occupied with DIFFERENT size (race window)', () => {
    const captured = [fp({ orderId: 0, isStopLoss: false, triggerSizeRaw: '1000000' })];
    const live = basket([
      {
        market: MARKET_A,
        order: {
          takeProfitOrders: [
            // Same orderId, same price, DIFFERENT size — this is a
            // brand-new TP placed by a follow-up open. Do not cancel.
            { triggerSize: new BN('5000000'), triggerPrice: { price: new BN('50000000000'), exponent: -8 } },
          ],
        },
      },
    ]);
    expect(matchFingerprints(live, captured)).toEqual([]);
  });

  it('skips when slot has been re-occupied with DIFFERENT price', () => {
    const captured = [fp({ orderId: 0, isStopLoss: false, triggerPriceRaw: '50000000000' })];
    const live = basket([
      {
        market: MARKET_A,
        order: {
          takeProfitOrders: [
            { triggerSize: new BN('1000000'), triggerPrice: { price: new BN('99999999999'), exponent: -8 } },
          ],
        },
      },
    ]);
    expect(matchFingerprints(live, captured)).toEqual([]);
  });

  it('skips when slot is now empty (size=0)', () => {
    const captured = [fp({ orderId: 0, isStopLoss: false })];
    const live = basket([
      {
        market: MARKET_A,
        order: {
          takeProfitOrders: [
            { triggerSize: new BN(0), triggerPrice: { price: new BN('50000000000'), exponent: -8 } },
          ],
        },
      },
    ]);
    expect(matchFingerprints(live, captured)).toEqual([]);
  });

  it('does not look in the wrong array (TP vs SL distinction)', () => {
    // Captured a TP at orderId 0; basket has an SL at orderId 0 with
    // the same numbers. Different array → no match.
    const captured = [fp({ orderId: 0, isStopLoss: false })];
    const live = basket([
      {
        market: MARKET_A,
        order: {
          stopLossOrders: [
            { triggerSize: new BN('1000000'), triggerPrice: { price: new BN('50000000000'), exponent: -8 } },
          ],
          takeProfitOrders: [],
        },
      },
    ]);
    expect(matchFingerprints(live, captured)).toEqual([]);
  });

  it('isolates by market — a match on market B does not match a fingerprint on market A', () => {
    const captured = [fp({ market: MARKET_A, orderId: 0 })];
    const live = basket([
      {
        market: MARKET_B,
        order: {
          takeProfitOrders: [
            { triggerSize: new BN('1000000'), triggerPrice: { price: new BN('50000000000'), exponent: -8 } },
          ],
        },
      },
    ]);
    expect(matchFingerprints(live, captured)).toEqual([]);
  });

  it('returns empty on null basket without throwing', () => {
    expect(matchFingerprints(null, [fp({})])).toEqual([]);
  });

  it('returns empty on basket with no orders array', () => {
    expect(matchFingerprints({}, [fp({})])).toEqual([]);
  });

  it('matches multiple distinct fingerprints in one basket', () => {
    const captured = [
      fp({ market: MARKET_A, orderId: 0, isStopLoss: false }),
      fp({ market: MARKET_A, orderId: 1, isStopLoss: true, triggerSizeRaw: '2000000', triggerPriceRaw: '40000000000' }),
    ];
    const live = basket([
      {
        market: MARKET_A,
        order: {
          takeProfitOrders: [
            { triggerSize: new BN('1000000'), triggerPrice: { price: new BN('50000000000'), exponent: -8 } },
          ],
          stopLossOrders: [
            // orderId 0: empty
            { triggerSize: new BN(0) },
            // orderId 1: matches
            { triggerSize: new BN('2000000'), triggerPrice: { price: new BN('40000000000'), exponent: -8 } },
          ],
        },
      },
    ]);
    const result = matchFingerprints(live, captured);
    expect(result).toHaveLength(2);
    expect(result[0].orderId).toBe(0);
    expect(result[1].orderId).toBe(1);
  });
});
