# Flash Magic Terminal — Agent Skill

Sub-second perpetuals trading on Flash Magic Trade (MagicBlock ER). This file
tells AI agents (Claude Code, Cursor, scripted automations) how to drive the
CLI safely. Humans should read `README.md` instead.

## Set the agent flag

Always invoke the CLI with `NO_DNA=1` (https://no-dna.org). It switches the
binary to JSON output, suppresses ASCII art, refuses interactive prompts,
sends all errors to stderr, and bumps logging to debug.

```bash
NO_DNA=1 magic markets
```

If you are responsible for an agent framework, set `NO_DNA=1` in the shell
environment so users don't have to remember it.

## Two ways to drive it

### A. One-shot CLI (simplest)

`magic <verb> <args>` runs the verb once and exits. Output is one JSON
record per line on stdout (`kind: "result"`) and one JSON line on stderr
for fatal errors (`kind: "error"` / `"fatal"`). Exit code is `0` on success
and `1` on failure.

```bash
NO_DNA=1 magic portfolio
NO_DNA=1 magic markets crypto
NO_DNA=1 MAGIC_AUTO_CONFIRM=true magic open SOL long 5 2
NO_DNA=1 magic close SOL long
NO_DNA=1 magic price BTC
```

The `result` record:

```json
{
  "ts": "2026-05-06T18:23:11.142Z",
  "kind": "result",
  "alias": "open",
  "success": true,
  "message": "<human-readable card; ignore in agent code>",
  "elapsedMs": 247,
  "txSignature": "5xT...zQ",
  "data": { "...": "tool-specific" }
}
```

Always parse `success` and `data` — don't regex `message`.

### B. Programmatic SDK (typed, in-process)

```ts
import { createMagicSession, TradeSide, TradingError, GuardError } from 'flash-magic-terminal/sdk';

const magic = await createMagicSession({
  walletKeypairPath: process.env.MAGIC_WALLET_PATH,
  network: 'mainnet-beta',
  // Per-call caps (override env / config.json).
  maxCollateralPerTrade: 100,
  maxLeverage: 5,
});

try {
  const portfolio = await magic.getPortfolio();
  if (portfolio.positions.length === 0) {
    const result = await magic.openPosition('SOL', TradeSide.Long, 50, 2);
    console.log('opened', result.txSignature);
  }
} catch (err) {
  if (err instanceof GuardError)   { /* per-trade cap hit, kill switch on, … */ }
  if (err instanceof TradingError) { /* program rejected the trade — see err.anchorName */ }
  throw err;
} finally {
  await magic.shutdown();
}
```

All methods are bound to the underlying `MagicTradeClient` — no string
parsing, full TypeScript types, same hardened paths the CLI uses.

## Required environment

| Variable | Purpose |
|---|---|
| `MAGIC_NETWORK` | `mainnet-beta` or `devnet` (default mainnet-beta) |
| `MAGIC_WALLET_PATH` | Absolute path to a Solana CLI-format keypair JSON. Required for one-shot mode if no default wallet has been registered. Mode must be `0600`. |
| `MAGIC_AUTO_CONFIRM` | `true` to allow signing without prompts (REQUIRED for agent signing). When `false`, NO_DNA mode refuses signing rather than prompting. |
| `MAGIC_RPC_URL` | ER router URL. Default is the public Magic Block ER endpoint. |
| `MAGIC_L1_RPC_URL` | L1 RPC. **Use a paid endpoint** for any agent that signs at meaningful frequency — public RPCs rate-limit and reject `simulateTransaction`. |
| `NO_DNA` | Set to anything non-empty to enable agent mode. |

## Safety surface

The CLI ships with multiple defense-in-depth guards. Agents should respect
them, not work around them:

- **Per-trade caps** (`MAX_COLLATERAL_PER_TRADE`, `MAX_LEVERAGE`,
  `MAX_POSITION_SIZE`) — set these to your agent's authorized risk
  envelope. Trades exceeding caps throw `GuardError`.
- **Rate limit** (`MAX_TRADES_PER_MINUTE`, `MIN_DELAY_BETWEEN_TRADES_MS`)
  — back off on `GuardError` with reason `Rate limited`.
- **Kill switch** — `magic kill [reason]` sets `~/.magic/disabled` and
  refuses every signing path until `magic resume`. Survives restarts and
  applies cross-process. Use this as your "emergency stop". Programmatic
  equivalents: `killSwitchOn(reason)` / `killSwitchOff()` exported from
  the SDK.
- **Audit log** — every signing attempt (confirmed, rejected, failed,
  rate-limited) writes a JSON line to `~/.magic/signing-audit.log`.
- **Trade journal** — every successful trade writes a JSON line to
  `~/.magic/magic-history.jsonl`. Read with `magic history`.
- **Program allowlist** — every instruction is validated against a
  whitelist before signing. Tampered SDK builds rejected.
- **Validators** — every URL (RPC, ER, webhook) goes through
  `validateRpcUrl` / `validateWebhookUrl` to reject embedded credentials,
  non-https, loopback, and RFC1918 / mDNS / link-local hosts.

## Errors are typed

When using the SDK, branch on `instanceof`:

- `ValidationError` — input failed validation (invalid market, NaN
  collateral, etc.). User error; safe to render directly.
- `ConfigError` — missing or malformed env / config / keypair. Fix
  configuration and retry.
- `NetworkError` — RPC / Hermes / ER call failed. Retry-friendly.
- `TradingError` — program rejected the trade. Inspect `.anchorName` /
  `.anchorCode` to branch on specific failures (`AccountNotInitialized`,
  `InsufficientCollateral`, `MaxLeverage`, `CloseOnlyMode`, etc.).
- `GuardError` — a safety guard refused. Wait or reconfigure.
- `AssertionError` — internal invariant violation. Report as a bug.

`describeErrorChain(err)` walks `err.cause` and produces a single-line
summary.

## Return shapes you'll touch most often

```ts
type OpenPositionResult = {
  txSignature: string;
  entryPrice: number;
  liquidationPrice: number;
  sizeUsd: number;
  feeUsd?: number;          // open fee in USD
  lockSymbol?: string;       // e.g. 'USDC' for stable longs, 'SOL' for SOL longs
  swapRequired?: boolean;    // true if pay token != lock token
};

type Portfolio = {
  positions: Position[];
  balanceUsd: number;
  totalUnrealizedPnl: number;
};

type Position = {
  market: string;            // 'SOL'
  side: 'long' | 'short';
  collateralUsd: number;
  sizeUsd: number;
  leverage: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  unrealizedPnl: number;
};
```

Full types in `dist/types/index.d.ts`.

## Patterns

### Place a position with TP/SL atomically

```ts
const r = await magic.openPosition(
  'SOL',
  TradeSide.Long,
  /* collateralUsd */ 50,
  /* leverage    */ 2,
  /* collateralToken */ 'USDC',
  /* tp */ 250,
  /* sl */ 150,
);
```

The CLI bundles the TP and SL trigger orders into the same ER tx as the
open, so they land atomically. Skip `tp`/`sl` and call `placeTrigger`
afterward if you need separate placement.

### Detect "nothing to do"

`getPortfolio()` returns `positions: []` and `balanceUsd: 0` for fresh
wallets. Don't treat empty as failure.

### React to stale prices

`fetchOraclePrice(symbol)` returns the chain's current oracle for a market.
Combine with `getPositions().markPrice` to sanity-check before sizing a
trade against a fast-moving market.

### Idempotent setup

```ts
await magic.initializeUserDepositLedger();   // returns 'already_initialised' if done
await magic.initializeBasket();              // same
await magic.delegateBasket();                // returns existing basket if already delegated
```

Safe to call on every agent boot.

## Limits and gotchas

- **Single-process wallet hold**: only one process at a time should hold
  a given keypair. Two parallel agents with the same wallet will race the
  per-process rate limit and basket reads.
- **Devnet free RPC** rejects `simulateTransaction` — many SDK helpers
  fail. Use a paid devnet RPC if you need the full surface.
- **Kill switch is global to the user account** — turning it on stops
  every running agent on this machine. By design.
- **`MAGIC_AUTO_CONFIRM=false` + `NO_DNA=1` = sign refused.** The CLI
  cannot prompt in agent mode, so it fails closed. Set `MAGIC_AUTO_CONFIRM=true`
  to opt into agent signing.
- **The CLI is CommonJS-incompatible**. Pure ESM. Importers must use
  `import` syntax (or `await import()` from CJS).

## Rapid sanity check

```bash
npx tsx scripts/probe-devnet-smoke.ts   # 11 read-only checks against devnet pool
npx tsx scripts/probe-stress.ts         # 22 in-process stress tests
```

Both should print `passed, 0 failed`. They don't sign anything.

## Reporting issues

Open an issue at https://github.com/Abdr007/flash-magic-terminal/issues.
Include the command, the JSON output, and `~/.magic/magic.log` (debug
level when `NO_DNA=1`).
