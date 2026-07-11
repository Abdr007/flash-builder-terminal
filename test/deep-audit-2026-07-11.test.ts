/**
 * Regression tests for the deep pre-launch security audit (2026-07-11, pass 2).
 *
 * Locks in the guard behaviour for:
 *   - M2  safeEnvNumber validates the config-file fallback (fail-open caps)
 *   - M3  looksLikeSecret / looksLikeIntent refuse key-shaped input to the AI
 *   - M7/L1  redactCommonSecrets strips path-token RPC creds + keypair byte arrays
 */
import { describe, it, expect, afterEach } from 'vitest';
import { safeEnvNumber } from '../src/utils/safe-env.js';
import { looksLikeSecret, looksLikeIntent } from '../src/ai/interpret.js';
import { redactCommonSecrets } from '../src/security/redact-secrets.js';

const UNSET = 'DEEP_AUDIT_UNSET_KEY_XYZ';

describe('M2 — safeEnvNumber validates the (config.json) fallback, not just env', () => {
  afterEach(() => { delete process.env[UNSET]; });

  it('throws when a bounded fallback is negative (would silently disable a cap)', () => {
    expect(() => safeEnvNumber(UNSET, -1, { min: 0 })).toThrow();
  });
  it('throws when a bounded fallback is non-finite', () => {
    expect(() => safeEnvNumber(UNSET, Number.NaN, { min: 0 })).toThrow();
  });
  it('accepts a valid bounded fallback (0 = unlimited)', () => {
    expect(safeEnvNumber(UNSET, 0, { min: 0 })).toBe(0);
    expect(safeEnvNumber(UNSET, 25, { min: 0 })).toBe(25);
  });
  it('does NOT validate an unbounded fallback (prior leniency preserved)', () => {
    expect(safeEnvNumber(UNSET, -1)).toBe(-1);
  });
  it('still enforces bounds on the env value', () => {
    process.env[UNSET] = '-5';
    expect(() => safeEnvNumber(UNSET, 0, { min: 0 })).toThrow();
    process.env[UNSET] = '9';
    expect(safeEnvNumber(UNSET, 0, { min: 0 })).toBe(9);
  });
});

describe('M3 — key-shaped input is refused before the AI layer', () => {
  // 88-char single alphanumeric token (base58 secret key, post-normalize lowercase).
  const base58Key = 'k'.repeat(80) + '12345678';
  const byteArray = Array.from({ length: 64 }, (_, i) => (i % 250) + 1).join(',');
  const mnemonic = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

  it('flags a base58/hex-length single token', () => {
    expect(looksLikeSecret(base58Key)).toBe(true);
  });
  it('flags a JSON keypair byte array', () => {
    expect(looksLikeSecret(byteArray)).toBe(true);
  });
  it('flags a BIP39-length mnemonic', () => {
    expect(looksLikeSecret(mnemonic)).toBe(true);
  });
  it('does not flag a normal trade command', () => {
    expect(looksLikeSecret('open sol long 10 5x')).toBe(false);
    expect(looksLikeSecret('close btc')).toBe(false);
  });
  it('looksLikeIntent rejects a pasted key even though it contains digits', () => {
    expect(looksLikeIntent(base58Key)).toBe(false);
    expect(looksLikeIntent(byteArray)).toBe(false);
    // real intent still passes
    expect(looksLikeIntent('go long btc 3x')).toBe(true);
  });
});

describe('M7/L1 — credential redaction', () => {
  it('strips a QuickNode path-embedded token but keeps the host', () => {
    const out = redactCommonSecrets('rpc https://cold-fog.solana-mainnet.quiknode.pro/abc123def456ghi789/ failed');
    expect(out).toContain('quiknode.pro/***');
    expect(out).not.toContain('abc123def456ghi789');
  });
  it('strips a Triton rpcpool path token', () => {
    const out = redactCommonSecrets('https://flash.rpcpool.com/deadbeefcafebabetoken');
    expect(out).toContain('rpcpool.com/***');
    expect(out).not.toContain('deadbeefcafebabetoken');
  });
  it('redacts a keypair byte array', () => {
    const arr = '[' + Array.from({ length: 64 }, (_, i) => (i % 250) + 1).join(',') + ']';
    expect(redactCommonSecrets(`secret ${arr}`)).toContain('[<redacted-keypair-bytes>]');
  });
  it('leaves a Solscan tx link intact (audit trail)', () => {
    const link = 'https://solscan.io/tx/5xY' + 'a'.repeat(80);
    expect(redactCommonSecrets(link)).toBe(link);
  });
  it('still strips api_key query params', () => {
    expect(redactCommonSecrets('url?api_key=supersecretvalue')).toContain('api_key=***');
  });
});
