/**
 * Property-based fuzzing of credential redaction — the #1 risk for a wallet CLI.
 *
 * For every secret SHAPE the redactor claims to handle, the concrete secret
 * value must never survive into the output, embedded anywhere in arbitrary text,
 * and the redactor must never throw or hang (ReDoS) on any input.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { redactCommonSecrets } from '../../src/security/redact-secrets.js';

const alnum = fc.stringMatching(/^[A-Za-z0-9]{20,60}$/);
const noise = fc.string({ maxLength: 40 });

describe('redaction fuzz — secrets never survive, never throws', () => {
  it('never throws / hangs on ANY string', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => redactCommonSecrets(s)).not.toThrow();
      }),
      { numRuns: 8000 },
    );
  });

  it('api_key= / token= / vendor-key values never survive', () => {
    fc.assert(
      fc.property(alnum, noise, noise, (secret, a, b) => {
        for (const shaped of [`api_key=${secret}`, `token=${secret}`, `sk-ant-${secret}`, `gsk_${secret}`]) {
          const out = redactCommonSecrets(`${a} ${shaped} ${b}`);
          expect(out).not.toContain(secret);
        }
      }),
      { numRuns: 5000 },
    );
  });

  it('a Solana keypair byte-array never survives', () => {
    const byteArr = fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 32, maxLength: 64 });
    fc.assert(
      fc.property(byteArr, noise, (bytes, a) => {
        const arr = `[${bytes.join(',')}]`;
        const out = redactCommonSecrets(`${a} ${arr}`);
        expect(out).toContain('<redacted-keypair-bytes>');
        expect(out).not.toContain(arr);
      }),
      { numRuns: 4000 },
    );
  });

  it('path-token RPC credentials (QuickNode/Triton) never survive', () => {
    fc.assert(
      fc.property(alnum, (token) => {
        for (const url of [`https://x.quiknode.pro/${token}/`, `https://y.rpcpool.com/${token}`]) {
          const out = redactCommonSecrets(`rpc ${url} failed`);
          expect(out).not.toContain(token);
        }
      }),
      { numRuns: 4000 },
    );
  });
});
