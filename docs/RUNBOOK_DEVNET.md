# Devnet Smoke Runbook

End-to-end steps to wire the devnet integration test into CI, including the
money-moving WRITES path. Designed so the round-trip is **<10 minutes** with
no surprises.

There are two flows:

- **Flow A — Read-only smoke** (recommended first). Verifies the devnet
  lifecycle works *without* spending any test funds. The bare minimum to
  green CI.
- **Flow B — Writes smoke** (release-branch only). Same path plus a real
  deposit → open → close → withdraw on devnet. Costs a few cents in
  airdropped USDC + ~0.001 SOL gas.

Do **A** first. Confirm green. Then do **B**.

---

## Flow A — read-only smoke

### A1. Generate a dedicated devnet test keypair

Use a **new** keypair, not your daily wallet. The base58 secret will be
stored in a GitHub secret — keep it isolated from any mainnet funds.

```bash
solana-keygen new --no-bip39-passphrase --outfile ~/.config/solana/magic-devnet-test.json
```

Note the public key it prints (or run `solana-keygen pubkey ~/.config/solana/magic-devnet-test.json`).

### A2. Airdrop devnet SOL

```bash
solana airdrop 2 \
  $(solana-keygen pubkey ~/.config/solana/magic-devnet-test.json) \
  --url https://api.devnet.solana.com
```

If the public faucet is rate-limited, use the Solana faucet web UI:
https://faucet.solana.com/

### A3. Convert the keypair to the base58 form CI expects

The Solana CLI stores keypairs as a 64-element JSON byte array. The
integration test expects a base58 string. Convert with this one-liner:

```bash
node --experimental-vm-modules -e "
import('bs58').then(m => {
  const fs = require('fs');
  const bytes = JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/magic-devnet-test.json', 'utf-8'));
  process.stdout.write(m.default.encode(Uint8Array.from(bytes)) + '\n');
});
"
```

The output is one long base58 string — that's the value of
`MAGIC_TEST_KEYPAIR_BASE58`.

### A4. Pick a devnet L1 RPC

Any of:

- **Public:** `https://api.devnet.solana.com` (rate-limited; OK for read tests)
- **Helius:** sign up free at https://helius.dev → API Keys → Devnet → copy URL (`https://devnet.helius-rpc.com/?api-key=...`)
- **Triton / QuickNode:** equivalent free tiers

### A5. Run the smoke locally first

Before configuring GitHub, prove the test passes against your machine:

```bash
export MAGIC_TEST_KEYPAIR_BASE58="<the base58 from A3>"
export MAGIC_TEST_DEVNET_RPC="<the URL from A4>"
npm run test:integration
```

**Expected output**: 7 tests pass (`reads markets`, `reads SOL price`,
`previews open`, etc.). The optional WRITES test stays skipped because
`MAGIC_TEST_RUN_WRITES` is unset.

If a test fails, fix it locally — much faster than debugging in CI.

### A6. Configure GitHub secrets

In your repo on github.com:

1. **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
2. Name: `MAGIC_TEST_KEYPAIR_BASE58`
   Value: the base58 string from A3
3. Repeat with name: `MAGIC_TEST_DEVNET_RPC`
   Value: the URL from A4
4. (Optional) Repeat with name: `MAGIC_TEST_DEVNET_ER`
   Value: the ER router URL — defaults to
   `https://flashtrade.magicblock.app/` if unset.

### A7. Trigger CI

```bash
git commit --allow-empty -m "ci: smoke devnet"
git push
```

In **Actions** → the run → **integration** job, the "Test (integration ·
devnet)" step should print 7 passes + 1 skipped.

You're done with Flow A. Read-only smoke is now part of every push.

---

## Flow B — writes smoke (money-moving)

This actually deposits, opens a tiny long, closes it, and withdraws. It
runs only on `release/**` branches so feature-branch CI stays cheap.

### B1. Fund the test wallet with devnet USDC

The integration test deposits 1 USDC and opens a 1.5× long with $1
collateral. You need ~5 devnet USDC in the test wallet.

Devnet USDC mint (Magic V2 Pool.1):
`Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr`

To get devnet USDC for this mint, use the Flash Trade devnet faucet (in
the CLI itself):

```bash
export MAGIC_NETWORK=devnet
export MAGIC_WALLET_PATH=~/.config/solana/magic-devnet-test.json
export MAGIC_L1_RPC_URL="<your devnet RPC>"
node dist/index.js faucet
```

Or DM the Flash team on Discord — they can mint test USDC to any pubkey.

### B2. Test WRITES locally first

Same env vars as A5, plus:

```bash
export MAGIC_TEST_RUN_WRITES=1
npm run test:integration
```

This runs the full lifecycle. **Expected duration**: 30–90 seconds. **Expected output**: 8 tests pass (the previously-skipped WRITES test now runs).

**If it fails**, look at the error carefully:
- "INSUFFICIENT_FUNDS" → top up the wallet (B1)
- "ACCOUNT_NOT_INITIALIZED" → run `magic setup` once on the test wallet
- "RPC error" → swap to a different devnet RPC

### B3. Cut a release branch to enable WRITES in CI

The CI workflow auto-enables `MAGIC_TEST_RUN_WRITES=1` on
`release/**` branches:

```bash
git checkout -b release/v0.1.0
git push -u origin release/v0.1.0
```

In Actions, the "Test (integration · devnet)" step on this branch will
include the WRITES test. ~90 s runtime. **If green**, your release path
has chain-truth verified end-to-end.

### B4. (Optional) Re-fund between releases

The test wallet loses ~$0.01–$0.05 per WRITES run (gas + slippage). After
~50 runs you'll need to top up via B1 again. The integration test prints
a warning if the wallet falls below the minimum.

---

## Troubleshooting

**"node --experimental-vm-modules ... ERR_REQUIRE_ESM"**
You probably have an old Node. Use Node 22:
```bash
nvm install 22 && nvm use 22
```

**"Wallet file not readable"**
The integration test enforces mode 0600 on the keypair file:
```bash
chmod 600 ~/.config/solana/magic-devnet-test.json
```

**"AccountNotInitialized" on first WRITES run**
Run `magic setup` once on the test wallet to initialize the user-deposit-
ledger and basket. After that, WRITES runs are idempotent.

**"Pool 'Pool.1' not found"**
Devnet pool config moved. Check the SDK version against the on-chain pool
state:
```bash
node dist/index.js doctor
```

**The base58 conversion script blows up**
Some shells mangle the heredoc. Use a temp file:
```bash
cat > /tmp/conv.mjs <<'EOF'
import bs58 from 'bs58';
import { readFileSync } from 'fs';
const bytes = JSON.parse(readFileSync(process.env.HOME + '/.config/solana/magic-devnet-test.json', 'utf-8'));
process.stdout.write(bs58.encode(Uint8Array.from(bytes)) + '\n');
EOF
node /tmp/conv.mjs
```

---

## What CI does on each branch type

| Branch                  | Reads | Writes | Notes |
|-------------------------|-------|--------|-------|
| `feature/*`, PRs        | ✓     | ✗      | Cheap; runs on every push |
| `master` / `main`       | ✓     | ✗      | Same as above |
| `release/**`            | ✓     | ✓      | Costs a few cents per run |

The reads pipeline catches: SDK version drift, IDL mismatches, pool config
changes, RPC misconfig, ER outage, oracle exponent drift.

The writes pipeline catches: signing-guard regressions, blockhash cache
correctness, sentinel-signature handling, withdraw chain-truth verifier,
deposit/withdraw fee math.

---

## When secrets aren't set (PRs from forks)

The integration test self-skips. CI exits cleanly. No special handling
needed — the test file uses `describe.skipIf(!KEYPAIR_B58 || !DEVNET_RPC)`.
