/**
 * Property-based fuzzing of the deterministic NL command parser.
 *
 * The parser turns typed text into REAL trades. The catastrophic failure modes
 * are: (1) it THROWS and takes down the REPL, or (2) it emits a trade carrying a
 * poison numeric value — NaN / Infinity / negative / zero collateral or
 * sub-1 leverage — which would size or price a real position wrong. Unit tests
 * check examples; these properties hammer the invariants across thousands of
 * random AND adversarial inputs (magnitude suffixes, huge/negative/exponential
 * numbers, control chars, unicode) so a whole class of misparse bugs can't ship.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import { interpretCommand, configureSymbols } from '../../src/cli/interpreter.js';

beforeAll(() => configureSymbols(new Set(['SOL', 'BTC', 'ETH', 'SUI']), new Map()));

const finitePos = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n > 0;

describe('parser fuzz — robustness + no poison trade', () => {
  it('never throws on ANY string input', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => interpretCommand(s)).not.toThrow();
      }),
      { numRuns: 6000 },
    );
  });

  it('never throws on adversarial trade-shaped input', () => {
    const tok = fc.oneof(
      fc.constantFrom('long', 'short', 'open', 'close', 'buy', 'sell', 'limit', 'reverse', 'tp', 'sl'),
      fc.constantFrom('SOL', 'BTC', 'ETH', 'SUI', 'sol', 'notamarket', 'sooool'),
      fc.constantFrom('5', '5k', '1.5m', '60k', '2b', '0', '-5', '1e9', '5x', '2x', '.5', '999999999999999', 'x', '$', '@', '%'),
      fc.string({ maxLength: 6 }),
    );
    fc.assert(
      fc.property(fc.array(tok, { minLength: 1, maxLength: 6 }), (toks) => {
        expect(() => interpretCommand(toks.join(' '))).not.toThrow();
      }),
      { numRuns: 8000 },
    );
  });

  it('any parsed OPEN has finite collateral>0 and leverage>=1 — never NaN/neg/zero', () => {
    const verb = fc.constantFrom('long', 'short', 'open', 'buy', 'sell');
    const market = fc.constantFrom('SOL', 'BTC', 'ETH', 'SUI', 'sol', 'btc');
    const amt = fc.oneof(
      fc.integer({ min: 0, max: 9_999_999 }).map(String),
      fc.constantFrom('5k', '1.5m', '60k', '2b', '0', '-5', '1e9', '5x', '2x', '', '.5', '100000000000', 'nan', 'inf'),
    );
    const line = fc.tuple(verb, market, amt, amt).map(([v, m, a, b]) => `${v} ${m} ${a} ${b}`);
    fc.assert(
      fc.property(line, (l) => {
        const r = interpretCommand(l);
        if (r?.alias === 'open') {
          const p = r.params as { collateral?: unknown; leverage?: unknown; tp?: unknown; sl?: unknown };
          expect(finitePos(p.collateral)).toBe(true);
          expect(typeof p.leverage === 'number' && Number.isFinite(p.leverage) && p.leverage >= 1).toBe(true);
          for (const k of ['tp', 'sl'] as const) {
            if (p[k] !== undefined) expect(Number.isFinite(p[k] as number)).toBe(true);
          }
        }
      }),
      { numRuns: 8000 },
    );
  });

  it('NO numeric field in ANY parsed result is NaN/Infinity', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = interpretCommand(s);
        if (r) {
          for (const v of Object.values(r.params as Record<string, unknown>)) {
            if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
          }
        }
      }),
      { numRuns: 6000 },
    );
  });
});
