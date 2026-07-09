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

## Known upstream advisories (no patched version available)

`npm audit` reports the following CRITICAL / HIGH advisories. Each is in an
upstream dependency this project pins via the Flash Magic Trade SDK; no
patched version exists on npm at the time of writing. Reviewed for practical
exploitability in this project's surface.

| Advisory | Path | Status |
|---|---|---|
| GHSA-796p-j2gh-9m2q (CRITICAL) — `@phala/dcap-qvl-web` "Missing Verification for QE Identity" | pulled in by `@magicblock-labs/ephemeral-rollups-sdk` 0.6.5; the Flash SDK hard-pins this exact ER SDK version, and our codebase never imports the ER SDK directly. The vulnerable Phala TEE-attestation code path is not invoked by a transaction-signing client. Mitigation: ER router URL is constrained by `validateRpcUrl`. | **Tracked. Will adopt the next Flash SDK release that bumps to ER SDK ≥0.8.8 (which switches to the non-vulnerable `@phala/dcap-qvl`).** |
| GHSA-3gc7-fjrx-p6mg (HIGH) — `bigint-buffer` `toBigIntLE()` buffer overflow | pulled in transitively by `@solana/spl-token@0.4.14` → `@solana/buffer-layout-utils`. **All published versions** of `bigint-buffer` (≤1.1.5) are flagged; no patched version exists on npm. The function is invoked when decoding token-account data; an attacker would need to control the RPC response. Mitigation: `validateRpcUrl` restricts RPC origins; failover candidates are re-validated; only known token mints are queried. | **Blocked on upstream `bigint-buffer` patch publication.** |

`@solana/spl-token` "fix" reported by npm is a major *downgrade* to 0.1.8 and
is not viable. Both advisories are reviewed at every dependency bump.

For ongoing audit notes see the project's internal hardening logs (not committed publicly).
