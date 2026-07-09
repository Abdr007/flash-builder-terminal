# Threat Model — Flash Magic Terminal

This document is the canonical record of what the CLI is protecting,
who it's protecting against, and how. Audit findings are tracked
against this model — if a finding doesn't fall inside one of the assets
or boundaries below, it's a feature request, not a security issue.

## Assets

In priority order:

1. **The user's signing key** (`~/.config/solana/id.json` or equivalent).
   The single highest-value asset. Anything that exfiltrates the key, or
   tricks the CLI into signing something the user didn't intend, is a
   critical issue.
2. **Funds in the basket / vault.** The user's deposited collateral —
   protected by signing-guard, kill switch, rate limit, and chain-truth
   verification on withdraw.
3. **Open positions.** A position closed unintentionally (or NOT closed
   when the user expected) is a money-losing event distinct from key
   theft.
4. **The audit trail.** `~/.magic/signing-audit.log` and
   `~/.magic/magic-history.jsonl` are the user's forensic record. An
   attacker who can erase or fabricate entries can hide a theft after
   the fact.

## Trust boundaries

| Boundary | Trust level | Notes |
|----------|-------------|-------|
| The user's local filesystem | trusted | Wallet files validated for mode 0600, home-dir scope, symlink resolution |
| Environment variables | semi-trusted | Validated through typed parsers (`safeEnvBoolStrict`, `validateRpcUrl`) |
| `~/.magic/config.json` | semi-trusted | Size-capped, schema-validated, RPC URLs re-validated on read |
| L1 RPC endpoint | untrusted | URL validated against SSRF (RFC1918, link-local, IMDS); HTTPS-only outside loopback |
| ER router (MagicBlock) | untrusted | Same URL validation; chain-truth verification on withdraw |
| Pyth Hermes / oracle feeds | untrusted | Bounded exponent, safe-int decode; feed values used only for sizing/UI, never as authority |
| The Flash Magic SDK | partially trusted | Errors mapped through `toTradingError`; instructions validated through program-ID allowlist |
| Stdin (REPL) | semi-trusted | All money-moving verbs gated behind explicit confirm unless `MAGIC_AUTO_CONFIRM=1` |
| GitHub Actions / CI | trusted | Secrets only injected to the integration job; never to PR-from-fork builds |

## Adversaries we defend against

### A1 — Local malware that already has user-level RCE
- **In scope:** preventing the malware from extracting the in-memory
  keypair across a wallet-disconnect / SIGTERM / process exit.
  *Mitigation*: secret bytes are zeroed on `disconnect`, SIGTERM, and
  uncaughtException paths. Keypair integrity is re-verified before
  every signing operation.
- **Out of scope:** preventing the malware from reading the
  on-disk wallet file directly. We can't defend against ring-0 attackers
  with full filesystem access.

### A2 — A hostile RPC endpoint
- **In scope:** the endpoint cannot redirect us to a private-network host
  (SSRF), serve oversized responses (OOM), embed credentials in the URL,
  or downgrade us to HTTP.
  *Mitigation*: `validateRpcUrl` rejects RFC1918 / link-local / IMDS
  / IPv4-mapped private; size caps on JSON responses; HTTPS-only outside
  loopback.
- **Out of scope:** an endpoint that returns syntactically-valid but
  semantically-wrong account data. We surface oracle prices as advisory;
  the on-chain program is the authority for actual trade settlement.

### A3 — A malicious or compromised SDK update
- **In scope:** an SDK build that tries to execute an unknown instruction
  is refused before signing. Restoration of monkey-patched methods on
  shutdown is non-invasive (Proxy wrapper preserves the underlying
  Connection).
  *Mitigation*: program-ID allowlist enforced inside `sendL1Ixs` /
  `sendErIxs`. Instruction validation happens AFTER `assertNotKilled()`.
- **Out of scope:** the SDK itself silently funneling lock-symbol changes
  through a legitimate-looking ix. Mitigation here is supply-chain hygiene
  (lockfile, audited dependencies) — out of scope for this document.

### A4 — A malicious npm package in our dependency tree
- **In scope:** as a defence-in-depth measure, we scrub log output for
  common API-key shapes (sk-ant, gsk_, telegram tokens, ed25519 keys
  in obvious context) so a mis-behaving dep that calls into our logger
  can't exfiltrate via `console.log`.
- **Out of scope:** a dep with native code that bypasses the JS layer.
  Out of scope for the same reasons as A1.

### A5 — A user typo / misclick
- **In scope:** confirm gates for every signing verb. Maximum collateral
  per trade. Maximum leverage. Maximum trades per minute.
  Persistent kill switch that survives restarts.
- **Out of scope:** the user *intentionally* opening a position they
  later regret.

### A6 — A user running a stale CLI against a moved-on protocol
- **In scope:** `magic doctor` checks SDK / program / IDL versions; the
  signing path refuses programs not in the allowlist; the audit log
  records every signed instruction so post-mortem of "what did this old
  CLI do" is possible.
- **Out of scope:** pre-blocking the user from running an old CLI. We
  warn but don't refuse — some users have legitimate reasons (offline
  hardware wallet, frozen-version requirement).

## Defence layers, in order

1. **Persistent kill switch** (`~/.magic/disabled`) — refuses signing
   across restarts. Survives `git checkout` of the codebase.
2. **Keypair integrity check** — before every signing call. See
   `client/keypair-integrity.ts`.
3. **Program-ID allowlist** — every instruction's `programId` checked
   against a static list. See `security/validate-programs.ts`.
4. **Signing-guard rate limit + audit log** — caps trades/minute,
   inter-trade cooldown; every attempt recorded with timestamp + result.
5. **Per-trade caps** — collateral, position size, leverage, configurable
   per env. Enforced before any RPC call.
6. **Confirm gate** — `MAGIC_AUTO_CONFIRM=false` (default unless overridden)
   shows a per-action card and waits for `y` before signing.
7. **Chain-truth verification** — withdraw checks ATA balance + basket
   balance after every attempt; never reports failure when funds moved.
8. **Sentinel signatures** — `'already-landed'` / `'expired-but-landed'`
   are never written to journals as if they were real signatures, and
   never embedded into Solscan URLs.

## Out-of-scope explicitly

- A formal audit by an external firm. The score upper-bound is gated on this.
- Hardware wallet support. The current design assumes a software keypair.
- Multi-sig. Single-signer only.
- DOS protection on a self-hosted RPC. The user's responsibility.
- Anything that requires changes to the Flash Magic Trade program itself.

## When to update this document

Update *whenever*:
- A new asset is added (new persisted file, new private key, new credential).
- A new external surface is exposed (new RPC, new third-party API).
- A new defence layer is added or removed.
- An audit finding lands that doesn't fit any current adversary section.

Last updated: see git log on this file.
