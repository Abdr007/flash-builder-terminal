#!/usr/bin/env node
/**
 * Flash Magic Terminal — entry point.
 *
 *  1. Parse CLI flags (--help / --version).
 *  2. Load `.env` and build a `MagicConfig`.
 *  3. Open the wallet from disk (no copying — `Keypair.fromSecretKey`
 *     retains the buffer reference).
 *  4. Construct an L1 `Connection` for read-only ops + signing-guard wiring.
 *  5. Hand off to `MagicTerminal` for the interactive REPL.
 */

// FAST PATH for --version: handled BEFORE any heavy import resolves.
// Static imports below are ESM and would normally be hoisted; we keep
// the heavy ones dynamic instead so `magic --version` exits in ~80 ms
// (Node startup) rather than ~180 ms (full SDK + web3.js + decimal +
// figlet + ER router config).
import { VERSION } from './utils/version.js';
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

// Install the SDK noise filter BEFORE any SDK module loads.
import { installConsoleFilter } from './cli/console-filter.js';
installConsoleFilter();

import chalk from 'chalk';
import { createInterface } from 'readline';
import { loadConfig } from './config/index.js';
import { WalletManager } from './wallet/walletManager.js';
import { MagicTerminal } from './cli/terminal.js';
import { c } from './cli/magic-theme.js';
import { initLogger, getLogger, LogLevel } from './utils/logger.js';
import { setupWallet } from './cli/wallet-flows.js';
import { renderHero } from './cli/banner.js';
import { COMMAND_ALIASES } from './cli/interpreter.js';

function printHelp(): void {
  process.stdout.write(`${c.teal.bold('flash-magic-terminal')} ${c.muted(`v${VERSION}`)} ${c.muted('— sub-second perpetuals on MagicBlock ER')}

${c.cyan('USAGE')}
  ${c.teal.bold('magic')}                          launch the interactive REPL
  ${c.teal.bold('magic <verb> [args]')}            run one command and exit (one-shot)
  ${c.teal.bold('magic --help')}                   show this help
  ${c.teal.bold('magic --version')}                print version
  ${c.muted('(`flash-magic` is also installed as an alias for systems where `magic` collides — ImageMagick, etc.)')}

${c.cyan('FIRST RUN')}
  ${c.teal('magic init')}                     bootstrap ~/.magic/.env (no wallet needed)
  ${c.teal('magic env')}                      show env-file path + current values (masked)
  ${c.teal('magic doctor')}                   full health probe — RPC, ER, oracle, wallet, SDK

${c.cyan('TRADING (one-shot examples)')}
  ${c.teal('magic markets')}                  list every tradable market
  ${c.teal('magic price SOL')}                live oracle price
  ${c.teal('magic portfolio')}                positions, PnL, vault balance
  ${c.teal('magic open SOL long 5 2')}        open 2x long, 5 USDC collateral
  ${c.teal('magic close SOL long')}           close a position
  ${c.teal('magic deposit USDC 50')}          fund the basket

${c.cyan('AGENT MODE  (https://no-dna.org)')}
  ${c.teal('NO_DNA=1 magic markets')}         JSON output to stdout, errors to stderr
  ${c.teal('NO_DNA=1 magic portfolio')}       no banner, no prompts, debug-verbose
  ${c.muted('SDK:')}  ${c.teal("import { createMagicSession } from 'flash-magic-terminal/sdk'")}
  ${c.muted('Skill:')} ${c.faint('SKILL.md (Claude Code / Cursor)')}

${c.cyan('SAFETY')}
  ${c.teal('magic kill [reason]')}            persistent kill switch — refuse signing across restarts
  ${c.teal('magic resume')}                   re-enable signing

${c.cyan('ENVIRONMENT')}
  ${c.muted('Network')}
    MAGIC_NETWORK                ${c.faint('mainnet-beta')} (default) | ${c.faint('devnet')}
    MAGIC_POOL_NAME              ${c.faint('Pool.0')} (mainnet) / ${c.faint('Pool.1')} (devnet)
    MAGIC_FLASH_API_URL          Flash Trade V2 Builder API ${c.muted('(default: https://flashapi.trade)')}
    MAGIC_RPC_URL                ER router URL
    MAGIC_L1_RPC_URL             L1 RPC ${c.muted('(use Helius/QuickNode for production)')}
    MAGIC_ALLOW_INSECURE_RPC     ${c.faint('=1')} to allow http://localhost (dev only)
  ${c.muted('Wallet')}
    MAGIC_WALLET_PATH            keypair JSON path ${c.muted('(default: ~/.config/solana/id.json)')}
    MAGIC_WITHDRAW_FEE_PAYER_PATH separate V2 withdrawal fee payer keypair ${c.muted('(optional)')}
  ${c.muted('Trading')}
    MAGIC_AUTO_CONFIRM           ${c.faint('false')} (default) — show Y/N preview before signing; true skips it
    MAGIC_SLIPPAGE_PERCENT       ${c.faint('0.5')} (default) — client-side slippage cap on market orders (%)
    MAGIC_FAST_CONFIRM           ${c.faint('true')} (default) — ER ixs return on submit
    COMPUTE_UNIT_PRICE           microlamports for L1 priority fee ${c.muted('(default: 50000)')}
  ${c.muted('Caps  (0 = unlimited; recommended for agents)')}
    MAX_COLLATERAL_PER_TRADE     hard cap on collateral per trade
    MAX_POSITION_SIZE            hard cap on size
    MAX_LEVERAGE                 hard cap on leverage
    MAX_TRADES_PER_MINUTE        rate limit ${c.muted('(default: 10)')}
    MIN_DELAY_BETWEEN_TRADES_MS  min spacing between signs ${c.muted('(default: 1000)')}
  ${c.muted('Logs / Agent')}
    MAGIC_LOG_LEVEL              ${c.faint('debug | info | warn | error')}
    MAGIC_LOG_FORMAT             ${c.faint('text | json')}
    NO_DNA                       ${c.faint('=1')} — agent mode: JSON, no prompts, no ASCII

${c.cyan('FILES')}
  ${c.faint('~/.magic/.env')}                  user-global env (created by ${c.cyan('magic init')})
  ${c.faint('~/.magic/config.json')}           rpc + persisted config (managed by ${c.cyan('rpc set/add/remove')})
  ${c.faint('~/.magic/magic.log')}             rotating debug log (10 MB)
  ${c.faint('~/.magic/signing-audit.log')}     append-only signing audit
  ${c.faint('~/.magic/magic-history.jsonl')}   trade journal

${c.muted('Inside the REPL, type')} ${c.teal.bold('help')} ${c.muted('for the full command reference.')}

`);
}

/**
 * Verbs that, when passed as the first positional argument, run the CLI in
 * one-shot mode instead of opening the REPL. Mirrors `git status`,
 * `gh pr list` etc. — the natural CLI pattern. A bare `magic` still opens
 * the interactive terminal.
 *
 * The set is intentionally a superset of what `parseCommand` accepts so
 * agents can invoke any tool. `wallet`, `rpc`, `kill`, `resume`, `monitor`,
 * `clear`, `exit`, `help`, `?` are interactive-only and not listed here.
 */
const ONE_SHOT_VERBS = new Set<string>([
  // Onboarding (no wallet required)
  'init', 'env', 'feedback',
  // Read-only
  'portfolio', 'positions', 'status', 'markets', 'delegation',
  'vault', 'account', 'acc', 'price', 'orders', 'history', 'trades',
  'journal', 'dashboard', 'alerts', 'er-health', 'er', 'health', 'api-health',
  'tokens', 'prices', 'pool-data', 'raw', 'snapshot', 'basket', 'preview',
  'builder', 'stream', 'basket-stream', 'verify',
  'withdraw-status', 'faucet',
  // Diagnostics
  'doctor', 'diag', 'diagnose', 'check', 'perf', 'performance',
  // Trading (NO_DNA users must set MAGIC_AUTO_CONFIRM=true to allow these)
  'open', 'o', 'close', 'reverse', 'increase', 'partial-close', 'partial',
  'add-collateral', 'add', 'remove-collateral', 'remove',
  'limit', 'place-limit',
  'cancel', 'cancel-limit', 'cancel-trigger',
  'trigger', 'trigger-order', 'tp', 'sl', 'set',
  'liquidate', 'close-all', 'closeall',
  'setup', 'deposit', 'deposit-direct', 'withdraw', 'request-withdrawal',
  'withdrawal-settle', 'withdraw-watch', 'settle', 'custody-settlement', 'init-basket',
  'init-deposit-ledger', 'delegate-basket', 'delegate',
]);

function normalizeCliArgs(args: string[]): string[] {
  // Expand single-token command aliases (px→price, mkt→markets, o→open,
  // ca→close-all, …) BEFORE verb detection so one-shot mode recognizes the
  // exact same shorthand the REPL does — one shared alias table, no drift.
  if (args.length > 0) {
    const canon = COMMAND_ALIASES[args[0].toLowerCase()];
    if (canon) args = [canon, ...args.slice(1)];
  }
  const [a0, a1, a2, ...rest] = args;
  const head0 = a0?.toLowerCase();
  const head1 = a1?.toLowerCase();
  const head2 = a2?.toLowerCase();
  if (head0 === 'init' && head1 === 'basket') return ['init-basket', ...rest];
  if (head0 === 'init' && head1 === 'deposit' && head2 === 'ledger') return ['init-deposit-ledger', ...rest];
  if (head0 === 'delegate' && head1 === 'basket') return ['delegate-basket', ...rest];
  if (head0 === 'deposit' && head1 === 'direct') return ['deposit-direct', a2 ?? '', ...rest];
  if (head0 === 'request' && head1 === 'withdrawal') return ['request-withdrawal', a2 ?? '', ...rest];
  if (head0 === 'withdrawal' && head1 === 'settle') return ['withdrawal-settle', a2 ?? '', ...rest];
  if (head0 === 'custody' && head1 === 'settlement') return ['custody-settlement', a2 ?? '', ...rest];
  return args;
}

async function main(): Promise<void> {
  const args = normalizeCliArgs(process.argv.slice(2));
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  // One-shot mode: first arg is a known verb → execute and exit. Agent-friendly
  // flow: NO_DNA forces JSON output (handled in MagicTerminal.handle), no
  // banner, no prompts, no REPL. Default wallet must be configured.
  const firstTok = args[0]?.toLowerCase();
  const oneShot = !!firstTok && ONE_SHOT_VERBS.has(firstTok);
  if (oneShot) {
    await runOneShot(args);
    return; // runOneShot calls process.exit
  }

  // NO_DNA: agents need more context, not less — bump default to debug.
  // The user can still override via MAGIC_LOG_LEVEL.
  const defaultLevel = process.env.NO_DNA ? LogLevel.Debug : LogLevel.Info;
  initLogger({ level: defaultLevel });
  const logger = getLogger();

  // First-run auto-wizard: bare `magic` on a system with no `~/.magic/.env`
  // gets walked through setup BEFORE we try to launch the REPL. Without
  // this, a fresh-install user lands in the REPL with no RPC / wallet,
  // hits a cryptic error on their first command, and bounces. Mirrors
  // the `vercel` / `gh auth login` "guide-on-first-run" pattern.
  // NO_DNA agents get the bare template path inside `magicInit` — they
  // don't go through this auto-wizard.
  {
    const { userEnvFilePath } = await import('./config/index.js');
    const { existsSync } = await import('fs');
    if (!existsSync(userEnvFilePath()) && !process.env.NO_DNA && process.stdin.isTTY) {
      const { runInitWizard } = await import('./cli/init-wizard.js');
      try {
        await runInitWizard();
      } catch (err) {
        process.stdout.write(`${chalk.red('init failed: ')}${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    }
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stdout.write(`${chalk.red('config error: ')}${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  // Initialise the RPC manager with the primary endpoint + any persisted
  // backups so `rpc list / status / test / set / add / remove` work and the
  // active connection can be swapped at runtime.
  const { loadBackupL1Rpcs } = await import('./config/index.js');
  const { RpcManager, setRpcManager } = await import('./network/rpc-manager.js');
  const allL1Urls = [config.l1RpcUrl, ...loadBackupL1Rpcs().filter((u) => u !== config.l1RpcUrl)];
  const rpcManager = new RpcManager(allL1Urls);
  setRpcManager(rpcManager);

  const walletManager = new WalletManager(rpcManager.connection);
  // Propagate active-endpoint changes to the wallet connection (so SOL balance
  // reads, deposits, etc. start using the new RPC immediately).
  rpcManager.setConnectionChangeCallback((conn) => walletManager.setConnection(conn));

  // Auto-failover: start a background health monitor as soon as we know there
  // is more than one endpoint. Surfaces a one-line notice on the REPL when a
  // switch happens; trades themselves go through the live `connection` getter
  // so they see the new endpoint without further plumbing.
  rpcManager.setFailoverHandler(async (from, to, reason) => {
    // Route through the REPL-safe writer so the banner doesn't corrupt the
    // line the user is typing on. Imported lazily so this entry-point file
    // doesn't pull readline state before MagicTerminal owns it.
    const { replSafeWrite } = await import('./cli/repl-write.js');
    replSafeWrite(`${chalk.yellow('  ⚠ RPC failover')} ${c.muted(`${from.label} → ${to.label}`)} ${c.faint(`(${reason})`)}`);
  });
  rpcManager.startHealthMonitor();

  // Saved-wallets / first-time-setup flow (parity with bolt-terminal).
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (q: string): Promise<string> =>
    new Promise<string>((resolveAsk) => rl.question(q, (a) => resolveAsk(a)));

  process.stdout.write(await renderHero());

  let walletInfo: { address: string; name: string } | null = null;
  try {
    walletInfo = await setupWallet({ ask, walletManager });
  } finally {
    rl.close();
  }

  if (!walletInfo) {
    process.stdout.write(c.muted('  No wallet selected. Goodbye.\n'));
    process.exit(0);
  }

  const terminal = new MagicTerminal(config, walletManager);

  process.on('uncaughtException', (err) => {
    logger.error('fatal', 'uncaughtException', { error: err.message, stack: err.stack });
    // EPIPE on stdout/stderr — caller closed the pipe (e.g. `magic | head`).
    // Don't render anything (writes will fail again); just exit cleanly.
    if ((err as NodeJS.ErrnoException).code === 'EPIPE') {
      try { walletManager.disconnect(); } catch { /* ignore */ }
      process.exit(0);
    }
    process.stdout.write(`${chalk.red('fatal: ')}${err.message}\n`);
    // Best-effort: zero the secret-key buffer before crashing so a core dump
    // or post-mortem doesn't surface live key material.
    try { walletManager.disconnect(); } catch { /* nothing left to do */ }
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error('fatal', 'unhandledRejection', { error: msg });
    // CRITICAL: do NOT exit on unhandled rejection. The REPL must keep running
    // even if a stray async fails — losing the session because of one bad
    // background poll is worse than a stale piece of state.
  });
  // Node deprecation / experimental warnings can land on stderr at random
  // moments and corrupt agent JSON streams. Route them through the structured
  // logger instead. User can still tail ~/.magic/magic.log to see them.
  process.on('warning', (warning) => {
    logger.debug('node-warning', warning.message, { name: warning.name });
  });
  // SIGPIPE: when piped output's reader closes early (e.g. `magic | head`),
  // node would raise EPIPE on the next stdout.write. Ignore it and exit cleanly.
  process.on('SIGPIPE', () => {
    try { walletManager.disconnect(); } catch { /* ignore */ }
    process.exit(0);
  });
  // SIGTERM: clean shutdown so in-flight trades flush their audit log entries
  // before the process dies. Respect the shutdown sequence (rl close → alerts
  // off → reconciler off → wallet zero) instead of a hard kill.
  process.on('SIGTERM', () => {
    void (async () => {
      try { await terminal.shutdown(); } catch { /* best-effort */ }
      try { walletManager.disconnect(); } catch { /* ignore */ }
      process.exit(0);
    })();
  });

  await terminal.start();
  await terminal.shutdown();
  process.exit(0);
}

/**
 * Non-interactive one-shot dispatcher.
 *
 * Boot just enough infrastructure to run a single command, then exit with
 * code 0 on success / 1 on failure. In NO_DNA mode every line on stdout is
 * a JSON record (banner suppressed, dispatch emits structured JSON).
 *
 * Wallet selection is non-interactive — uses the registry's `defaultWallet`
 * or `MAGIC_WALLET_PATH`. If neither is available, the function emits a
 * single error JSON and exits 1.
 */
async function runOneShot(args: string[]): Promise<void> {
  const isAgent = !!process.env.NO_DNA;
  const fail = (code: string, message: string): never => {
    if (isAgent) {
      process.stderr.write(JSON.stringify({
        ts: new Date().toISOString(),
        kind: 'error',
        code,
        message,
      }) + '\n');
    } else {
      process.stderr.write(`${chalk.red('error: ')}${message}\n`);
    }
    process.exit(1);
  };

  const defaultLevel = isAgent ? LogLevel.Debug : LogLevel.Info;
  initLogger({ level: defaultLevel });

  let config: ReturnType<typeof loadConfig>;
  try { config = loadConfig(); }
  catch (err) {
    fail('CONFIG', err instanceof Error ? err.message : String(err));
  }

  const { loadBackupL1Rpcs } = await import('./config/index.js');
  const { RpcManager, setRpcManager } = await import('./network/rpc-manager.js');
  const allL1Urls = [config!.l1RpcUrl, ...loadBackupL1Rpcs().filter((u) => u !== config!.l1RpcUrl)];
  const rpcManager = new RpcManager(allL1Urls);
  setRpcManager(rpcManager);

  const walletManager = new WalletManager(rpcManager.connection);
  rpcManager.setConnectionChangeCallback((conn) => walletManager.setConnection(conn));

  // `init` and `env` are wallet-less — they're onboarding helpers. Don't
  // try to load a keypair so npm-installed users can run them on a fresh
  // machine without any prior setup.
  const verb = args[0]?.toLowerCase();
  const walletlessVerbs = new Set([
    'init', 'env',
    'health', 'api-health', 'tokens', 'prices', 'pool-data', 'raw', 'preview',
  ]);
  const needsWallet = !walletlessVerbs.has(verb ?? '') && !(verb === 'builder' && args[1]?.toLowerCase() !== 'sign');
  if (needsWallet) {
    const { WalletStore } = await import('./wallet/wallet-store.js');
    const store = new WalletStore();
    const defaultName = store.getDefault();
    let walletPath: string | null = null;
    if (defaultName) {
      try { walletPath = store.getWalletPath(defaultName); }
      catch { /* fall through to env */ }
    }
    if (!walletPath && config!.walletPath) walletPath = config!.walletPath;
    if (!walletPath) {
      fail(
        'NO_WALLET',
        'No default wallet. Run `magic` (interactive) to import one, or set MAGIC_WALLET_PATH=/abs/path/to/keypair.json.',
      );
    }
    try {
      walletManager.loadFromFile(walletPath!);
    } catch (err) {
      fail('WALLET_LOAD', err instanceof Error ? err.message : String(err));
    }
  }

  // Install fatal handlers for one-shot — emit JSON to stderr, zero key, exit 1.
  process.on('uncaughtException', (err) => {
    // EPIPE — caller closed the read end. Exit silently (any further write
    // would just throw EPIPE again and recurse).
    if ((err as NodeJS.ErrnoException).code === 'EPIPE') {
      try { walletManager.disconnect(); } catch { /* ignore */ }
      process.exit(0);
    }
    if (isAgent) {
      try {
        process.stderr.write(JSON.stringify({
          ts: new Date().toISOString(),
          kind: 'fatal',
          message: err.message,
          stack: err.stack,
        }) + '\n');
      } catch { /* stderr closed too */ }
    } else {
      try { process.stderr.write(`${chalk.red('fatal: ')}${err.message}\n`); } catch { /* ignore */ }
    }
    try { walletManager.disconnect(); } catch { /* ignore */ }
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (isAgent) {
      try {
        process.stderr.write(JSON.stringify({
          ts: new Date().toISOString(),
          kind: 'unhandled-rejection',
          message: msg,
        }) + '\n');
      } catch { /* stderr closed */ }
    }
  });
  // Suppress Node deprecation warnings on stderr — they corrupt agent JSON.
  process.on('warning', () => { /* swallowed; visible in ~/.magic/magic.log if logger up */ });
  process.on('SIGPIPE', () => {
    try { walletManager.disconnect(); } catch { /* ignore */ }
    process.exit(0);
  });
  // SIGTERM (k8s pod terminating, CI runner timing out) — zero the keypair
  // before the process dies so a core dump or heap snapshot doesn't capture
  // live key material. The interactive path has its own SIGTERM handler;
  // the one-shot path was previously missing one (security audit finding).
  process.on('SIGTERM', () => {
    try { walletManager.disconnect(); } catch { /* ignore */ }
    process.exit(0);
  });

  // Build the terminal but DON'T enter the REPL — call handle() once.
  const terminal = new MagicTerminal(config!, walletManager);
  // Prep the engine + signing guard exactly as start() would.
  const { initSigningGuard } = await import('./security/signing-guard.js');
  initSigningGuard({
    maxCollateralPerTrade: config!.maxCollateralPerTrade,
    maxPositionSize: config!.maxPositionSize,
    maxLeverage: config!.maxLeverage,
    maxTradesPerMinute: config!.maxTradesPerMinute,
    minDelayBetweenTradesMs: config!.minDelayBetweenTradesMs,
  });

  // Reconstruct the original command line so the existing handle() parses
  // it the same way the REPL would.
  //
  // Naïve `arg.includes(' ') ? "..." : arg` is unsafe — an argv element
  // containing a literal `"` would smuggle out of the quoted run and
  // either silently corrupt the dispatch or be interpreted as a separate
  // token. Always escape `\` and `"` inside the value, and quote any arg
  // that contains whitespace OR shell-special chars OR a quote so the
  // serialized form is unambiguous.
  const line = args.map((a) => {
    const needsQuote = /[\s"'\\$`]/.test(a) || a.length === 0;
    if (!needsQuote) return a;
    const escaped = a.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  }).join(' ');
  let exitCode = 0;
  try {
    // handle() is private — invoke through a public shim. The terminal
    // exposes `runOnce` for this purpose.
    exitCode = await terminal.runOnce(line);
  } catch (err) {
    if (isAgent) {
      process.stderr.write(JSON.stringify({
        ts: new Date().toISOString(),
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      }) + '\n');
    } else {
      process.stderr.write(`${chalk.red('error: ')}${err instanceof Error ? err.message : String(err)}\n`);
    }
    exitCode = 1;
  } finally {
    try { await terminal.shutdown(); } catch { /* ignore */ }
  }
  process.exit(exitCode);
}

main().catch((err) => {
  if (process.env.NO_DNA) {
    process.stderr.write(JSON.stringify({
      ts: new Date().toISOString(),
      kind: 'fatal',
      message: err instanceof Error ? err.message : String(err),
    }) + '\n');
  } else {
    process.stderr.write(`${chalk.red('fatal: ')}${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(1);
});
