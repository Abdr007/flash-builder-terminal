/**
 * Unit tests for `client/balances.ts:composeBalanceMap`.
 */

import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { composeBalanceMap } from '../src/client/balances.js';

const MINT_USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const MINT_SOL = new PublicKey('So11111111111111111111111111111111111111112');
const MINT_BTC = new PublicKey('3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh');

const CUSTODIES = [
  { symbol: 'USDC', decimals: 6, mintKey: MINT_USDC },
  { symbol: 'SOL',  decimals: 9, mintKey: MINT_SOL },
  { symbol: 'BTC',  decimals: 8, mintKey: MINT_BTC },
];

describe('composeBalanceMap', () => {
  it('returns an empty map when there are no balances anywhere', () => {
    const m = composeBalanceMap(CUSTODIES, [], [], []);
    expect(m.size).toBe(0);
  });

  it('handles undefined / null inputs without throwing', () => {
    expect(composeBalanceMap(CUSTODIES, null, null, null).size).toBe(0);
    expect(composeBalanceMap(CUSTODIES, undefined, undefined, undefined).size).toBe(0);
  });

  it('decodes deposits at the custody decimals (USDC=6)', () => {
    const m = composeBalanceMap(
      CUSTODIES,
      [{ mint: MINT_USDC, amount: new BN(50_000_000) }], // 50 USDC
      [],
      [],
    );
    const usdc = m.get('USDC');
    expect(usdc).toBeDefined();
    expect(usdc!.deposits).toBeCloseTo(50, 9);
    expect(usdc!.available).toBeCloseTo(50, 9);
    expect(usdc!.decimals).toBe(6);
  });

  it('uses the formula available = deposits − debits + pendingCredits', () => {
    const m = composeBalanceMap(
      CUSTODIES,
      [{ mint: MINT_USDC, amount: new BN(100_000_000) }], // 100 USDC
      [{ mint: MINT_USDC, amount: new BN(40_000_000) }],  //  40 debited
      [{ mint: MINT_USDC, amount: new BN(5_000_000) }],   //   5 pending credit
    );
    const usdc = m.get('USDC');
    expect(usdc!.available).toBeCloseTo(65, 9); // 100 − 40 + 5
    expect(usdc!.deposits).toBeCloseTo(100, 9);
    expect(usdc!.debits).toBeCloseTo(40, 9);
    expect(usdc!.pendingCredits).toBeCloseTo(5, 9);
  });

  it('skips symbols where every component is zero', () => {
    const m = composeBalanceMap(
      CUSTODIES,
      [{ mint: MINT_USDC, amount: new BN(10_000_000) }],
      [],
      [],
    );
    expect(m.has('USDC')).toBe(true);
    expect(m.has('SOL')).toBe(false);
    expect(m.has('BTC')).toBe(false);
  });

  it('decodes SOL at 9 decimals and BTC at 8', () => {
    const m = composeBalanceMap(
      CUSTODIES,
      [
        { mint: MINT_SOL, amount: new BN('500000000') },     // 0.5 SOL (decimals=9)
        { mint: MINT_BTC, amount: new BN(10_000_000) },      // 0.1 BTC (decimals=8)
      ],
      [],
      [],
    );
    expect(m.get('SOL')!.deposits).toBeCloseTo(0.5, 9);
    expect(m.get('BTC')!.deposits).toBeCloseTo(0.1, 9);
  });

  it('available can be negative when debits exceed deposits + pending', () => {
    const m = composeBalanceMap(
      CUSTODIES,
      [{ mint: MINT_USDC, amount: new BN(10_000_000) }],
      [{ mint: MINT_USDC, amount: new BN(50_000_000) }],
      [],
    );
    // The formula doesn't clamp — that's a UI concern, not a math one.
    expect(m.get('USDC')!.available).toBeCloseTo(-40, 9);
  });
});
