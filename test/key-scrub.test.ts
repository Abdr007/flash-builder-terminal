/**
 * Proves the audit's HIGH fix: disconnect / wallet-switch actually ZERO the
 * live private-key bytes. The old code zeroed `keypair.secretKey`, whose getter
 * returns a fresh copy — a no-op that left the real key in the heap. We now
 * retain and zero the raw buffer `Keypair.fromSecretKey` holds by reference.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Connection, Keypair } from '@solana/web3.js';
import { writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { WalletManager } from '../src/wallet/walletManager.js';

const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const written: string[] = [];

// loadFromFile confines paths to the home dir, so temp keypairs must live there.
function tmpKeypairFile(tag: string): string {
  const p = join(homedir(), `.keyscrub-test-${process.pid}-${tag}.json`);
  writeFileSync(p, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  written.push(p);
  return p;
}

afterEach(() => {
  for (const p of written.splice(0)) {
    try { rmSync(p); } catch { /* ignore */ }
  }
});

/** The buffer the Keypair actually holds internally (what an attacker recovers). */
function internalSecret(wm: WalletManager): Uint8Array {
  return (wm.getKeypair() as unknown as { _keypair: { secretKey: Uint8Array } })._keypair.secretKey;
}

describe('private-key scrubbing', () => {
  it('disconnect() zeros the live key bytes', () => {
    const wm = new WalletManager(conn);
    wm.loadFromFile(tmpKeypairFile('a'));
    const live = internalSecret(wm);
    expect(live.some((b) => b !== 0)).toBe(true); // key material present

    wm.disconnect();
    expect(live.every((b) => b === 0)).toBe(true); // scrubbed in place
  });

  it('switching wallets zeros the PRIOR key bytes', () => {
    const wm = new WalletManager(conn);
    wm.loadFromFile(tmpKeypairFile('alice'));
    const aliceLive = internalSecret(wm);
    expect(aliceLive.some((b) => b !== 0)).toBe(true);

    wm.loadFromFile(tmpKeypairFile('bob')); // switch
    expect(aliceLive.every((b) => b === 0)).toBe(true); // alice's key gone
    expect(internalSecret(wm).some((b) => b !== 0)).toBe(true); // bob's key present
  });

  it('the retained rawSecret IS the keypair internal buffer (same reference)', () => {
    const wm = new WalletManager(conn);
    wm.loadFromFile(tmpKeypairFile('c'));
    const raw = (wm as unknown as { rawSecret: Uint8Array }).rawSecret;
    expect(raw).toBe(internalSecret(wm)); // same object → zeroing raw scrubs the key
  });
});
