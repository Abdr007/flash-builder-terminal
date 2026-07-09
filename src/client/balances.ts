/**
 * Pure balance-map composition.
 *
 * Given the three on-chain accounts that determine a user's vault state
 * (`UserDepositLedger.deposits`, `Basket.debits`, `Basket.pendingCredits`)
 * and the pool's custody set, compute the per-symbol available balance:
 *
 *   available = deposits − debits + pendingCredits
 *
 * This formula matches what the program checks in `openPosition` line 175.
 * Extracted out of `magic-client.ts` so it can be unit tested without the
 * SDK / RPC stack — feed it three plain arrays and check the result.
 *
 * Symbols with all three balances at zero are omitted from the output map
 * to keep the UI uncluttered (matches the prior CLI behaviour).
 */

import type { PublicKey } from '@solana/web3.js';
import type BN from 'bn.js';

export interface MintAmountEntry {
  mint: PublicKey;
  amount: BN;
}

export interface CustodyMeta {
  symbol: string;
  decimals: number;
  mintKey: PublicKey;
}

export interface BalanceRow {
  available: number;
  deposits: number;
  debits: number;
  pendingCredits: number;
  decimals: number;
}

/**
 * Compose per-symbol balances. All `BN` amounts are interpreted in raw
 * token units and converted to `decimal-adjusted` JS numbers using the
 * custody's `decimals`. Skips entries where every component is zero so
 * the consumer doesn't have to filter.
 */
export function composeBalanceMap(
  custodies: readonly CustodyMeta[],
  deposits: readonly MintAmountEntry[] | null | undefined,
  debits: readonly MintAmountEntry[] | null | undefined,
  pendingCredits: readonly MintAmountEntry[] | null | undefined,
): Map<string, BalanceRow> {
  const out = new Map<string, BalanceRow>();
  for (const cust of custodies) {
    const dep = (deposits ?? []).find((d) => d.mint.equals(cust.mintKey))?.amount;
    const deb = (debits ?? []).find((d) => d.mint.equals(cust.mintKey))?.amount;
    const cred = (pendingCredits ?? []).find((d) => d.mint.equals(cust.mintKey))?.amount;
    const denom = Math.pow(10, cust.decimals);
    const depN = dep ? Number(dep.toString()) / denom : 0;
    const debN = deb ? Number(deb.toString()) / denom : 0;
    const credN = cred ? Number(cred.toString()) / denom : 0;
    if (depN === 0 && debN === 0 && credN === 0) continue;
    const available = depN - debN + credN;
    out.set(cust.symbol, {
      available,
      deposits: depN,
      debits: debN,
      pendingCredits: credN,
      decimals: cust.decimals,
    });
  }
  return out;
}
