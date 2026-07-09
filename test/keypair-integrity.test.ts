import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { verifyKeypairIntact } from '../src/client/keypair-integrity.js';

describe('verifyKeypairIntact', () => {
  it('returns true for a fresh keypair against its own address', () => {
    const kp = Keypair.generate();
    expect(verifyKeypairIntact(kp, kp.publicKey.toBase58())).toBe(true);
  });

  it('returns false when the address does not match', () => {
    const kp = Keypair.generate();
    const wrong = Keypair.generate().publicKey.toBase58();
    expect(verifyKeypairIntact(kp, wrong)).toBe(false);
  });

  it('returns false when the secretKey is zeroed', () => {
    // Note: web3.js's `Keypair.secretKey` getter returns a fresh copy on
    // each access, so mutating the returned Uint8Array doesn't actually
    // zero the underlying material. To simulate a zeroed key we construct
    // a fake Keypair-shaped object whose `secretKey` is all zeros.
    const real = Keypair.generate();
    const zeroedFake = {
      secretKey: new Uint8Array(64),
      publicKey: real.publicKey,
    } as unknown as Keypair;
    expect(verifyKeypairIntact(zeroedFake, real.publicKey.toBase58())).toBe(false);
  });

  it('returns false when secretKey is the wrong length', () => {
    const kp = Keypair.generate();
    const addr = kp.publicKey.toBase58();
    const broken = { secretKey: new Uint8Array(32), publicKey: kp.publicKey } as unknown as Keypair;
    expect(verifyKeypairIntact(broken, addr)).toBe(false);
  });
});
