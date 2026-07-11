/**
 * Tab-completion: verb (first token) + market symbol (second token after a
 * market-taking verb). Guards against a regression that would make the trading
 * CLI stop completing symbols users can't be expected to memorise.
 */
import { describe, it, expect } from 'vitest';
import { completeReplLine } from '../src/cli/terminal.js';

const MARKETS = new Set(['SOL', 'SUI', 'BTC', 'ETH', 'FARTCOIN']);
const comp = (line: string): string[] => completeReplLine(line, MARKETS)[0];

describe('REPL tab completion', () => {
  it('completes verbs on the first token (incl. the primary trading verbs)', () => {
    expect(comp('lo')).toContain('long');
    expect(comp('sh')).toContain('short');
    expect(comp('wal')).toEqual(['wallet']);
    expect(comp('').length).toBeGreaterThan(5); // empty → full verb list
  });
  it('completes market symbols after a market-taking verb', () => {
    expect(comp('long ')).toEqual(['BTC', 'ETH', 'FARTCOIN', 'SOL', 'SUI']);
    expect(comp('long s')).toEqual(['SOL', 'SUI']);
    expect(comp('close b')).toEqual(['BTC']);
    expect(comp('open f')).toEqual(['FARTCOIN']);
    expect(comp('reverse e')).toEqual(['ETH']);
  });
  it('does not complete past the market (amounts/tp/sl are freeform)', () => {
    expect(comp('long sol 5')).toEqual([]);
    expect(comp('long sol 5 2x')).toEqual([]);
  });
  it('does not market-complete after a non-market verb', () => {
    expect(comp('wallet u')).toEqual([]);
    expect(comp('rpc s')).toEqual([]);
  });
});
