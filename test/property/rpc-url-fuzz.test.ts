/**
 * Property fuzzing of validateRpcUrl — the SSRF gate. The CLI sends signed txs
 * to whatever host this URL names, so a config-editable URL must NEVER be
 * accepted when it points at a private / link-local / IMDS / CGNAT host (in any
 * encoding), carries credentials, or is plain http to a non-loopback host.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import { validateRpcUrl } from '../../src/config/index.js';

const accepts = (url: string): boolean => { try { validateRpcUrl(url); return true; } catch { return false; } };

describe('validateRpcUrl fuzz — SSRF never accepted', () => {
  beforeAll(() => { delete process.env.MAGIC_ALLOW_INSECURE_RPC; });

  it('never throws a non-Error for ANY string', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      try { validateRpcUrl(s); } catch (e) { expect(e).toBeInstanceOf(Error); }
    }), { numRuns: 6000 });
  });

  it('rejects https to private/IMDS/CGNAT hosts — dotted, integer AND hex encodings', () => {
    const privV4 = fc.oneof(
      fc.tuple(fc.constant(10), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 1, max: 254 })),
      fc.tuple(fc.constant(192), fc.constant(168), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 1, max: 254 })),
      fc.tuple(fc.constant(172), fc.integer({ min: 16, max: 31 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 1, max: 254 })),
      fc.tuple(fc.constant(169), fc.constant(254), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 1, max: 254 })),
      fc.tuple(fc.constant(100), fc.integer({ min: 64, max: 127 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 1, max: 254 })),
    ).map((o) => o.join('.'));
    fc.assert(fc.property(privV4, (ip) => {
      expect(accepts(`https://${ip}/rpc`)).toBe(false);
      const int = ip.split('.').reduce((acc, o) => acc * 256 + Number(o), 0);
      expect(accepts(`https://${int}/rpc`)).toBe(false);
      const hex = '0x' + ip.split('.').map((o) => Number(o).toString(16).padStart(2, '0')).join('');
      expect(accepts(`https://${hex}/rpc`)).toBe(false);
    }), { numRuns: 5000 });
  });

  it('rejects embedded credentials and plain http to a non-loopback host', () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-z]{3,10}$/), (w) => {
      expect(accepts(`https://user:pass@${w}.example.com/`)).toBe(false);
      expect(accepts(`http://${w}.example.com/`)).toBe(false);
    }), { numRuns: 3000 });
  });

  it('accepts a normal public https RPC', () => {
    expect(accepts('https://api.mainnet-beta.solana.com')).toBe(true);
    expect(accepts('https://mainnet.helius-rpc.com/?api-key=x')).toBe(true);
  });
});
