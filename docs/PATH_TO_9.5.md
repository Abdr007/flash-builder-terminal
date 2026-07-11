# Path to 9.5 — the three live-environment items

Two deep audits + a UX pass took the Flash Magic Terminal from a real **8.5** (with
a hidden launch-blocking CRITICAL) to a verified **~9.1**: trades confirm on-chain
before claiming success, the confirm gate shows the size being signed, stale prices
don't render as live, exits won't bounce off the entry cap, `reverse` resolves side
from the actual position, the ER validator can be pinned, and the first run is a
premium animated sequence. All merged, CI-green, 350 tests.

The remaining **0.4** to a *confident* **9.5** is three items that **cannot be
validated on this machine** — Flash V2 is **not deployed on public Solana devnet**
(`FLASH6…` and `PERP…` both return "not on devnet"), so no code written here can be
exercised against a real open/withdraw. Doing them blind risks the exact regressions
the whole audit exists to prevent (a wrong decode that *blocks legitimate
withdrawals*). This runbook makes them turnkey the moment a live environment exists.

## Prerequisite: a live-capable environment

Pick one:

- **Mainnet-fork validator** (recommended — no real funds):
  ```bash
  solana-test-validator \
    --url https://api.mainnet-beta.solana.com \
    --clone-upgradeable-program FLASH6Lo6h3iasJKWDs2F8TkW2UKz3sZyQhwFbY7YzKZ \
    --clone <pool> --clone <custody…> --clone <oracle…> \
    --reset
  ```
  Point `MAGIC_TEST_DEVNET_RPC` at `http://127.0.0.1:8899`. Capture the account set
  from a real mainnet `open`/`withdraw` (see step 3) to know what to `--clone`.
- **Funded mainnet, tiny sizes** (real funds, ~$5): a throwaway keypair with a few
  dollars of USDC. Use `MAGIC_SLIPPAGE_PERCENT` defaults and `collateral = 1`.

Env for the write-smoke (already wired in `scripts/smoke-local.sh`):
```bash
export MAGIC_TEST_KEYPAIR_BASE58=$(node scripts/keypair-to-base58.mjs ~/.config/solana/<key>.json)
export MAGIC_TEST_DEVNET_RPC=<fork or mainnet RPC>
```

---

## Item 1 — Blocking M4: verify the withdraw tx destination (HIGH)

**Why blind is dangerous:** the withdraw is 2-step (request + settle) and may route
tokens through an intermediate account before the owner's ATA. A `!== owner ATA`
assertion built without a real tx could *false-positive and brick every withdrawal*.
Build it against a captured tx.

**Where:** `src/client/flash-v2-builder.ts` — `signAndSubmit`, funds route, `name === 'withdraw'`.

**Spec:**
1. Capture a real withdraw tx (step 3 below) and inspect its instructions:
   `VersionedTransaction.deserialize(...).message.compiledInstructions`.
2. Identify every SPL-Token (`Tokenkeg…`) `transfer` / `transferChecked`. For each,
   resolve the **destination** account key (index into `staticAccountKeys` +
   resolved ALT keys).
3. Assert the destination the funds ultimately land in equals
   `getAssociatedTokenAddressSync(mint, owner)` for the withdrawn token/owner.
4. **Fail-safe posture:** if the decode is unambiguous and the destination is a
   *known-external* account → **throw** (block). If the tx shape is unexpected /
   can't be decoded confidently → **allow + log a warning** (never block a
   legitimate withdrawal on a decode gap).
5. Unit-test with the captured tx (mock `l1Connection`): good destination → passes;
   destination swapped to a foreign ATA → throws.

**Done when:** the test proves an attacker-ATA destination is blocked and a real
withdraw passes, on a captured tx — not a synthesized one.

---

## Item 2 — Confirm-card program fidelity (MEDIUM)

**Problem:** the `open` confirm card previews entry/liq/size via `buildMagicClient`
(the *legacy* FTv2 program) while the tx signs against **FLASH6** — and it renders an
isolated "Open" card even when `magicOpen` re-routes to **increase** (a merge with a
different blended liq).

**Where:** `src/cli/terminal.ts` (the `open` confirm branch ~1286) + `src/tools/magic-tools.ts:magicOpen`.

**Spec:**
1. Source the preview from the **same** `FlashV2BuilderClient` that signs — use the
   `preview/margin` endpoint (in `FLASH_V2_PREVIEWS`) instead of the ER client.
2. Before rendering, detect the existing-position case (a positions read) and label
   the card **"Increase"** with the correct merged size/leverage/liq.
3. Verify against the live preview endpoint's real response shape (why it needs a
   live call).

**Done when:** the confirmed numbers come from the FLASH6 path and a re-route reads
"Increase," verified against a live open.

---

## Item 3 — Live trade-execution acceptance (removes the asterisk)

The `confirmOnChain` path (#19) is unit-tested + fail-safe but never live-exercised.

**Spec:** run `npm run smoke:local:writes` against the live env (deposit → open →
close → withdraw, tiny size) and confirm:
- a successful open lights up `confirmation: 'confirmed'` and renders "Position Opened";
- a deliberately-reverting order (e.g. an impossible slippage bound) **throws
  `FlashV2TxRevertedError`** and renders a failure, never a green card;
- withdraw completes via `verifyWithdrawLanded` (ATA increase).

**Done when:** the 4-step lifecycle passes with real tx signatures, and the
revert-path is confirmed to fail-closed on-chain.

---

## After all three

Update the audit memory + `SECURITY.md`, and the rating is a legitimate, evidence-
backed **9.5** — every dimension ≥9 with the trade-execution asterisk removed. Ping
me with a live RPC + throwaway keypair and I'll execute this end-to-end.
