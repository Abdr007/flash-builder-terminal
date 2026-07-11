/**
 * Advanced NL parsing: magnitude shorthand (k/m/b), leverage phrasings, fillers.
 * Includes ADVERSARIAL safety cases — a trading parser must never turn a
 * positional "5" into 5000, nor invert "$5 at 50x". These lock that in.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { interpretCommand, configureSymbols } from '../src/cli/interpreter.js';

beforeAll(() => configureSymbols(new Set(['SOL', 'BTC', 'ETH']), new Map()));

type OpenParams = { collateral?: number; leverage?: number; market?: string; side?: string; tp?: number; sl?: number };
const open = (line: string): OpenParams => {
  const r = interpretCommand(line);
  expect(r?.alias, `"${line}" should parse as open`).toBe('open');
  return r!.params as OpenParams;
};

describe('advanced parsing — magnitude shorthand (k/m/b)', () => {
  it('expands collateral suffixes', () => {
    expect(open('long SOL $5k 10x').collateral).toBe(5000);
    expect(open('long SOL 5k 2x').collateral).toBe(5000);
    expect(open('long SOL $1.5m 3x').collateral).toBe(1_500_000);
    expect(open('short BTC 60k 5x')).toMatchObject({ collateral: 60_000, leverage: 5, side: 'short' });
  });
  it('expands tp/sl magnitude on the open', () => {
    expect(open('long SOL $100 3x tp 250k sl 200k')).toMatchObject({ tp: 250_000, sl: 200_000 });
  });
});

describe('advanced parsing — leverage phrasings & fillers', () => {
  it('accepts "5 times" / "5 leverage" / "leverage 5"', () => {
    expect(open('long SOL 100 5 times').leverage).toBe(5);
    expect(open('long SOL 100 5 leverage').leverage).toBe(5);
    expect(open('long SOL 100 leverage 5').leverage).toBe(5);
  });
  it('strips "worth"', () => {
    expect(open('buy $100 worth of SOL 3x')).toMatchObject({ collateral: 100, leverage: 3, market: 'SOL' });
  });
});

describe('advanced parsing — SAFETY (no misparse)', () => {
  it('does NOT magnitude-expand a bare positional number', () => {
    expect(open('long SOL 5 2x')).toMatchObject({ collateral: 5, leverage: 2 }); // not 5000
  });
  it('preserves the audit case: $5 at 50x (no magnitude-sort, no k-expand)', () => {
    expect(open('long SOL $5 50x')).toMatchObject({ collateral: 5, leverage: 50 });
  });
  it('never treats leverage x as a magnitude', () => {
    expect(open('long SOL $100 5x').leverage).toBe(5); // not 5000
  });
});
