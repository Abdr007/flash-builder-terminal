/**
 * Chain-truth verifier for the withdraw flow.
 *
 * The SDK's withdraw path can throw for reasons that have nothing to do
 * with the funds actually moving (ER lag, blockhash expiry, retry-side-
 * effect). Before reporting failure to the user, we ask the chain
 * directly: did the funds end up in the destination ATA?
 *
 * IMPORTANT — ATA increase is the AUTHORITATIVE signal. The basket-side
 * decrement only proves the `request` ix landed; it does NOT prove the
 * `settle` ix landed and put tokens in the user's wallet. A failed /
 * stalled settle leaves the basket lower AND the wallet unchanged — if
 * we counted basket-drop alone as success, we'd green-light a withdraw
 * that left the user with neither the basket balance NOR the tokens.
 *
 * Therefore: the ATA-increase signal is REQUIRED. The basket-drop is
 * kept as a defence-in-depth corroboration — both signals must agree
 * before we report success. If the ATA never increased, we report
 * failure regardless of what the basket says.
 *
 * Slippage tolerance is 15 % so fee deductions, oracle rounding, and the
 * "raw token units vs USD" mismatch on non-stable assets don't cause
 * false negatives. The caller is responsible for the actual signal
 * thresholds — this module just composes the comparisons.
 */

const SLIPPAGE = 0.85; // 1 − 0.15

export interface VerifyWithdrawSnapshot {
  /** Pre-trade ATA balance (token units, decimal-adjusted). null = unknown. */
  ataPre: number | null;
  /** Pre-trade basket `available` balance for the symbol. Null if the symbol or pre-balances are unknown. */
  basketPre: number | null;
  /** Symbol the withdraw targets — null disables the basket-side check. */
  tokenSymbol: string | null;
  /** Withdraw amount in token-units, decimal-adjusted (matches ataPre's scale). */
  amountTokens: number;
}

export interface VerifyWithdrawIO {
  /** Re-read the user's ATA balance for the token. Throws on RPC failure. */
  readAta: () => Promise<number | null>;
  /**
   * Re-read the basket's `available` balance for the token. Returns
   * undefined when the symbol isn't known or the basket has no entry.
   */
  readBasket: () => Promise<number | undefined>;
}

/**
 * Returns `true` iff the destination ATA balance increased by ≥
 * amount × 0.85 (i.e. the funds actually moved into the user's
 * wallet). The basket-drop signal is read for defence-in-depth — when
 * available we require it to corroborate the ATA gain — but a
 * basket-only signal is NEVER sufficient on its own.
 *
 * Why so strict: a half-landed withdraw (`request` ok, `settle`
 * stalled) drops the basket but leaves the wallet untouched. If we
 * accepted basket-only as success, the user would see a green check
 * mark and walk away — and then later notice the funds aren't in
 * their wallet, which is the worst possible support ticket.
 *
 * Returns `false` on RPC failures so the caller still throws the
 * SDK's original error — never silently swallow a failed withdraw.
 */
export async function verifyWithdrawLanded(
  snap: VerifyWithdrawSnapshot,
  io: VerifyWithdrawIO,
): Promise<boolean> {
  const lower = snap.amountTokens * SLIPPAGE;

  // Signal 1 (REQUIRED) — ATA balance increased by ≈ amountTokens.
  // No fallback path: if we can't prove the ATA grew, we report
  // failure even if the basket dropped.
  let ataGained = false;
  try {
    const post = await io.readAta();
    if (snap.ataPre !== null && post !== null) {
      const ataDelta = post - snap.ataPre;
      if (ataDelta >= lower) ataGained = true;
    }
  } catch { /* RPC failure → ataGained stays false */ }

  if (!ataGained) return false;

  // Signal 2 (CORROBORATION, optional) — basket available balance
  // decreased by ≈ amountTokens. If the basket signal is unavailable
  // (RPC blip, symbol unknown) we still trust the ATA signal alone —
  // it's the authoritative one. We only veto if the basket signal IS
  // available and clearly contradicts the ATA gain (e.g. basket
  // didn't drop at all, indicating the ATA gain came from somewhere
  // else and was a false positive).
  if (!snap.tokenSymbol || snap.basketPre === null) return true;
  try {
    const post = await io.readBasket();
    if (typeof post !== 'number') return true; // basket signal unavailable; trust ATA
    const delta = snap.basketPre - post;
    // Require the basket to have dropped by AT LEAST half the
    // expected amount — otherwise the ATA "gain" is suspicious
    // (independent deposit, not our withdraw).
    return delta >= lower * 0.5;
  } catch {
    return true; // basket read failed; ATA signal stands
  }
}
