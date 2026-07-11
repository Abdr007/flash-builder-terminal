/**
 * Regression tests for the pre-public security audit (2026-07), lower-severity
 * findings:
 *   - IND-1 (Low): an explicit invalid leverage (`0x`) must be REJECTED, not
 *     silently rewritten to the 2x default.
 *   - F-3 (Low): key-buffer zeroization must scrub the buffer RETAINED by
 *     Keypair.fromSecretKey (the argument), not the getter's throwaway copy.
 *   - F-5 (Low): state writes go through an atomic temp+rename helper that
 *     never leaves a partial file and cleans up its temp on failure.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Keypair } from '@solana/web3.js';
import { interpretCommand, configureSymbols } from '../src/cli/interpreter.js';
import { atomicWriteFileSync } from '../src/utils/atomic-write.js';

configureSymbols(['SOL', 'BTC'], [['sol', 'SOL'], ['btc', 'BTC']]);

describe('IND-1: explicit invalid leverage is rejected, not silently defaulted', () => {
  it('`long SOL 5 0x` is REJECTED (0x is invalid, not a request for 2x)', () => {
    expect(interpretCommand('long SOL 5 0x')).toBeNull();
  });

  it('`long SOL 5` (no leverage) still defaults to 2x', () => {
    const r = interpretCommand('long SOL 5');
    expect(r?.params.leverage).toBe(2);
  });

  it('`long SOL 5 3x` (explicit valid) keeps the typed leverage', () => {
    const r = interpretCommand('long SOL 5 3x');
    expect(r?.params.leverage).toBe(3);
  });
});

describe('F-3: key zeroization scrubs the retained buffer, not a copy', () => {
  it('filling the fromSecretKey argument zeroes the live key (retained by reference)', () => {
    const src = Keypair.generate();
    const keyBytes = Uint8Array.from(src.secretKey);
    const kp = Keypair.fromSecretKey(keyBytes);
    const pub = kp.publicKey.toBase58();
    expect(pub).toBe(src.publicKey.toBase58());

    keyBytes.fill(0); // the fix: scrub the RETAINED buffer
    expect(Array.from(kp.secretKey).every((b) => b === 0)).toBe(true);
  });

  it('filling the secretKey getter is a NO-OP on the live key (the old bug)', () => {
    const src = Keypair.generate();
    const kp = Keypair.fromSecretKey(Uint8Array.from(src.secretKey));
    const copy = kp.secretKey; // getter returns a fresh copy each call
    copy.fill(0);
    // Internal key is untouched — proves `keypair.secretKey.fill(0)` was a no-op.
    expect(Array.from(kp.secretKey).some((b) => b !== 0)).toBe(true);
  });
});

describe('F-5: atomicWriteFileSync', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('writes the full content and leaves NO temp files behind', () => {
    dir = mkdtempSync(join(tmpdir(), 'magic-atomic-'));
    const target = join(dir, 'config.json');
    atomicWriteFileSync(target, '{"a":1}\n', 0o600);
    expect(readFileSync(target, 'utf8')).toBe('{"a":1}\n');
    // No `.config.json.tmp.*` residue.
    expect(readdirSync(dir).filter((f) => f.includes('.tmp.'))).toHaveLength(0);
  });

  it('replaces existing content atomically (full overwrite, no interleave)', () => {
    dir = mkdtempSync(join(tmpdir(), 'magic-atomic-'));
    const target = join(dir, 'session.json');
    writeFileSync(target, '{"old":"value-that-is-long"}\n');
    atomicWriteFileSync(target, '{"new":1}\n', 0o600);
    expect(readFileSync(target, 'utf8')).toBe('{"new":1}\n');
  });

  it('cleans up its temp file and throws when the rename target is unusable', () => {
    dir = mkdtempSync(join(tmpdir(), 'magic-atomic-'));
    const target = join(dir, 'busy');
    mkdirSync(target); // a directory can't be replaced by rename(file → dir)
    expect(() => atomicWriteFileSync(target, 'data', 0o600)).toThrow();
    // The temp file must not linger after the failure.
    expect(readdirSync(dir).filter((f) => f.includes('.tmp.'))).toHaveLength(0);
  });
});
