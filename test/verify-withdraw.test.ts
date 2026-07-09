/**
 * Unit tests for `client/verify-withdraw.ts:verifyWithdrawLanded`.
 *
 * As of 0.4.0 the ATA-increase signal is REQUIRED — basket-drop alone
 * is no longer sufficient. The basket signal is read for defence-in-
 * depth and may VETO an ATA gain that wasn't backed by a basket drop
 * of similar magnitude (independent deposit, not our withdraw).
 *
 * Why the change: a half-landed withdraw (`request` ok, `settle`
 * stalled) drops the basket but leaves the wallet untouched. Counting
 * basket-drop as success would green-light a withdraw that left the
 * user with neither the basket balance nor the tokens.
 */

import { describe, it, expect } from 'vitest';
import { verifyWithdrawLanded, type VerifyWithdrawSnapshot } from '../src/client/verify-withdraw.js';

const baseSnap: VerifyWithdrawSnapshot = {
  ataPre: 100,
  basketPre: 50,
  tokenSymbol: 'USDC',
  amountTokens: 10,
};

describe('verifyWithdrawLanded', () => {
  it('returns true when ATA gained ≥ 85% of amount AND basket dropped', async () => {
    const ok = await verifyWithdrawLanded(baseSnap, {
      readAta: async () => 110,        // +10 (full)
      readBasket: async () => 41,      // -9 (corroborates)
    });
    expect(ok).toBe(true);
  });

  it('returns true when ATA gained exactly 85% boundary AND basket corroborates', async () => {
    const ok = await verifyWithdrawLanded(baseSnap, {
      readAta: async () => 100 + 8.5,  // +8.5 = 0.85 × 10
      readBasket: async () => 41,      // -9 (corroborates)
    });
    expect(ok).toBe(true);
  });

  it('returns false when basket dropped but ATA did not gain (half-landed withdraw)', async () => {
    const ok = await verifyWithdrawLanded(baseSnap, {
      readAta: async () => 100,        // unchanged — request landed, settle stalled
      readBasket: async () => 41,      // -9
    });
    expect(ok).toBe(false);
  });

  it('returns false when neither signal moved', async () => {
    const ok = await verifyWithdrawLanded(baseSnap, {
      readAta: async () => 100.5,      // +0.5 (under threshold)
      readBasket: async () => 49.5,    // -0.5
    });
    expect(ok).toBe(false);
  });

  it('returns false when ATA read throws (cannot prove the wallet got tokens)', async () => {
    const ok = await verifyWithdrawLanded(baseSnap, {
      readAta: async () => { throw new Error('rpc down'); },
      readBasket: async () => 41,
    });
    expect(ok).toBe(false);
  });

  it('returns false when both ATA AND basket throw', async () => {
    const ok = await verifyWithdrawLanded(baseSnap, {
      readAta: async () => { throw new Error('rpc down'); },
      readBasket: async () => { throw new Error('rpc down'); },
    });
    expect(ok).toBe(false);
  });

  it('returns true on ATA gain even if tokenSymbol is null (basket signal disabled)', async () => {
    const ok = await verifyWithdrawLanded(
      { ...baseSnap, tokenSymbol: null, basketPre: null },
      {
        readAta: async () => 110,        // +10
        readBasket: async () => 0,
      },
    );
    expect(ok).toBe(true);
  });

  it('returns false when ATA pre-balance is unknown', async () => {
    const ok = await verifyWithdrawLanded(
      { ...baseSnap, ataPre: null },
      {
        readAta: async () => 110,
        readBasket: async () => 41,
      },
    );
    // Cannot compute ATA delta → cannot prove ATA gained → false.
    expect(ok).toBe(false);
  });

  it('returns false when ATA returns null (no ATA exists yet)', async () => {
    const ok = await verifyWithdrawLanded(baseSnap, {
      readAta: async () => null,
      readBasket: async () => 41,
    });
    expect(ok).toBe(false);
  });

  it('vetoes a suspicious ATA gain when basket did not drop at all', async () => {
    // ATA gained but basket unchanged → the ATA gain came from
    // somewhere else (independent deposit), not from our withdraw.
    const ok = await verifyWithdrawLanded(baseSnap, {
      readAta: async () => 110,        // +10
      readBasket: async () => 50,      // unchanged
    });
    expect(ok).toBe(false);
  });

  it('accepts ATA gain when basket signal is unavailable (RPC blip)', async () => {
    const ok = await verifyWithdrawLanded(baseSnap, {
      readAta: async () => 110,
      readBasket: async () => { throw new Error('basket rpc down'); },
    });
    expect(ok).toBe(true);
  });
});
