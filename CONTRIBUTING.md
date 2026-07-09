# Contributing to Flash Magic Terminal

Thanks for being here. This project moves fast and we keep the bar high — please read this guide before opening a PR.

## Ground rules

1. **No keys, ever.** Don't commit `.env`, wallet JSON, or anything containing secret material. Pre-commit hygiene is on you.
2. **Strict TypeScript.** No `any` unless you have a documented reason and a comment explaining why.
3. **Parser changes need tests.** If you touch `src/cli/interpreter.ts` or `src/cli/terminal.ts:parseCommand`, add a row to `test/dispatch.test.ts`.
4. **Don't break the hot path.** Anything inside `magic-client.ts:openPosition / closePosition / reverse` is latency-critical — measure before and after with the probe scripts in `scripts/`.

## Local dev

```bash
git clone https://github.com/Abdr007/flash-magic-terminal.git
cd flash-magic-terminal
npm install
npm run dev          # tsx watch mode
```

Useful scripts:

```bash
npm run typecheck    # strict TS, no emit
npm run lint         # ESLint
npm test             # vitest dispatch matrix (~116 cases)
npm run build        # tsc + chmod
```

Probe scripts hit live ER / Pyth — only run with a wallet you control:

```bash
npx tsx scripts/probe-oi.ts
npx tsx scripts/probe-monitor-data.ts
npx tsx scripts/probe-trade-gate.ts
```

## Workflow

1. **Fork → branch.** Branch name in the form `feat/<thing>`, `fix/<thing>`, `chore/<thing>`.
2. **Small commits, present-tense imperative.** `add atomic reverse fallback` not `added`.
3. **Open a PR against `master`.** Fill in the template — what / why / how tested.
4. **CI must be green.** Build, typecheck, test all run on Node 22.

## Code style

- Files under `src/` are ES modules (`.ts`), no CommonJS.
- Prefer explicit types on exported functions — implicit on internal locals.
- Trade flow goes through `signing-guard.ts`. Don't call `sendTransaction` outside `magic-client.ts`.
- Wallet flows go through `walletManager.ts`. Don't read keypair files anywhere else.
- RPC flows go through `rpc-manager.ts`. Don't `new Connection(url)` inline.

## Reporting bugs

See [SECURITY.md](./SECURITY.md) for vulnerabilities. Functional bugs go in GitHub issues with:

- Exact command typed
- Expected vs actual
- `magic` version (`npm pkg get version`)
- OS + Node version

## Code of Conduct

By contributing you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).
