# Security Policy

## Supported versions

This project is in active development. Only the `master` branch receives security fixes.

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Email reports to **xoheb@flash.trade** with:

- A description of the vulnerability
- Reproduction steps (or PoC)
- The commit hash you tested against
- Your suggested fix (if any)

You'll get an acknowledgement within **48 hours** and a status update within **7 days**. Please give us 90 days to ship a fix before public disclosure.

## What's in scope

- Anything that could leak or corrupt a user's keypair
- Anything that could cause a trade to be signed with parameters the user didn't approve
- Anything that bypasses the signing guard (rate limit, max collateral, max leverage, max position size)
- Anything that could exhaust user funds via crafted RPC / oracle / SDK responses
- Path traversal / arbitrary file read in wallet import

## Out of scope

- DoS via local resource exhaustion (CLI is single-user by design)
- Self-XSS in terminal output (no browser surface)
- Bugs in upstream SDKs (`@flash_trade/magic-trade-client`, `@solana/web3.js`) — please report those upstream

## Hardening already in place

- Keypair secret bytes are zeroed on `wallet disconnect`, on `wallet use` (prior wallet), on graceful shutdown, and on `uncaughtException`
- Keypair integrity verified before every signature
- Signing guard with rate limits, per-trade caps, and audit log — covers `open`, `close`, `partial_close`, `increase`, `add_collateral`, `remove_collateral`, `reverse`, `place_limit`, `cancel_order`, `liquidate`
- Wallet files: home-dir scoped, symlink-resolved, size-capped at 384 bytes, mode `0600` enforced (POSIX)
- `.env` and `~/.magic/` are gitignored
- RPC URL validation rejects non-HTTPS, embedded credentials, and `.local` mDNS hosts; loopback HTTP requires `MAGIC_ALLOW_INSECURE_RPC=1`
- Backup RPC list re-validated on every load — a tampered `~/.magic/config.json` cannot inject a malicious failover endpoint
- Response body size limits prevent OOM from malicious endpoints
- Log files rotated at 10 MB; API keys, Anthropic/Groq tokens, Telegram bot tokens, base58 secret keys, and credentialed URL queries masked in BOTH file and console output
- Discord webhook URLs validated (https-only, no embedded credentials, no private/loopback hosts) before fetch
- Telegram bot tokens redacted from error messages before logging
- Background tickers (alerts, ER health, RPC probes, reconciler) all have re-entrancy guards so a slow upstream cannot stack overlapping ticks
- Reconciler is generation-counted: results from a pre-`wallet use` invocation cannot clobber state captured under the new wallet
- Program-id allowlist enforced before every send; trusted-ix cache versioned against the allowlist so a runtime allowlist change invalidates cached verdicts
- Money-critical dependencies are **exact-pinned** (no `^`/`~`): `@flash_trade/magic-trade-client`, `@solana/web3.js`, `@solana/spl-token`, `@coral-xyz/anchor`, `bn.js`, `bs58`, `decimal.js` — a malicious minor of a package that signs/serializes transactions cannot be pulled by a fresh `npx`/`-g` install, which does not consume the repo lockfile
- Pasted key material (base58/hex private key, JSON byte array, BIP39 mnemonic) is detected and refused before the AI-intent layer transmits or logs it — a secret typed at the REPL never reaches the model API or the corpus log
- ER submit path fails **closed** on `already processed` (does not resubmit with a fresh blockhash), preventing double-execution of additive operations
- Per-trade USD risk caps are not derivable from a non-USD-stable collateral token's raw amount, so such opens **fail closed** when caps are configured rather than being under-counted

## Known upstream advisories (no patched version available)

`npm audit` reports the following CRITICAL / HIGH advisories. Each is in an
upstream dependency this project pins via the Flash Magic Trade SDK; no
patched version exists on npm at the time of writing. Reviewed for practical
exploitability in this project's surface.

| Advisory | Path | Status |
|---|---|---|
| GHSA-796p-j2gh-9m2q (CRITICAL) — `@phala/dcap-qvl-web` "Missing Verification for QE Identity" | pulled in by `@magicblock-labs/ephemeral-rollups-sdk` 0.6.5; the Flash SDK hard-pins this exact ER SDK version, and our codebase never imports the ER SDK directly. The vulnerable Phala TEE-attestation code path is not invoked by a transaction-signing client. **No fix exists — npm's latest `0.3.3` is itself in the vulnerable range `<=0.3.3`.** ER SDK `0.15.5` switches to the non-vulnerable `@phala/dcap-qvl`, but overriding the ER SDK 9 minors forward is a money-path change that requires devnet validation. Mitigation: ER router URL is constrained by `validateRpcUrl`. | **Dismissed in Dependabot (`not_used`). Will adopt when the Flash SDK bumps the ER SDK, verified with a devnet smoke.** |
| GHSA-3gc7-fjrx-p6mg (HIGH) — `bigint-buffer` `toBigIntLE()` buffer overflow | pulled in transitively by `@solana/spl-token@0.4.14` → `@solana/buffer-layout-utils` (even latest `0.3.0` still depends on it). **All published versions** of `bigint-buffer` (≤1.1.5) are flagged; no patched version exists on npm (unmaintained since 2022). The function decodes token-account data with protocol-fixed buffer sizes; the overflow requires an attacker-controlled *oversized* buffer, which is not reachable here. Mitigation: `validateRpcUrl` restricts RPC origins; failover candidates are re-validated; only known token mints are queried. | **Dismissed in Dependabot (`tolerable_risk`). Blocked on upstream patch / `buffer-layout-utils` dropping the dep.** |

`@solana/spl-token` "fix" reported by npm is a major *downgrade* to 0.1.8 and
is not viable. Both advisories are reviewed at every dependency bump.

`brace-expansion` (GHSA-jxxr-4gwj-5jf2, MODERATE) is a **dev-only** transitive
dep (via `eslint`/`glob`); the ReDoS-style range does not run in the shipped
`dist/`. Patched by `npm audit fix` on the next online install — it does not
affect the published package.

**Resolved transitive advisories** (fixed in the lockfile): `uuid`
(GHSA-w5hq-g745-h8pq) via a scoped `overrides` forcing `jayson`'s `uuid@8` →
`11.1.1` (jayson only calls `uuid.v4()`, stable across majors); and `esbuild`
(GHSA-g7r4-m6w7-qqqr, dev-only) via bumping `tsx` to 4.23 (esbuild 0.28.1).

For ongoing audit notes see the project's internal hardening logs (not committed publicly).
