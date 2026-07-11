/**
 * Property fuzzing of safeEnvNumber — the source of the money-path risk caps
 * (MAX_LEVERAGE / MAX_COLLATERAL / MAX_POSITION_SIZE). The invariant: whenever
 * it returns (doesn't throw), the value is FINITE and within [min, max]. It must
 * never hand a bounded cap a NaN or out-of-range value — that's exactly the
 * fail-open class the M2 audit fix closed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import { safeEnvNumber } from '../../src/utils/safe-env.js';

const KEY = 'FUZZ_ENV_CAP';

describe('safeEnvNumber fuzz — bounded result or throw, never poison', () => {
  afterEach(() => { delete process.env[KEY]; });

  it('a bounded result is always finite and within [min,max], else it throws', () => {
    fc.assert(
      fc.property(
        fc.option(fc.oneof(fc.string(), fc.integer().map(String), fc.constantFrom('nan', 'inf', '-5', '1e9', '')), { nil: undefined }),
        fc.double({ noNaN: false, min: -1e9, max: 1e9 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (envVal, fallback, a, b) => {
          if (envVal === undefined) delete process.env[KEY];
          else process.env[KEY] = envVal;
          const min = Math.min(a, b);
          const max = Math.max(a, b);
          let result: number | undefined;
          let threw = false;
          try { result = safeEnvNumber(KEY, fallback, { min, max }); } catch { threw = true; }
          if (!threw) {
            expect(Number.isFinite(result)).toBe(true);
            expect(result! >= min && result! <= max).toBe(true);
          }
        },
      ),
      { numRuns: 10000 },
    );
  });
});
