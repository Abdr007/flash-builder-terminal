/**
 * Regression tests for two audit MEDIUMs:
 *  - #13: a negative env cap must FAIL LOUD, not silently disable the guard.
 *  - #16: `sell` on perps must never silently CLOSE a position.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { safeEnvNumber } from '../src/utils/safe-env.js';
import { parseCommandForTest } from '../src/cli/terminal.js';
import { configureSymbols } from '../src/cli/interpreter.js';
import type { MagicConfig } from '../src/types/index.js';

describe('safeEnvNumber range enforcement (#13 — negative caps fail loud)', () => {
  afterEach(() => { delete process.env.TEST_CAP; });

  it('throws on a value below min instead of silently disabling the guard', () => {
    process.env.TEST_CAP = '-1';
    expect(() => safeEnvNumber('TEST_CAP', 0, { min: 0 })).toThrow(/below the minimum/);
  });

  it('accepts 0 (unlimited) and positive values', () => {
    process.env.TEST_CAP = '0';
    expect(safeEnvNumber('TEST_CAP', 5, { min: 0 })).toBe(0);
    process.env.TEST_CAP = '25';
    expect(safeEnvNumber('TEST_CAP', 5, { min: 0 })).toBe(25);
  });

  it('throws above max, and falls back to default when unset', () => {
    process.env.TEST_CAP = '999';
    expect(() => safeEnvNumber('TEST_CAP', 1, { max: 50 })).toThrow(/above the maximum/);
    delete process.env.TEST_CAP;
    expect(safeEnvNumber('TEST_CAP', 7, { min: 0 })).toBe(7);
  });
});

describe('sell never silently closes on perps (#16)', () => {
  const config = { network: 'mainnet-beta', poolName: 'Pool.0' } as unknown as MagicConfig;
  configureSymbols(['SOL', 'BTC', 'ETH'], []);

  it('`sell SOL 5 2x` opens a SHORT (not a close)', () => {
    const r = parseCommandForTest('sell SOL 5 2x', config);
    expect(r?.alias).toBe('open');
    expect(r?.params).toMatchObject({ side: 'short', collateral: 5, leverage: 2, market: 'SOL' });
  });

  it('`buy SOL 5 2x` opens a LONG', () => {
    const r = parseCommandForTest('buy SOL 5 2x', config);
    expect(r?.alias).toBe('open');
    expect(r?.params).toMatchObject({ side: 'long', collateral: 5, leverage: 2 });
  });

  it('bare `sell SOL` does NOT resolve to close', () => {
    const r = parseCommandForTest('sell SOL', config);
    expect(r?.alias).not.toBe('close');
    expect(r?.alias).not.toBe('close-all');
  });

  it('`close SOL long` and `exit SOL` still close', () => {
    expect(parseCommandForTest('close SOL long', config)?.alias).toBe('close');
    expect(parseCommandForTest('exit SOL', config)?.alias).toBe('close');
  });
});
