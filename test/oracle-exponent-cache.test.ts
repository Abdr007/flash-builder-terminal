/**
 * Unit tests for `client/oracle-exponent-cache.ts:OracleExponentCache`.
 */

import { describe, it, expect } from 'vitest';
import { OracleExponentCache } from '../src/client/oracle-exponent-cache.js';

describe('OracleExponentCache', () => {
  it('returns null on a miss for a fresh instance', () => {
    const c = new OracleExponentCache();
    expect(c.lookup('JUNK')).toBe(null);
  });

  it('round-trips a remembered exponent', () => {
    const c = new OracleExponentCache();
    c.remember('SOL', -8);
    expect(c.lookup('SOL')).toBe(-8);
    expect(c.lookup('sol')).toBe(-8); // case-insensitive
  });

  it('rejects out-of-range exponents (defensive)', () => {
    const c = new OracleExponentCache();
    c.remember('JUNK1', 5);   // positive
    c.remember('JUNK2', -25); // too negative
    c.remember('JUNK3', NaN); // nan
    c.remember('JUNK4', Infinity);
    expect(c.lookup('JUNK1')).toBe(null);
    expect(c.lookup('JUNK2')).toBe(null);
    expect(c.lookup('JUNK3')).toBe(null);
    expect(c.lookup('JUNK4')).toBe(null);
  });

  it('encode uses cached exponent when present', () => {
    const c = new OracleExponentCache();
    c.remember('EUR', -5);
    const r = c.encode('EUR', 1.07);
    expect(r.exponent).toBe(-5);
    expect(r.usedDefault).toBe(false);
    expect(r.price.toString()).toBe(String(Math.round(1.07 * 1e5)));
  });

  it('encode falls back to -8 when cache misses, and flags it', () => {
    const c = new OracleExponentCache();
    const r = c.encode('UNSEEN', 100);
    expect(r.exponent).toBe(-8);
    expect(r.usedDefault).toBe(true);
    expect(r.price.toString()).toBe(String(Math.round(100 * 1e8)));
  });

  it('module-level fallback lets a sibling read another instance\'s observation', () => {
    const a = new OracleExponentCache();
    const b = new OracleExponentCache();
    a.remember('SHARED', -5);
    // b never directly observed SHARED, but the module fallback was
    // populated by a's remember — so b's lookup should hit it as a tier-2.
    expect(b.lookup('SHARED')).toBe(-5);
  });
});
