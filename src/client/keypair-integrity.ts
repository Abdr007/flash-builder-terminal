/**
 * Keypair integrity check — last line of defence before signing.
 *
 * The CLI zeros the keypair's secret bytes when the user runs `wallet
 * disconnect` or when the process receives SIGTERM, to limit exposure
 * inside a heap snapshot or core dump. The signing path then needs to
 * detect "you tried to sign with a zeroed key" and refuse, instead of
 * producing an invalid-but-not-empty signature that the cluster would
 * silently reject.
 *
 * We also pin the keypair to the address it was loaded under: a Keypair
 * whose pubkey doesn't match the recorded address indicates either
 * memory corruption or a wallet swap that bypassed the signing-guard's
 * notification path. Either way, refuse.
 */

import type { Keypair } from '@solana/web3.js';

export function verifyKeypairIntact(wallet: Keypair, expectedAddress: string): boolean {
  const sk = wallet.secretKey;
  if (!sk || sk.length !== 64) return false;
  // Reject all-zeros — the disconnect handler wipes the array in place,
  // and an all-zero secretKey produces deterministic-but-useless signatures.
  let zero = true;
  for (let i = 0; i < sk.length; i++) {
    if (sk[i] !== 0) {
      zero = false;
      break;
    }
  }
  if (zero) return false;
  return wallet.publicKey.toBase58() === expectedAddress;
}
