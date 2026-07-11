/**
 * Regression tests for the audit's parser findings:
 *  - collateral/leverage must be assigned POSITIONALLY (collateral first), not
 *    magnitude-sorted, so "$5 at 50x" never becomes "$50 at 5x".
 *  - spelled-out numbers must fold COMPOSITIONALLY ("two hundred fifty" = 250,
 *    not "200 50" which the parser then misread as collateral 200 @ 50x).
 */

import { describe, it, expect } from 'vitest';
import { parseCommandForTest } from '../src/cli/terminal.js';
import type { MagicConfig } from '../src/types/index.js';

const config = { network: 'mainnet-beta', poolName: 'Pool.0' } as unknown as MagicConfig;

function open(line: string): { collateral?: number; leverage?: number; market?: string; side?: string } {
  const r = parseCommandForTest(line, config);
  expect(r?.alias).toBe('open');
  return r!.params as { collateral?: number; leverage?: number; market?: string; side?: string };
}

describe('collateral/leverage assignment is positional (not magnitude-sorted)', () => {
  it('open SOL long 5 50 → collateral 5, leverage 50 (the reported bug)', () => {
    const p = open('open SOL long 5 50');
    expect(p.collateral).toBe(5);
    expect(p.leverage).toBe(50);
  });

  it('documented forms keep collateral-first', () => {
    expect(open('long SOL 5 2x')).toMatchObject({ collateral: 5, leverage: 2 });
    expect(open('short BTC 100 3')).toMatchObject({ collateral: 100, leverage: 3 });
    expect(open('open SOL long 10 20')).toMatchObject({ collateral: 10, leverage: 20 });
  });

  it('explicit `x` still marks leverage regardless of order', () => {
    expect(open('open sol long 2x 10')).toMatchObject({ collateral: 10, leverage: 2 });
    expect(open('long 10 sol 2x')).toMatchObject({ collateral: 10, leverage: 2 });
  });
});

describe('spelled-out numbers fold compositionally', () => {
  it('"two hundred fifty" → 250 (was 200 then 50)', () => {
    expect(open('open SOL long two hundred fifty 3x')).toMatchObject({ collateral: 250, leverage: 3 });
  });

  it('compound tens+ones and hundreds', () => {
    expect(open('long sol twenty five 2x')).toMatchObject({ collateral: 25, leverage: 2 });
    expect(open('long sol five hundred 2x')).toMatchObject({ collateral: 500, leverage: 2 });
    expect(open('long sol one thousand five hundred 2x')).toMatchObject({ collateral: 1500, leverage: 2 });
  });

  it('non-number tokens (including hyphenated commands) pass through untouched', () => {
    // `close-all` must not be mangled by the number-word folder.
    const r = parseCommandForTest('close-all', config);
    expect(r?.alias).toBe('close-all');
  });
});

describe('reverse — side is optional (resolved from the open position)', () => {
  const rev = (line: string): { market?: string; side?: string } => {
    const r = parseCommandForTest(line, config);
    expect(r?.alias).toBe('reverse');
    return r!.params as { market?: string; side?: string };
  };
  it('omits side when none is given, so the tool resolves it (not a silent long)', () => {
    const p = rev('reverse SOL');
    expect(p.market).toBe('SOL');
    expect(p.side).toBeUndefined();
  });
  it('preserves an explicit side (incl. buy/sell aliases)', () => {
    expect(rev('reverse SOL short').side).toBe('short');
    expect(rev('flip SOL long').side).toBe('long');
    expect(rev('reverse SOL buy').side).toBe('long');
  });
});
