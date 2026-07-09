/**
 * Regression tests for audit LOWs that are cleanly unit-testable:
 *  - validateRpcUrl blocks non-standard IPv4 encodings (SSRF class).
 *  - uiAmount rejects out-of-range / underflowing amounts instead of emitting
 *    exponential notation or a silent "0".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateRpcUrl } from '../src/config/index.js';
import { uiAmount } from '../src/client/flash-v2-builder.js';

describe('validateRpcUrl — SSRF via non-standard IPv4 encodings is defended', () => {
  let prev: string | undefined;
  beforeEach(() => { prev = process.env.MAGIC_ALLOW_INSECURE_RPC; delete process.env.MAGIC_ALLOW_INSECURE_RPC; });
  afterEach(() => { if (prev === undefined) delete process.env.MAGIC_ALLOW_INSECURE_RPC; else process.env.MAGIC_ALLOW_INSECURE_RPC = prev; });

  it('blocks private/IMDS ranges written as integer or hex (URL-normalised then caught)', () => {
    // 2852039166 / 0xa9fea9fe = 169.254.169.254 (cloud metadata); 167772161 = 10.0.0.1.
    for (const u of ['https://2852039166', 'https://0xa9fea9fe', 'https://167772161', 'https://0x0a000001']) {
      expect(() => validateRpcUrl(u), u).toThrow(/private|link-local|metadata/i);
    }
  });

  it('still blocks the plain dotted-decimal private ranges', () => {
    expect(() => validateRpcUrl('https://169.254.169.254')).toThrow(); // IMDS
    expect(() => validateRpcUrl('https://10.0.0.5')).toThrow();
  });

  it('accepts a normal public https RPC host (URL parser appends the trailing slash)', () => {
    expect(validateRpcUrl('https://api.mainnet-beta.solana.com')).toBe('https://api.mainnet-beta.solana.com/');
  });
});

describe('uiAmount — range + underflow guards', () => {
  it('formats normal values without exponential notation', () => {
    expect(uiAmount(0.5)).toBe('0.5');
    expect(uiAmount(5)).toBe('5');
    expect(uiAmount(1234)).toBe('1234');
    expect(uiAmount('7')).toBe('7'); // string passthrough
    expect(uiAmount(0)).toBe('0');   // zero is allowed
  });

  it('rejects non-finite, out-of-range, and underflowing amounts', () => {
    expect(() => uiAmount(NaN)).toThrow(/invalid/);
    expect(() => uiAmount(1e21)).toThrow(/out of range/); // would be "1e+21"
    expect(() => uiAmount(4e-13)).toThrow(/underflow/);   // would silently become "0"
  });
});
