/**
 * Property fuzzing of the tab completer — it runs on every keystroke-triggered
 * Tab, so it must never throw and must always return a well-formed
 * [completions, fragment] pair for any line and any pool symbol set.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { completeReplLine } from '../../src/cli/terminal.js';

describe('completer fuzz — never throws, well-formed result', () => {
  it('returns [string[], string] for any line + symbol set', () => {
    fc.assert(
      fc.property(fc.string(), fc.array(fc.string({ maxLength: 8 }), { maxLength: 40 }), (line, syms) => {
        const r = completeReplLine(line, new Set(syms.map((s) => s.toUpperCase())));
        expect(Array.isArray(r)).toBe(true);
        expect(Array.isArray(r[0])).toBe(true);
        expect(r[0].every((x) => typeof x === 'string')).toBe(true);
        expect(typeof r[1]).toBe('string');
      }),
      { numRuns: 6000 },
    );
  });
});
