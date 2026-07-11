/**
 * Property fuzzing of safeJsonParse — used for every user-editable config/state
 * file. It must never throw (returns the fallback on malformed input) and must
 * never let a `__proto__` / `constructor` payload pollute Object.prototype.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { safeJsonParse } from '../../src/utils/safe-json.js';

describe('safe-json fuzz — no crash, no prototype pollution', () => {
  it('never throws for ANY string', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      expect(() => safeJsonParse(s, { fb: true })).not.toThrow();
    }), { numRuns: 8000 });
  });
  it('parsing hostile __proto__/constructor payloads never pollutes Object.prototype', () => {
    fc.assert(fc.property(fc.constantFrom('__proto__', 'constructor', 'prototype'), fc.string(), (k, v) => {
      const payload = `{"${k}": {"polluted": ${JSON.stringify(v || 'x')}}, "a": 1}`;
      safeJsonParse(payload, {});
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    }), { numRuns: 4000 });
  });
});
