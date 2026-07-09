/**
 * Config loader.
 *
 * Precedence: CLI flag (handled in cli/terminal.ts) > env > defaults.
 * Always loads `.env` on startup if present (no override of process.env).
 */

import { config as loadDotenv } from 'dotenv';
import { homedir } from 'os';
import { resolve, isAbsolute } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync } from 'fs';
import type { MagicConfig } from '../types/index.js';
import { safeEnvBool, safeEnvBoolStrict, safeEnvNumber, safeEnvString } from '../utils/safe-env.js';

// ─── Config file (~/.magic/config.json) ──────────────────────────────────────
// Precedence: env vars > config.json > defaults.

interface ConfigFileData {
  l1_rpc_url?: string;
  backup_l1_rpc_urls?: string[];
  er_rpc_url?: string;
  flash_api_url?: string;
  network?: string;
  pool_name?: string;
  program_id?: string;
  withdraw_fee_payer_path?: string;
  withdraw_fee_payer_top_up_lamports?: number;
  compute_unit_price?: number;
  max_collateral_per_trade?: number;
  max_position_size?: number;
  max_leverage?: number;
  max_trades_per_minute?: number;
  min_delay_between_trades_ms?: number;
  auto_confirm?: boolean;
  fast_confirm?: boolean;
}

const CONFIG_PATH = resolve(homedir(), '.magic', 'config.json');

// Hard cap so a corrupt or attacker-planted config can't OOM the process at
// JSON.parse time. The legitimate config is small (a handful of strings +
// numbers + a backup-rpc list) — 256 KiB is ~10× the largest sane config.
const CONFIG_MAX_BYTES = 256 * 1024;

function loadConfigFile(): ConfigFileData {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    // Stat first — refuse oversized files BEFORE reading. Without this
    // guard, a multi-GB symlink-target or a malicious replacement could
    // exhaust memory in JSON.parse.
    const st = statSync(CONFIG_PATH);
    if (!st.isFile()) return {};
    if (st.size > CONFIG_MAX_BYTES) return {};
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as ConfigFileData;
  } catch {
    return {};
  }
}

/** Persist a single field to ~/.magic/config.json (merge with existing). */
export function saveConfigField(key: keyof ConfigFileData | string, value: unknown): void {
  let data: Record<string, unknown> = {};
  try {
    if (existsSync(CONFIG_PATH)) {
      const st = statSync(CONFIG_PATH);
      if (st.isFile() && st.size <= CONFIG_MAX_BYTES) {
        const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          data = parsed as Record<string, unknown>;
        }
      }
    }
  } catch {
    /* fresh file */
  }
  if (value === undefined) delete data[key];
  else data[key] = value;
  // mode 0700 on the dir + 0600 on the file — config.json routinely stores
  // RPC URLs that contain api keys (Helius / Triton / QuickNode). Default
  // umask 022 would write 0644 (world-readable). Explicit modes prevent
  // a credential leak on shared hosts.
  mkdirSync(resolve(homedir(), '.magic'), { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  // Retroactively chmod in case the file was created by a prior version
  // without an explicit mode. Best-effort; never blocks the write.
  try { chmodSync(CONFIG_PATH, 0o600); } catch { /* best-effort */ }
}

/**
 * Read backup RPC list from config.json. Each URL is run through
 * `validateRpcUrl` before being returned — an attacker who manages to write
 * to ~/.magic/config.json (or a future buggy `rpc add` that bypasses
 * validation) cannot inject http://, javascript:, or credential-bearing URLs
 * into the failover pool.
 */
export function loadBackupL1Rpcs(): string[] {
  const file = loadConfigFile();
  if (!Array.isArray(file.backup_l1_rpc_urls)) return [];
  const safe: string[] = [];
  for (const raw of file.backup_l1_rpc_urls) {
    if (typeof raw !== 'string') continue;
    try {
      safe.push(validateRpcUrl(raw, 'backup_l1_rpc_urls'));
    } catch {
      // Drop invalid entries silently — the user can re-add via `rpc add`.
    }
  }
  return safe;
}

// On-chain constants (verified from SDK PoolConfig.json + on-chain reads).
export const MAGIC_TRADE_PROGRAM_ID_MAINNET = 'FTv2RxXarPfNta45HTTMVaGvjzsGg27FXJ3hEKWBhrzV';
export const MAGIC_TRADE_PROGRAM_ID_DEVNET = 'FMTgsEDaPPfJi1PKD67McLTC5n833T4irbBP53LLxtvj';
export const MAGIC_ROUTER_URL_MAINNET = 'https://flashtrade.magicblock.app/';
export const MAGIC_ROUTER_URL_DEVNET = 'https://devnet-router.magicblock.app/';
export const FLASH_V2_API_URL = 'https://flashapi.trade';
export const MAGIC_POOL_NAME_MAINNET = 'Pool.0';
export const MAGIC_POOL_NAME_DEVNET = 'Pool.1';
export const DEFAULT_L1_RPC_MAINNET = 'https://api.mainnet-beta.solana.com';
export const DEFAULT_L1_RPC_DEVNET = 'https://api.devnet.solana.com';

let _dotenvLoaded = false;
/**
 * Resolve and apply env files in precedence order:
 *   1. `./.env` (project-local, highest priority — `dotenv` default)
 *   2. `~/.magic/.env` (user-global fallback so npm-installed users have a
 *      stable home for their config without needing a project dir)
 *   3. `~/.magic/config.json` is loaded separately by `loadConfigFile()`.
 *
 * Process env vars set by the shell ALWAYS win — both files only set keys
 * that aren't already in `process.env` (dotenv's default behavior).
 */
function loadEnvOnce(): void {
  if (_dotenvLoaded) return;
  // Project-local first (closest to where the user is).
  loadDotenv();
  // User-global fallback.
  const userEnv = resolve(homedir(), '.magic', '.env');
  if (existsSync(userEnv)) loadDotenv({ path: userEnv });
  _dotenvLoaded = true;
}

/** Public path getters so the CLI's `env` / `init` commands can show locations. */
export function userEnvFilePath(): string {
  return resolve(homedir(), '.magic', '.env');
}
export function userConfigPath(): string {
  return CONFIG_PATH;
}

/**
 * Rewrite a single `KEY=value` line in ~/.magic/.env. Used by `rpc set`
 * and friends so a stale .env line doesn't override fresh config.json
 * persistence on the next boot. Returns true iff the file was edited.
 *
 *  - If KEY is present uncommented: replace the value (so it now matches).
 *  - If KEY is present but commented out: leave it alone (config.json wins,
 *    which is what we want).
 *  - If KEY is absent: leave the file alone (config.json will provide it).
 *  - If the file doesn't exist: no-op.
 *
 * The "leave it alone when commented" rule is critical — once a user has
 * run \`rpc set\`, we don't want to keep adding lines to .env or surprise
 * them by uncommenting things. The user-controlled comment state is
 * authoritative.
 */
export function syncEnvLine(key: string, value: string): boolean {
  const path = userEnvFilePath();
  if (!existsSync(path)) return false;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  const lines = text.split('\n');
  let changed = false;
  // Match `KEY=...` at line start, NOT preceded by `#`. Allow leading
  // whitespace before KEY (some users indent).
  const re = new RegExp(`^(\\s*)${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*=.*$`);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^\s*#/.test(ln)) continue; // commented — skip
    const m = ln.match(re);
    if (m) {
      lines[i] = `${m[1]}${key}=${value}`;
      changed = true;
      break;
    }
  }
  if (changed) {
    try {
      writeFileSync(path, lines.join('\n'), { mode: 0o600 });
      // Also update process.env so any in-process re-read sees the new
      // value WITHOUT needing a restart. Without this, the SDK-level
      // loadConfig() called from another module path on a fresh
      // dispatch would still see the stale env var and override the
      // freshly-persisted config.json.
      process.env[key] = value;
    } catch {
      return false;
    }
  }
  return changed;
}
export function envExampleContent(): string {
  // Hard-coded canonical content — works when the CLI is installed via npm
  // and `.env.example` is in node_modules but not necessarily reachable
  // via a relative path. Single source of truth for `magic init`.
  //
  // RPC URLs are intentionally COMMENTED OUT so the user-managed
  // ~/.magic/config.json (written by \`rpc set\`) controls them. Without that
  // ordering, \`rpc set\` silently fails to persist — env wins over config
  // on next boot.
  return `# Flash Magic Terminal — environment configuration.
# Lives at ~/.magic/.env (or alongside your project as .env).
# Process env vars (set in your shell) always win; .env only fills gaps.
# Per-field overrides also live in ~/.magic/config.json (managed by \`rpc set\` etc.)

# ─── Network ─────────────────────────────────────────────────────────────────
# mainnet-beta or devnet
MAGIC_NETWORK=mainnet-beta

# Pool name. Pool.0 on mainnet, Pool.1 on devnet.
MAGIC_POOL_NAME=Pool.0

# MagicBlock ER router URL — handles delegated state for sub-second confirms.
# Commented out so \`rpc\` subcommand persistence works. Uncomment + set to override.
# MAGIC_RPC_URL=https://flashtrade.magicblock.app/

# Flash Trade V2 Builder API. Leave commented unless you are testing a
# documented Flash API environment.
# MAGIC_FLASH_API_URL=https://flashapi.trade

# L1 (Solana) RPC for reads + L1-only ixs (deposit, withdraw, settle).
# A premium RPC (Helius / QuickNode / Triton) is STRONGLY recommended for
# any real trading — public api.mainnet-beta.solana.com rate-limits the
# polling and surfaces as "block height exceeded" on every L1 op.
# Run \`magic\` then \`rpc set https://<your-rpc>\` — it persists to
# ~/.magic/config.json and survives restarts. Leave this line commented so
# the rpc subcommand stays in charge.
# MAGIC_L1_RPC_URL=https://api.mainnet-beta.solana.com

# ─── Wallet ─────────────────────────────────────────────────────────────────
# Default keypair path used in non-interactive mode. The interactive flow
# imports wallets into ~/.flash/wallets and remembers a default — see the
# REPL's \`wallet\` subcommands.
MAGIC_WALLET_PATH=~/.config/solana/id.json

# Optional dedicated withdrawal escrow fee-payer keypair. V2 withdrawals
# require feePayer != owner; when unset the CLI creates an in-memory signer
# for the single request and never reuses it.
# MAGIC_WITHDRAW_FEE_PAYER_PATH=~/.config/solana/withdraw-fee-payer.json
# MAGIC_WITHDRAW_FEE_PAYER_TOP_UP_LAMPORTS=0

# ─── Trading guards (defense-in-depth caps) ─────────────────────────────────
# Hard caps. 0 = unlimited. Recommended: set non-zero for agent-driven setups.
MAX_COLLATERAL_PER_TRADE=0
MAX_POSITION_SIZE=0
MAX_LEVERAGE=0
MAX_TRADES_PER_MINUTE=10
MIN_DELAY_BETWEEN_TRADES_MS=1000

# ─── Confirmation ───────────────────────────────────────────────────────────
# When false (default), the REPL shows a y/N preview card before signing every
# trade — your last line of defense against a mistyped command. Set true only
# if you want trades to sign immediately with no preview. Agent mode (NO_DNA=1)
# refuses signing unless this is explicitly true.
MAGIC_AUTO_CONFIRM=false

# Client-side slippage cap for market orders, as a PERCENT (default 0.5 = 0.5%).
# Every open/close/increase/decrease/reverse carries this so a fill can't move
# arbitrarily against you. Raise it for thin/volatile markets, lower it to be
# stricter. Range 0.01–50.
# MAGIC_SLIPPAGE_PERCENT=0.5

# Return ER ix signatures on submit instead of waiting for confirm. Default true.
MAGIC_FAST_CONFIRM=true

# ─── Logs ───────────────────────────────────────────────────────────────────
# debug | info | warn | error
MAGIC_LOG_LEVEL=info
# text | json
MAGIC_LOG_FORMAT=text

# ─── Agent mode ─────────────────────────────────────────────────────────────
# NO_DNA=1 enables agent mode (https://no-dna.org): JSON output, no prompts,
# no ASCII art, debug verbosity, errors to stderr. Set in your shell when
# driving the CLI from an LLM agent or CI runner.
# NO_DNA=1
`;
}

function resolveHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return resolve(homedir(), p.slice(p.startsWith('~/') ? 2 : 1));
  }
  return isAbsolute(p) ? p : resolve(p);
}

/**
 * Validate an RPC URL: must be HTTPS (or HTTP for loopback only), no embedded
 * credentials, parseable.
 *
 * `.local` (mDNS) hostnames are NOT considered loopback — on a shared LAN
 * (coffee shop, office) an attacker can advertise `helius.local` over mDNS
 * and intercept all RPC traffic, including signed transaction submissions.
 * Only true loopback (127.0.0.1 / localhost) gets the http:// exemption, and
 * only when `MAGIC_ALLOW_INSECURE_RPC=1` is set explicitly so users on a
 * dev cluster aren't surprised by the lockdown.
 */
export function validateRpcUrl(url: string, label = 'RPC_URL'): string {
  if (!url) throw new Error(`${label} is empty`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} is not a valid URL: ${url}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain embedded credentials`);
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  const allowInsecure = process.env.MAGIC_ALLOW_INSECURE_RPC === '1';
  // SSRF defence — reject IP literals that point at private / link-local /
  // metadata ranges. The CLI signs transactions and sends them to whatever
  // host this URL names; an attacker who can edit config (or convince the
  // user to paste a malicious URL) could otherwise pivot the RPC client at
  // an internal service or the cloud IMDS endpoint and exfiltrate IAM
  // credentials. Loopback is exempt and so is `MAGIC_ALLOW_INSECURE_RPC=1`
  // for users running a real local validator.
  if (!isLoopback && !allowInsecure) {
    if (isPrivateOrSpecialHost(host)) {
      throw new Error(
        `${label} points at a private/link-local/metadata host (${host}); refusing. ` +
        `Set MAGIC_ALLOW_INSECURE_RPC=1 only if you really mean it.`,
      );
    }
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback && allowInsecure)) {
    throw new Error(
      `${label} must use HTTPS (got ${parsed.protocol})` +
      (parsed.protocol === 'http:' ? ' — set MAGIC_ALLOW_INSECURE_RPC=1 for loopback dev clusters' : ''),
    );
  }
  return parsed.toString();
}

/**
 * Return true if `host` is an IP literal in a range we refuse to talk to:
 *   - 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16   (RFC1918 private)
 *   - 169.254.0.0/16                              (link-local incl. AWS/GCP IMDS 169.254.169.254)
 *   - 127.0.0.0/8                                 (loopback — caller already exempts the canonical form)
 *   - 100.64.0.0/10                               (CGNAT)
 *   - 0.0.0.0/8                                   (unspecified)
 *   - IPv6 fc00::/7 (ULA), fe80::/10 (link-local), ::ffff:<v4>-mapped private ranges
 *
 * Hostnames (non-IP) that *might* resolve to private ranges are NOT blocked
 * — DNS rebinding is mitigated at the connect layer and adding sync DNS
 * here would make config load blocking and racey.
 */
function isPrivateOrSpecialHost(host: string): boolean {
  // Strip surrounding brackets from IPv6 literals.
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  // NOTE on non-standard IPv4 encodings (integer 2130706433, hex 0x7f000001,
  // octal 017700000001): the WHATWG URL parser in validateRpcUrl already
  // normalises these to dotted-decimal BEFORE we see `host`, so the private /
  // link-local / IMDS ranges below still catch them (verified by test). We
  // therefore don't need a bespoke inet_aton decoder here.
  // IPv4 literal?
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1, 5).map((s) => Number(s));
    if (o.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true; // bogus → refuse
    const [a, b] = o;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + IMDS
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  // IPv6 literal? Cheap prefix checks — a full IPv6 parser is overkill here
  // and Node already normalises the bracketed form via URL().
  if (h.includes(':')) {
    const lower = h.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 ULA
    if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
        lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10
    // ::ffff:a.b.c.d — IPv4-mapped. Re-run the v4 check on the tail.
    const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isPrivateOrSpecialHost(mapped[1]);
    return false;
  }
  return false;
}

export function loadConfig(): MagicConfig {
  loadEnvOnce();
  const file = loadConfigFile();

  const network = (safeEnvString('MAGIC_NETWORK', file.network ?? 'mainnet-beta').toLowerCase() === 'devnet'
    ? 'devnet'
    : 'mainnet-beta') as MagicConfig['network'];

  const isMainnet = network === 'mainnet-beta';
  const defaultPool = isMainnet ? MAGIC_POOL_NAME_MAINNET : MAGIC_POOL_NAME_DEVNET;
  const wrongPool = isMainnet ? MAGIC_POOL_NAME_DEVNET : MAGIC_POOL_NAME_MAINNET;
  const requestedPool = safeEnvString('MAGIC_POOL_NAME', file.pool_name ?? defaultPool);
  // UX guard: a stale .env where MAGIC_POOL_NAME is the OPPOSITE network's
  // pool will fail with a cryptic "Pool not found" message. Detect the
  // mismatch and silently snap to the correct default for the current
  // network. The user can still set a custom pool by using the right one
  // (Pool.0 on mainnet / Pool.1 on devnet) — we only override the obvious
  // wrong-pair case.
  const poolName = requestedPool === wrongPool ? defaultPool : requestedPool;

  const erRpcUrl = validateRpcUrl(
    safeEnvString('MAGIC_RPC_URL', file.er_rpc_url ?? (isMainnet ? MAGIC_ROUTER_URL_MAINNET : MAGIC_ROUTER_URL_DEVNET)),
    'MAGIC_RPC_URL',
  );

  const flashApiUrl = validateRpcUrl(
    safeEnvString('MAGIC_FLASH_API_URL', file.flash_api_url ?? FLASH_V2_API_URL),
    'MAGIC_FLASH_API_URL',
  );

  const l1RpcUrl = validateRpcUrl(
    safeEnvString('MAGIC_L1_RPC_URL', file.l1_rpc_url ?? (isMainnet ? DEFAULT_L1_RPC_MAINNET : DEFAULT_L1_RPC_DEVNET)),
    'MAGIC_L1_RPC_URL',
  );

  const programIdOverride = safeEnvString('MAGIC_PROGRAM_ID', file.program_id ?? '') || undefined;
  const walletPath = resolveHome(safeEnvString('MAGIC_WALLET_PATH', '~/.config/solana/id.json'));
  const withdrawFeePayerPathRaw = safeEnvString(
    'MAGIC_WITHDRAW_FEE_PAYER_PATH',
    file.withdraw_fee_payer_path ?? '',
  );
  const withdrawFeePayerPath = withdrawFeePayerPathRaw ? resolveHome(withdrawFeePayerPathRaw) : undefined;
  const withdrawFeePayerTopUpLamports = safeEnvNumber(
    'MAGIC_WITHDRAW_FEE_PAYER_TOP_UP_LAMPORTS',
    file.withdraw_fee_payer_top_up_lamports ?? 0,
  );

  return {
    network,
    poolName,
    erRpcUrl,
    flashApiUrl,
    l1RpcUrl,
    programIdOverride,
    walletPath,
    withdrawFeePayerPath,
    withdrawFeePayerTopUpLamports,
    computeUnitPrice: safeEnvNumber('COMPUTE_UNIT_PRICE', file.compute_unit_price ?? 50_000),
    // Strict parse: an unrecognised value (e.g. `disable`) throws instead
    // of silently falling back to true. A safety-critical gate must never
    // mis-interpret user intent.
    // Default `false` — show the confirm gate before every signing
    // verb. Matches what the `magic init` wizard writes to a fresh
    // `.env`, and what THREAT_MODEL.md §"Defence layers" promises.
    // Power users running an agent / scripted flow flip this to `true`
    // explicitly via env var or .env.
    autoConfirm: safeEnvBoolStrict('MAGIC_AUTO_CONFIRM', file.auto_confirm ?? false),
    fastConfirm: safeEnvBool('MAGIC_FAST_CONFIRM', file.fast_confirm ?? true),
    // Caps: 0 = unlimited (valid). A NEGATIVE value is a mistake that would
    // otherwise silently disable the guard (its `> 0` gate) — reject it loudly.
    maxCollateralPerTrade: safeEnvNumber('MAX_COLLATERAL_PER_TRADE', file.max_collateral_per_trade ?? 0, { min: 0 }),
    maxPositionSize: safeEnvNumber('MAX_POSITION_SIZE', file.max_position_size ?? 0, { min: 0 }),
    maxLeverage: safeEnvNumber('MAX_LEVERAGE', file.max_leverage ?? 0, { min: 0 }),
    maxTradesPerMinute: safeEnvNumber('MAX_TRADES_PER_MINUTE', file.max_trades_per_minute ?? 10, { min: 0 }),
    // Default 0 — manual REPL users hit this constantly when they run
    // open→reverse or open→close back-to-back. The MAX_TRADES_PER_MINUTE
    // cap (default 10/min) is the real anti-runaway protection;
    // requiring 1s between every trade adds friction without adding
    // safety. Agents that want a cooldown can set this explicitly.
    minDelayBetweenTradesMs: safeEnvNumber('MIN_DELAY_BETWEEN_TRADES_MS', file.min_delay_between_trades_ms ?? 0, { min: 0 }),
  };
}
