/**
 * Single-mode REPL for the Flash Magic Terminal.
 *
 * Behaviour:
 *  - Loads `MagicConfig`, opens the wallet, renders the futuristic banner.
 *  - Pre-warms a `MagicTradeClient` so the first trade pays no cold-start cost.
 *  - Accepts both verb-first (`open SOL long 5 2`) and side-first (`long SOL 5 2x`)
 *    free-form syntax, then dispatches to a registered tool.
 *  - Commands run sequentially (no concurrent signs) and each prints a latency
 *    pill once the tool completes.
 */

import { createInterface, Interface } from 'readline';
import chalk from 'chalk';
import { PublicKey } from '@solana/web3.js';
import { getPoolConfig } from '../utils/pool-cache.js';

import type { MagicConfig, ToolContext, ToolResult } from '../types/index.js';
import { ToolEngine, getEngine } from '../tools/engine.js';
import { prewarmMagicClient, shutdownMagicClients, journalMagicTrade } from '../tools/magic-tools.js';
import { WalletManager } from '../wallet/walletManager.js';
import { initSigningGuard } from '../security/signing-guard.js';
import { initLogger, getLogger, LogLevel } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';
import { renderSession } from './banner.js';
import { interpretCommand, configureSymbols } from './interpreter.js';
import { loadAiConfig } from '../ai/config.js';
import { IntentResolver, type ResolveResult } from '../ai/interpret.js';
import { c, latencyPill, BRAND_NAME_UPPER } from './magic-theme.js';
import { recordMagicAction } from './magic-session-stats.js';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { stopMagicAlerts } from '../monitor/magic-alerts.js';
import { isKilled } from '../security/kill-switch.js';
import { bindReadline, unbindReadline } from './repl-write.js';
import { VERSION } from '../utils/version.js';
import { withSpinner } from './spinner.js';

// ─── Symbol resolution from PoolConfig ────────────────────────────────────────

let _magicSymCache: { key: string; symbols: Set<string>; aliases: Map<string, string> } | null = null;

function getMagicSymbolSet(network: string, pool: string): { symbols: Set<string>; aliases: Map<string, string> } {
  const key = `${network}:${pool}`;
  if (_magicSymCache && _magicSymCache.key === key) return _magicSymCache;
  const symbols = new Set<string>();
  const aliases = new Map<string, string>();
  try {
    const cluster = network === 'devnet' ? 'devnet' : 'mainnet-beta';
    const p = getPoolConfig(pool, cluster);
    for (const cu of p.custodies) symbols.add(cu.symbol.toUpperCase());
  } catch {
    /* best-effort — empty set falls through to side-first parser failure */
  }
  const ALIAS_MAP: Record<string, string[]> = {
    // Stables — DO NOT alias "usd"/"dollar"/"dollars" here. Those are unit
    // words used in commands like "for 100 dollars" and aliasing them to
    // USDC breaks the natural-language limit parser.
    USDC: ['usdc'],
    // Crypto
    SOL:  ['solana', 'sol-perp', 'solperp'],
    BTC:  ['bitcoin', 'btc-perp', 'btcperp', 'xbt'],
    ETH:  ['ethereum', 'ether', 'eth-perp', 'ethperp'],
    BNB:  ['binance', 'binancecoin', 'bnb-perp'],
    MON:  ['monad'],
    SUI:  ['sui'],
    HYPE: ['hyperliquid', 'hype-perp'],
    ZEC:  ['zcash'],
    // Equities — common typos & full names
    SPY:  ['sp500', 's&p', 's&p500', 'spx', 'sandp', 'sandp500'],
    AAPL: ['apple', 'aapl-perp'],
    TSLA: ['tesla'],
    NVDA: ['nvidia'],
    AMZN: ['amazon'],
    INTC: ['intel'],
    LLY:  ['eli lilly', 'lilly'],
    TXN:  ['texas instruments', 'texasinstruments'],
    TSM:  ['taiwan semiconductor', 'taiwansemi', 'tsmc'],
    // FX
    EUR:    ['euro', 'eur-usd', 'eurusd'],
    GBP:    ['pound', 'sterling', 'cable', 'gbp-usd', 'gbpusd'],
    USDJPY: ['jpy', 'yen', 'japanese yen', 'usd-jpy', 'usdjpy'],
    USDCNH: ['cnh', 'yuan', 'renminbi', 'rmb', 'usd-cnh'],
    // Metals
    XAU: ['gold', 'gld'],
    XAG: ['silver', 'slv'],
    // Commodities
    CRUDEOIL: ['crude', 'oil', 'wti', 'crude oil', 'crudeoil', 'brent'],
    NATGAS:   ['natgas', 'nat gas', 'gas', 'naturalgas', 'natural gas', 'ng'],
    COPPER:   ['copper'],
  };
  for (const [canon, names] of Object.entries(ALIAS_MAP)) {
    if (!symbols.has(canon)) continue;
    for (const n of names) aliases.set(n.toLowerCase(), canon);
  }
  _magicSymCache = { key, symbols, aliases };
  return _magicSymCache;
}

// ─── Open-position parser ─────────────────────────────────────────────────────

function parseOpenArgs(
  argString: string,
  network: string,
  pool: string,
): { market: string; side: 'long' | 'short'; collateral: number; leverage: number; tp?: number; sl?: number } | null {
  const { symbols, aliases } = getMagicSymbolSet(network, pool);
  // Pull `tp <price>` and `sl <price>` pairs out FIRST so they don't get
  // swept up by the natural-language number collector below.
  let tp: number | undefined;
  let sl: number | undefined;
  let preStripped = argString
    .toLowerCase()
    .replace(/\$(\d)/g, '$1');
  preStripped = preStripped.replace(
    /\b(tp|takeprofit|take-profit)\s+(\d+(?:\.\d+)?)\b/gi,
    (_m, _kw, num) => { tp = parseFloat(num); return ''; },
  );
  preStripped = preStripped.replace(
    /\b(sl|stoploss|stop-loss)\s+(\d+(?:\.\d+)?)\b/gi,
    (_m, _kw, num) => { sl = parseFloat(num); return ''; },
  );

  const cleaned = preStripped
    .replace(/\b(?:with|for|on|at|to|in|of|using|and|the|a|an|my|position|collateral|dollars?|bucks?|usd|usdc|leverage|lev|set)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = cleaned.split(/\s+/);

  let side: 'long' | 'short' | undefined;
  let leverage: number | undefined;
  let collateral: number | undefined;
  let market: string | undefined;
  const numbers: number[] = [];

  for (const tok of tokens) {
    if (tok === 'long' || tok === 'short' || tok === 'buy' || tok === 'sell') {
      side = tok === 'short' || tok === 'sell' ? 'short' : 'long';
      continue;
    }
    const levM = tok.match(/^(\d+(?:\.\d+)?)x$/i);
    if (levM) { leverage = parseFloat(levM[1]); continue; }
    if (/^\d+(?:\.\d+)?$/.test(tok)) { numbers.push(parseFloat(tok)); continue; }
    const upper = tok.toUpperCase();
    if (symbols.has(upper)) { market = upper; continue; }
    const aliased = aliases.get(tok);
    if (aliased) market = aliased;
  }

  if (numbers.length === 1 && leverage !== undefined) collateral = numbers[0];
  else if (numbers.length >= 2) {
    if (leverage === undefined) {
      // Positional per the documented grammar: first number = collateral,
      // second = leverage. (Was magnitude-sorted, which inverted "$5 at 50x".)
      collateral = numbers[0];
      leverage = numbers[1];
    } else collateral = numbers[0];
  }

  if (!market || !side || !Number.isFinite(collateral) || !Number.isFinite(leverage)) return null;
  if ((collateral as number) <= 0 || (leverage as number) <= 0) return null;
  return {
    market,
    side,
    collateral: collateral as number,
    leverage: leverage as number,
    ...(tp !== undefined && tp > 0 ? { tp } : {}),
    ...(sl !== undefined && sl > 0 ? { sl } : {}),
  };
}

// ─── Verb dispatch ────────────────────────────────────────────────────────────

const TRADE_VERBS = new Set(['long', 'short', 'buy', 'sell']);

// CLI verb → tool alias (engine resolves the right ToolDefinition).
const VERB_ALIASES: Record<string, string> = {
  portfolio: 'portfolio', positions: 'positions', holdings: 'portfolio',
  status: 'status', markets: 'markets',
  delegation: 'delegation', setup: 'setup',
  deposit: 'deposit', 'deposit-direct': 'deposit-direct', withdraw: 'withdraw',
  'request-withdrawal': 'request-withdrawal',
  'withdrawal-settle': 'withdrawal-settle',
  'custody-settlement': 'settle',
  'init-basket': 'init-basket',
  'init-deposit-ledger': 'init-deposit-ledger',
  'delegate-basket': 'delegate-basket', delegate: 'delegate-basket',
  'withdraw-status': 'withdraw-status',
  'withdraw-watch': 'withdraw-watch',
  vault: 'vault', settle: 'settle', faucet: 'faucet',
  account: 'account', acc: 'account',
  price: 'price',
  'api-health': 'api-health', health: 'api-health',
  tokens: 'tokens',
  prices: 'prices',
  'pool-data': 'pool-data',
  raw: 'raw',
  snapshot: 'snapshot', basket: 'snapshot',
  preview: 'preview',
  builder: 'builder',
  stream: 'basket-stream', 'basket-stream': 'basket-stream',
  open: 'open', o: 'open', close: 'close', reverse: 'reverse', increase: 'increase',
  'partial-close': 'partial-close', partial: 'partial-close',
  'add-collateral': 'add-collateral', add: 'add-collateral',
  'remove-collateral': 'remove-collateral', remove: 'remove-collateral',
  limit: 'place-limit', 'place-limit': 'place-limit',
  orders: 'orders',
  cancel: 'cancel',
  'cancel-limit': 'cancel-limit',
  trigger: 'trigger-order', 'trigger-order': 'trigger-order',
  tp: 'trigger-order', sl: 'trigger-order',
  set: 'set-triggers',
  'cancel-trigger': 'cancel-trigger',
  liquidate: 'liquidate',
  'close-all': 'close-all', closeall: 'close-all',
  history: 'history', trades: 'history', journal: 'history',
  dashboard: 'dashboard',
  alerts: 'alerts',
  'er-health': 'er-health', er: 'er-health',
  verify: 'verify',
  doctor: 'doctor', diag: 'doctor', diagnose: 'doctor', check: 'doctor',
  perf: 'perf', performance: 'perf',
};

interface ParsedCommand {
  alias: string;
  params: Record<string, unknown>;
}

/**
 * Per-verb spinner label. The default is just "submitting…" but slow,
 * recognisable verbs deserve a more specific message so the user knows
 * what they're waiting on.
 */
function spinnerLabelFor(alias: string): string {
  switch (alias) {
    case 'open':                return 'opening position…';
    case 'close':               return 'closing position…';
    case 'reverse':             return 'reversing position…';
    case 'increase':            return 'increasing position…';
    case 'partial-close':       return 'partially closing…';
    case 'add-collateral':      return 'adding collateral…';
    case 'remove-collateral':   return 'removing collateral…';
    case 'place-limit':         return 'placing limit order…';
    case 'cancel-limit':        return 'cancelling limit…';
    case 'trigger-order':       return 'placing TP/SL…';
    case 'set-triggers':        return 'attaching TP + SL…';
    case 'cancel-trigger':      return 'cancelling trigger…';
    case 'cancel':              return 'cancelling order(s)…';
    case 'liquidate':           return 'liquidating…';
    case 'close-all':           return 'closing all positions…';
    case 'deposit':             return 'depositing to vault…';
    case 'deposit-direct':      return 'depositing to vault…';
    case 'withdraw':            return 'withdrawing from vault…';
    case 'request-withdrawal':  return 'requesting withdrawal…';
    case 'withdrawal-settle':   return 'settling withdrawal…';
    case 'withdraw-watch':      return 'watching withdrawal…';
    case 'settle':              return 'settling custodies…';
    case 'setup':               return 'initializing on-chain accounts…';
    case 'init-basket':         return 'initializing basket…';
    case 'init-deposit-ledger': return 'initializing deposit ledger…';
    case 'delegate-basket':     return 'delegating basket…';
    case 'portfolio':           return 'fetching portfolio…';
    case 'positions':           return 'fetching positions…';
    case 'vault':               return 'reading vault…';
    case 'account':             return 'reading account…';
    case 'markets':             return 'loading markets…';
    case 'price':               return 'fetching oracle price…';
    case 'api-health':          return 'checking Flash V2 API…';
    case 'tokens':              return 'loading tokens…';
    case 'prices':              return 'fetching prices…';
    case 'pool-data':           return 'loading pool data…';
    case 'raw':                 return 'reading raw account data…';
    case 'snapshot':            return 'reading basket snapshot…';
    case 'preview':             return 'running preview…';
    case 'builder':             return 'building transaction…';
    case 'basket-stream':       return 'opening basket stream…';
    case 'orders':              return 'reading orders…';
    case 'dashboard':           return 'composing dashboard…';
    case 'history':             return 'reading history…';
    case 'verify':              return 'verifying parity…';
    case 'doctor':              return 'running diagnostics…';
    default:                    return 'working…';
  }
}

/**
 * Tiny Levenshtein for "did you mean" hints. Only used when the user mistypes
 * a verb — quality over speed; the candidate set is bounded (~30 entries).
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > 3) return 4;
  const m: number[][] = [];
  for (let i = 0; i <= a.length; i++) m[i] = [i];
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + cost);
    }
  }
  return m[a.length][b.length];
}

/** Closest known verb (alias or canonical) to a typo, or null if too far. */
function nearestVerb(input: string): string | null {
  const candidates = new Set<string>([
    ...Object.keys(VERB_ALIASES),
    'help', 'exit', 'quit', 'clear', 'wallet', 'rpc', 'monitor', 'watch',
    'kill', 'resume', 'init', 'env', 'feedback', 'ai',
  ]);
  let best: { verb: string; d: number } | null = null;
  for (const v of candidates) {
    const d = editDistance(input, v);
    if (d <= 2 && (!best || d < best.d)) best = { verb: v, d };
  }
  return best?.verb ?? null;
}

/**
 * Verbs that issue an on-chain signature. When `MAGIC_AUTO_CONFIRM=false`,
 * the terminal renders a preview and requires explicit `y` before dispatch.
 * Pure-read commands (`portfolio`, `markets`, `dashboard`, …) are excluded —
 * confirming every status query would be obnoxious without adding safety.
 */
const SIGNING_VERBS = new Set<string>([
  'open',
  'close',
  'reverse',
  'increase',
  'partial-close',
  'add-collateral',
  'remove-collateral',
  'place-limit',
  'cancel',
  'cancel-limit',
  'cancel-trigger',
  'trigger-order',
  'set-triggers',
  'liquidate',
  'close-all',
  'deposit',
  'deposit-direct',
  'withdraw',
  'request-withdrawal',
  'withdrawal-settle',
  'settle',
  'builder',
  // `setup` triggers L1 signing of UDL + basket + delegation ixs. Without
  // listing it here, MAGIC_AUTO_CONFIRM=false would silently auto-sign.
  'setup',
  'init-basket',
  'init-deposit-ledger',
  'delegate-basket',
  'delegate',
  // Trigger orders without `place-limit` already listed via 'trigger-order'.
  'trigger',
]);

const N = (s: string | undefined): number | undefined => {
  if (!s) return undefined;
  const m = s.match(/^(\d+(?:\.\d+)?)(?:x)?$/i);
  return m ? parseFloat(m[1]) : undefined;
};
const sideOf = (s: string | undefined): 'long' | 'short' | undefined =>
  s === 'long' || s === 'short' ? s : undefined;

/**
 * Per-alias positional grammar. Each entry parses `args` into the exact param
 * shape the underlying Zod schema expects. Returning `null` indicates a usage
 * error and surfaces as "unknown command" / a clean schema-validation message.
 */
const ARG_PARSERS: Record<string, (args: string[], rawRest: string) => Record<string, unknown>> = {
  // — read-only commands
  portfolio: () => ({}),
  positions: ([owner]) => (owner ? { owner } : {}),
  status: () => ({}),
  delegation: () => ({}),
  setup: () => ({}),
  vault: () => ({}),
  account: () => ({}),
  faucet: () => ({}),
  verify: () => ({}),
  'close-all': () => ({}),
  dashboard: () => ({}),
  'er-health': () => ({}),
  'api-health': () => ({}),
  tokens: () => ({}),
  prices: ([symbol]) => (symbol ? { symbol: symbol.toUpperCase() } : {}),
  'pool-data': ([pubkey]) => (pubkey ? { pubkey } : {}),
  raw: ([kind, pubkey]) => ({ kind: (kind ?? '').toLowerCase(), ...(pubkey ? { pubkey } : {}) }),
  snapshot: ([owner]) => (owner ? { owner } : {}),
  preview: (args, rawRest) => {
    const name = args[0] ?? '';
    const body = rawRest.slice(name.length).trim();
    return { name, body };
  },
  builder: (args, rawRest) => {
    const sign = args[0]?.toLowerCase() === 'sign';
    const operation = sign ? (args[1] ?? '') : (args[0] ?? '');
    const prefix = sign ? `${args[0] ?? ''} ${args[1] ?? ''}` : operation;
    const body = rawRest.slice(prefix.length).trim();
    return { operation, body, ...(sign ? { sign: true } : {}) };
  },
  'basket-stream': ([owner, interval, max]) => ({
    ...(owner ? { owner } : {}),
    ...(interval ? { updateIntervalMs: N(interval) } : {}),
    ...(max ? { maxMessages: N(max) } : {}),
  }),

  history: ([n]) => (n && /^\d+$/.test(n) ? { limit: parseInt(n, 10) } : {}),
  orders: ([owner]) => (owner ? { owner } : {}),
  cancel: (args) => {
    // Skip leading kind hints (`order`, `limit`, `trigger`, `tp`, `sl`) so
    // `cancel order 0` and `cancel limit 0` both resolve cleanly.
    const KINDS = new Set(['limit', 'trigger', 'tp', 'sl']);
    for (const a of args) {
      if (KINDS.has(a.toLowerCase())) continue;
      if (a.toLowerCase() === 'all' || a === '*') return { target: 'all' };
      // Numeric or range like `0`, `0..4`, `0-4`
      if (/^\d/.test(a)) return { target: a };
    }
    return {};
  },
  markets: ([value]) => {
    if (!value) return {};
    const lower = value.toLowerCase();
    if (['crypto', 'equity', 'fx', 'metal', 'commodity', 'other'].includes(lower)) return { category: lower };
    return { filter: value.toUpperCase() };
  },
  price: ([m]) => ({ market: (m ?? '').toUpperCase() }),
  alerts: ([action]) => ({ action: (action ?? 'status').toLowerCase() }),
  settle: ([sym]) => (sym ? { symbol: sym.toUpperCase() } : {}),

  // — vault
  deposit: ([token, amt]) => ({ token: (token ?? '').toUpperCase(), amount: N(amt) }),
  'deposit-direct': ([tokenMint, amt, fundingOwner]) => ({
    tokenMint: tokenMint ?? '',
    amount: N(amt),
    ...(fundingOwner ? { fundingOwner } : {}),
  }),
  withdraw: ([token, amt]) => {
    // Accept `max` / `all` / `100%` as an alias for "the full available
    // basket balance for this token". The withdraw tool detects the literal
    // 'max' and resolves it against the live balance at execute time.
    const a = (amt ?? '').toLowerCase().replace(/\s/g, '');
    if (a === 'max' || a === 'all' || a === '100%') {
      return { token: (token ?? '').toUpperCase(), amount: 'max' };
    }
    return { token: (token ?? '').toUpperCase(), amount: N(amt) };
  },
  'request-withdrawal': ([tokenMint, amt]) => ({ tokenMint: tokenMint ?? '', amount: N(amt) }),
  'withdrawal-settle': ([tokenMint]) => ({ tokenMint: tokenMint ?? '' }),
  'init-basket': () => ({}),
  'init-deposit-ledger': () => ({}),
  'delegate-basket': () => ({}),

  // — trading (close / reverse / partial / increase / collateral)
  close: ([m, s, recv]) => ({
    market: (m ?? '').toUpperCase(),
    side: sideOf(s?.toLowerCase()),
    ...(recv ? { receiveToken: recv.toUpperCase() } : {}),
  }),
  reverse: ([m, s, coll, lev]) => ({
    market: (m ?? '').toUpperCase(),
    side: sideOf(s?.toLowerCase()),
    ...(coll !== undefined ? { collateral: N(coll) } : {}),
    ...(lev !== undefined ? { leverage: N(lev) } : {}),
  }),
  'partial-close': ([m, s, sz]) => ({
    market: (m ?? '').toUpperCase(),
    side: sideOf(s?.toLowerCase()),
    sizeUsd: N(sz),
  }),
  increase: ([m, s, sz, addColl]) => ({
    market: (m ?? '').toUpperCase(),
    side: sideOf(s?.toLowerCase()),
    sizeUsd: N(sz),
    ...(addColl !== undefined ? { addCollateralUsd: N(addColl) } : {}),
  }),
  'add-collateral': ([m, s, amt]) => ({
    market: (m ?? '').toUpperCase(),
    side: sideOf(s?.toLowerCase()),
    amount: N(amt),
  }),
  'remove-collateral': ([m, s, amt]) => ({
    market: (m ?? '').toUpperCase(),
    side: sideOf(s?.toLowerCase()),
    amount: N(amt),
  }),

  // — orders
  'place-limit': (args) => {
    const [m, s, price, coll, lev, ...rest] = args;
    const params: Record<string, unknown> = {
      market: (m ?? '').toUpperCase(),
      side: sideOf(s?.toLowerCase()),
      limitPrice: N(price),
      collateral: N(coll),
      leverage: N(lev),
    };
    // Parse trailing `tp <price>` / `sl <price>` pairs (filler words like
    // `set`, `with`, `and`, `to` are stripped earlier in parseCommand).
    for (let i = 0; i < rest.length - 1; i++) {
      const tok = rest[i].toLowerCase();
      const next = rest[i + 1];
      if ((tok === 'tp' || tok === 'takeprofit' || tok === 'take-profit') && next) {
        params.tp = N(next);
        i++;
      } else if ((tok === 'sl' || tok === 'stoploss' || tok === 'stop-loss') && next) {
        params.sl = N(next);
        i++;
      }
    }
    return params;
  },
  'trigger-order': ([m, s, price, kind, sz]) => ({
    market: (m ?? '').toUpperCase(),
    side: sideOf(s?.toLowerCase()),
    price: N(price),
    isStopLoss: (kind ?? '').toLowerCase() === 'sl' || (kind ?? '').toLowerCase() === 'stoploss',
    ...(sz !== undefined ? { sizeUsd: N(sz) } : {}),
  }),
  'cancel-limit': ([m, s, id]) => ({
    market: (m ?? '').toUpperCase(),
    side: sideOf(s?.toLowerCase()),
    orderId: id !== undefined ? parseInt(id, 10) : undefined,
  }),
  'cancel-trigger': ([m, id, kind]) => ({
    market: (m ?? '').toUpperCase(),
    orderId: id !== undefined ? parseInt(id, 10) : undefined,
    isStopLoss: (kind ?? '').toLowerCase() === 'sl' || (kind ?? '').toLowerCase() === 'stoploss',
  }),
  liquidate: ([owner, m, s]) => ({
    positionOwner: owner ?? '',
    market: (m ?? '').toUpperCase(),
    side: sideOf(s?.toLowerCase()),
  }),
  // `set tp <price> sl <price>` attaches BOTH triggers to an existing position
  // in any natural order. Filler words (set/and/to/on) are pre-stripped.
  // Examples:
  //   set tp 100 sl 50 sol long
  //   set sol long tp 100 sl 50
  //   tp 100 sl 50 sol long
  'set-triggers': (args) => {
    const params: Record<string, unknown> = {};
    for (let i = 0; i < args.length; i++) {
      const tok = args[i].toLowerCase();
      if (tok === 'long' || tok === 'short') { params.side = tok; continue; }
      const upper = args[i].toUpperCase();
      if (/^[A-Z]+$/.test(upper) && upper.length <= 12 && tok !== 'tp' && tok !== 'sl') {
        if (!params.market) params.market = upper;
        continue;
      }
      if ((tok === 'tp' || tok === 'takeprofit' || tok === 'take-profit') && args[i + 1]) {
        params.tp = N(args[++i]); continue;
      }
      if ((tok === 'sl' || tok === 'stoploss' || tok === 'stop-loss') && args[i + 1]) {
        params.sl = N(args[++i]); continue;
      }
    }
    return params;
  },
};

/**
 * One-line usage hint per alias, appended when Zod validation rejects user
 * input. Friendlier than the raw schema error.
 */
const USAGE_HINTS: Record<string, string> = {
  open: 'open <market> <long|short> <collateral> <leverage>     e.g. `open SOL long 5 2`',
  close: 'close <market> <long|short>                           e.g. `close SOL long`',
  reverse: 'reverse <market> <long|short>                         e.g. `reverse SOL long`',
  increase: 'increase <market> <long|short> <sizeUsd>             e.g. `increase SOL long 10`',
  'partial-close': 'partial <market> <long|short> <sizeUsd>             e.g. `partial SOL long 5`',
  'add-collateral': 'add <market> <long|short> <amountUsd>               e.g. `add SOL long 5`',
  'remove-collateral': 'remove <market> <long|short> <amountUsd>            e.g. `remove SOL long 5`',
  'place-limit': 'limit <market> <long|short> <price> <coll> <lev>    e.g. `limit SOL long 80 50 2`',
  'trigger-order': 'trigger <market> <long|short> <price> <tp|sl>       e.g. `trigger SOL long 95 tp`',
  'set-triggers': 'set <market> <long|short> tp <price> sl <price>       e.g. `set SOL long tp 100 sl 70`',
  tp: 'tp <market> <long|short> <price>                    e.g. `tp SOL long 95`',
  sl: 'sl <market> <long|short> <price>                    e.g. `sl SOL long 80`',
  cancel: 'cancel <N> | cancel all | cancel 0..4                     run `orders` first to see indices',
  'cancel-limit': 'cancel-limit <market> <long|short> <orderId>       e.g. `cancel-limit SOL long 0`',
  'cancel-trigger': 'cancel-trigger <market> <orderId> <tp|sl>           e.g. `cancel-trigger SOL 0 tp`',
  liquidate: 'liquidate <ownerPubkey> <market> <long|short>       e.g. `liquidate 7Gv4… SOL long`',
  deposit: 'deposit <token> <amount>                            e.g. `deposit USDC 50`',
  'deposit-direct': 'deposit-direct <tokenMint> <amount> [fundingOwner]     e.g. `deposit-direct EPjF... 50`',
  withdraw: 'withdraw <token> <amount|max>                       e.g. `withdraw USDC 25` · `withdraw USDC max`',
  'request-withdrawal': 'request-withdrawal <tokenMint> <amount>              e.g. `request-withdrawal EPjF... 25`',
  'withdrawal-settle': 'withdrawal-settle <tokenMint>                      e.g. `withdrawal-settle EPjF...`',
  'withdraw-status': 'withdraw status                                       per-custody pre-flight check',
  'withdraw-watch': 'withdraw watch                                        background poll until any custody flips ready',
  price: 'price <market>                                      e.g. `price SOL`',
  positions: 'positions [owner]                                  V2 /positions/owner/{owner}',
  alerts: 'alerts <on|off|status>                              e.g. `alerts on`',
  settle: 'settle [token]                                      e.g. `settle USDC`',
  'init-deposit-ledger': 'init-deposit-ledger                               initialize the V2 deposit ledger',
  'init-basket': 'init-basket                                       initialize the V2 basket',
  'delegate-basket': 'delegate-basket                                   delegate basket to the ER',
  'api-health': 'health                                             Flash V2 API health',
  tokens: 'tokens                                             list V2 tokens',
  prices: 'prices [symbol]                                    e.g. `prices SOL`',
  'pool-data': 'pool-data [pubkey]                               V2 pool data',
  raw: 'raw <pools|custodies|markets|perpetuals|basket> [pubkey]',
  snapshot: 'snapshot [owner]                                  basket snapshot source-of-truth',
  preview: 'preview <name> <json>                              e.g. `preview margin {"marketSymbol":"SOL",...}`',
  builder: 'builder <operation> <json>                         unsigned V2 builder call; add `sign` to submit',
  'basket-stream': 'stream [owner] [intervalMs] [maxMessages]           bounded V2 basket WebSocket stream',
};

/** Test-only export of the internal parser. */
export function parseCommandForTest(line: string, config: MagicConfig): ParsedCommand | null {
  return parseCommand(line, config);
}

function normalizeCommandText(line: string): string {
  const trimmed = line.trim().replace(/^magic\s+/i, '');
  if (/^init\s+deposit\s+ledger(?:\s+|$)/i.test(trimmed)) {
    return trimmed.replace(/^init\s+deposit\s+ledger/i, 'init-deposit-ledger');
  }
  if (/^init\s+basket(?:\s+|$)/i.test(trimmed)) {
    return trimmed.replace(/^init\s+basket/i, 'init-basket');
  }
  if (/^delegate\s+basket(?:\s+|$)/i.test(trimmed)) {
    return trimmed.replace(/^delegate\s+basket/i, 'delegate-basket');
  }
  if (/^deposit\s+direct(?:\s+|$)/i.test(trimmed)) {
    return trimmed.replace(/^deposit\s+direct/i, 'deposit-direct');
  }
  if (/^request\s+withdrawal(?:\s+|$)/i.test(trimmed)) {
    return trimmed.replace(/^request\s+withdrawal/i, 'request-withdrawal');
  }
  if (/^withdrawal\s+settle(?:\s+|$)/i.test(trimmed)) {
    return trimmed.replace(/^withdrawal\s+settle/i, 'withdrawal-settle');
  }
  if (/^custody\s+settlement(?:\s+|$)/i.test(trimmed)) {
    return trimmed.replace(/^custody\s+settlement/i, 'custody-settlement');
  }
  return trimmed;
}

function parseCommand(line: string, config: MagicConfig): ParsedCommand | null {
  // Make sure the interpreter knows about this pool's symbols + aliases so
  // `resolveMarket` and `isKnownMarket` work. Idempotent — `configureSymbols`
  // just updates the cached sets.
  try {
    const { symbols, aliases } = getMagicSymbolSet(config.network, config.poolName);
    configureSymbols(symbols, aliases.entries());
  } catch { /* fall through */ }

  const commandText = normalizeCommandText(line);
  if (/^positions(?:\s+|$)/i.test(commandText)) {
    const owner = commandText.split(/\s+/)[1];
    return { alias: 'positions', params: owner ? { owner } : {} };
  }

  // First try the v1-style flexible interpreter — handles natural-language
  // forms like "yo open a sol long for 10 usd at 2x", number words, fuzzy
  // typo correction, free-word-order, partial close with %/$, etc.
  // Throws on ambiguous fuzzy match (e.g. typo within distance 2 of two
  // tickers); we re-throw so handle() can render a friendly disambiguation
  // hint instead of routing the trade to the wrong asset.
  let flex: ParsedCommand | null;
  try {
    flex = interpretCommand(line, config);
  } catch (err) {
    if (/disambiguate/i.test(getErrorMessage(err))) throw err;
    flex = null;
  }
  if (flex) return flex;

  const trimmed = commandText; // tolerate `magic <verb>` prefix
  if (trimmed.length === 0) return null;
  const parts = trimmed.split(/\s+/);
  const first = parts[0].toLowerCase();
  // Strip filler words that humans naturally include after a verb:
  //   `limit order sol long 80 50 2`     → `limit sol long 80 50 2`
  //   `place limit sol long 80 50 2`     → `limit sol long 80 50 2` (handled below)
  //   `cancel limit sol long 0`          → handled in alias map
  //   `trigger order sol long 95 tp`     → `trigger sol long 95 tp`
  const FILLERS = new Set(['order', 'an', 'a', 'the', 'set', 'with', 'to', 'and']);
  const rawRest = trimmed.slice(parts[0].length).trim();
  const rest = rawRest
    .split(/\s+/)
    .filter((tok) => !FILLERS.has(tok.toLowerCase()))
    .join(' ');

  // Side-first trade verbs: `long SOL 5 2x` / `short BTC 100 3x`
  if (TRADE_VERBS.has(first)) {
    const parsed = parseOpenArgs(`${first} ${rest}`, config.network, config.poolName);
    if (parsed) return { alias: 'open', params: parsed };
    return { alias: 'open', params: {} };
  }

  const aliased = VERB_ALIASES[first];
  if (!aliased) return null;

  // `open` is special — uses the natural-language opener.
  if (aliased === 'open') {
    const parsed = parseOpenArgs(rest, config.network, config.poolName);
    if (parsed) return { alias: 'open', params: parsed };
    return { alias: 'open', params: {} };
  }

  // `tp` / `sl` are shortcuts for `trigger-order` with the kind injected.
  if (first === 'tp' || first === 'sl') {
    const args = rest.length > 0 ? rest.split(/\s+/) : [];
    const [m, s, price, sz] = args;
    return {
      alias: 'trigger-order',
      params: {
        market: (m ?? '').toUpperCase(),
        side: sideOf(s?.toLowerCase()),
        price: N(price),
        isStopLoss: first === 'sl',
        ...(sz !== undefined ? { sizeUsd: N(sz) } : {}),
      },
    };
  }

  const parser = ARG_PARSERS[aliased];
  if (!parser) return { alias: aliased, params: {} };
  const parserRest = aliased === 'builder' || aliased === 'preview' ? rawRest : rest;
  const args = parserRest.length > 0 ? parserRest.split(/\s+/) : [];
  return { alias: aliased, params: parser(args, parserRest) };
}


// ─── Help renderer ────────────────────────────────────────────────────────────

interface HelpEntry { cmd: string; hint: string }
interface HelpGroup { title: string; entries: HelpEntry[] }

const HELP_GROUPS: HelpGroup[] = [
  {
    title: 'Trading',
    entries: [
      { cmd: 'long SOL 5 2x',                  hint: 'Open a long (collateral 5 USDC, 2x leverage)' },
      { cmd: 'short BTC 100 3x',               hint: 'Open a short' },
      { cmd: 'open SOL long 5 2',              hint: 'Same as `long` but verb-first' },
      { cmd: 'open SOL long 5 2 tp 100 sl 70', hint: 'Open with take-profit + stop-loss attached' },
      { cmd: 'close SOL long',                 hint: 'Close a position by symbol + side' },
      { cmd: 'reverse SOL long',               hint: 'Flip side, inheriting collateral & leverage' },
      { cmd: 'increase SOL long 10',           hint: 'Grow position size by $10' },
      { cmd: 'partial SOL long 5',             hint: 'Close $5 of an existing position' },
      { cmd: 'close 50% of SOL long',          hint: 'Close half by percent' },
      { cmd: 'close $20 of BTC short',         hint: 'Close $20 by USD amount' },
      { cmd: 'close all',                      hint: 'Market-close every open position' },
      { cmd: 'add SOL long 5',                 hint: 'Add 5 USDC of collateral' },
      { cmd: 'remove SOL long 5',              hint: 'Remove $5 of collateral' },
    ],
  },
  {
    title: 'Orders',
    entries: [
      { cmd: 'limit SOL long 80 50 2',           hint: 'Limit order: open at $80, 50 USDC, 2x' },
      { cmd: 'limit SOL long 80 50 2 tp 100 sl 70', hint: 'Same with TP/SL prices attached' },
      { cmd: 'tp SOL long 95',                   hint: 'Take-profit at $95' },
      { cmd: 'sl SOL long 80',                   hint: 'Stop-loss at $80' },
      { cmd: 'set SOL long tp 100 sl 70',        hint: 'Attach BOTH TP + SL to an existing position' },
      { cmd: 'trigger SOL long 95 tp',           hint: 'Equivalent of `tp` (verb-first form)' },
      { cmd: 'orders',                           hint: 'Show all open limit orders + TP/SL triggers (numbered)' },
      { cmd: 'cancel 0',                         hint: 'Cancel order #0 from the last `orders` listing' },
      { cmd: 'cancel 0..4',                      hint: 'Cancel a range of orders' },
      { cmd: 'cancel all',                       hint: 'Cancel every open order' },
      { cmd: 'cancel-limit SOL long 0',          hint: 'Old form: cancel limit by market+side+id' },
      { cmd: 'cancel-trigger SOL 0 tp',          hint: 'Old form: cancel TP/SL by market+id+kind' },
    ],
  },
  {
    title: 'Setup',
    entries: [
      { cmd: 'init',                           hint: 'Bootstrap ~/.magic/.env (first run / npm install)' },
      { cmd: 'env',                            hint: 'Show env file path + current values (masked)' },
      { cmd: 'setup',                          hint: 'On-chain init: UDL + basket + delegate (idempotent)' },
      { cmd: 'doctor',                         hint: 'Full health probe — RPC, ER, oracle, wallet, SDK, disk' },
      { cmd: 'perf',                           hint: 'Read-cache hit rate + RPC latency telemetry' },
      { cmd: 'kill / resume',                  hint: 'Persistent kill switch — refuse / re-allow signing' },
      { cmd: 'feedback "msg"',                 hint: 'Save a local note + env fingerprint to ~/.magic/feedback.jsonl' },
      { cmd: 'ai',                             hint: 'Intent-layer status: model, credit budget, cache, fallbacks (ai on/off to toggle)' },
    ],
  },
  {
    title: 'RPC',
    entries: [
      { cmd: 'rpc',                            hint: 'Show active L1 RPC endpoint + latency' },
      { cmd: 'rpc list',                       hint: 'List every configured endpoint' },
      { cmd: 'rpc test',                       hint: 'Measure latency of every endpoint' },
      { cmd: 'rpc set <url>',                  hint: 'Switch primary RPC URL (persists to ~/.magic/config.json)' },
      { cmd: 'rpc add <url>',                  hint: 'Add a backup RPC endpoint' },
      { cmd: 'rpc remove <url>',               hint: 'Remove a backup endpoint' },
    ],
  },
  {
    title: 'Wallet',
    entries: [
      { cmd: 'wallet',                         hint: 'Show currently loaded wallet' },
      { cmd: 'wallet list',                    hint: 'List saved wallets' },
      { cmd: 'wallet use <name>',              hint: 'Switch to a saved wallet' },
      { cmd: 'wallet connect <path>',          hint: 'Load a keypair file (transient)' },
      { cmd: 'wallet disconnect',              hint: 'Clear the loaded keypair' },
      { cmd: 'wallet tokens',                  hint: 'Show wallet SPL token balances' },
    ],
  },
  {
    title: 'Vault',
    entries: [
      { cmd: 'deposit USDC 50',                hint: 'Fund the basket with 50 USDC' },
      { cmd: 'deposit SOL 0.1',                hint: 'Deposit 0.1 SOL collateral' },
      { cmd: 'deposit-direct <mint> 50',       hint: 'Low-level mint-based deposit builder' },
      { cmd: 'withdraw USDC 25',               hint: 'Withdraw 25 USDC to wallet' },
      { cmd: 'withdraw USDC all',              hint: 'Withdraw the entire available balance (`max` / `100%` also work)' },
      { cmd: 'request-withdrawal <mint> 25',   hint: 'Queue a pending withdrawal by raw mint' },
      { cmd: 'withdrawal-settle <mint>',       hint: 'Resume a pending withdrawal by raw mint' },
      { cmd: 'withdraw-status',                hint: 'Did the last withdraw actually land on-chain? (chain-truth)' },
      { cmd: 'withdraw-watch',                 hint: 'Tail in-flight withdraw confirmations until landed/expired' },
      { cmd: 'vault',                          hint: 'Show per-token balances + locked + available' },
      { cmd: 'account',                        hint: 'Flash Account vs wallet balance, side-by-side (V2)' },
      { cmd: 'acc',                            hint: 'Alias of `account`' },
      { cmd: 'settle',                         hint: 'Drain pending credits/debits across all custodies' },
      { cmd: 'settle USDC',                    hint: 'Settle one custody only' },
      { cmd: 'init-deposit-ledger',            hint: 'Initialize just the deposit ledger step' },
      { cmd: 'init-basket',                    hint: 'Initialize just the basket step' },
      { cmd: 'delegate-basket',                hint: 'Delegate basket to the ER (alias `delegate`)' },
    ],
  },
  {
    title: 'Portfolio & Markets',
    entries: [
      { cmd: 'portfolio',                      hint: 'On-chain positions (entry, mark, PnL, liq)' },
      { cmd: 'positions',                      hint: 'V2 positions endpoint for the loaded wallet' },
      { cmd: 'positions <owner>',              hint: 'V2 positions endpoint for any owner' },
      { cmd: 'holdings',                       hint: 'Alias of `portfolio`' },
      { cmd: 'dashboard',                      hint: 'Vault + positions + ER health + recent trades' },
      { cmd: 'history',                        hint: 'Recent trade journal (local) — alias `trades` / `journal`' },
      { cmd: 'markets',                        hint: 'All tradable markets, grouped, with leverage caps' },
      { cmd: 'markets crypto',                 hint: 'Filter to a category' },
      { cmd: 'price SOL',                      hint: 'Live oracle price for a market' },
      { cmd: 'verify',                         hint: 'CLI/UI parity audit — basket, deposits, positions' },
      { cmd: 'monitor',                        hint: 'Live market monitor TUI — Pyth prices, OI, long/short (q to exit)' },
      { cmd: 'er',                             hint: 'ER router health — latency, last error, failures (alias `health`)' },
      { cmd: 'close-all',                      hint: 'Close every open position (alias `closeall`)' },
      { cmd: 'unkill',                         hint: 'Re-arm signing after `kill` was triggered (alias `resume`)' },
    ],
  },
  {
    title: 'Flash V2 API',
    entries: [
      { cmd: 'health',                         hint: 'Flash V2 API health (`er` still checks the ER router)' },
      { cmd: 'tokens',                         hint: 'Supported V2 tokens' },
      { cmd: 'prices SOL',                     hint: 'V2 price for one symbol' },
      { cmd: 'pool-data',                      hint: 'V2 pool statistics' },
      { cmd: 'raw markets',                    hint: 'Raw V2 markets (also pools, custodies, perpetuals)' },
      { cmd: 'raw basket <pubkey>',            hint: 'Raw basket account by basket pubkey' },
      { cmd: 'snapshot',                       hint: 'Basket snapshot for the loaded wallet' },
      { cmd: 'preview margin <json>',          hint: 'Documented preview endpoint with exact JSON body' },
      { cmd: 'builder open-position <json>',   hint: 'Unsigned documented builder call' },
      { cmd: 'builder sign deposit <json>',    hint: 'Sign + submit a documented builder transaction' },
      { cmd: 'stream',                         hint: 'Bounded WebSocket basket stream' },
    ],
  },
];

/**
 * Cap a value for ANSI-aware padding. We compute the visible width of the
 * command (which contains no ANSI in HELP_GROUPS today, but defensive).
 */
function helpVisibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}
function helpPad(s: string, target: number): string {
  const need = target - helpVisibleLen(s);
  return need > 0 ? s + ' '.repeat(need) : s;
}

function renderHelp(_engine: ToolEngine): string {
  const cols = process.stdout.columns ?? 80;
  const ruleW = Math.max(40, Math.min(74, cols - 2));
  const heavy = '━'.repeat(ruleW);
  const light = '─'.repeat(ruleW);

  const lines: string[] = [];

  // ─── Header — brand bar + tagline ───────────────────────────────────────
  lines.push('');
  lines.push(`  ${c.faint(heavy)}`);
  lines.push(`  ${c.teal.bold(BRAND_NAME_UPPER)}   ${c.muted('Sub-second perpetuals on MagicBlock ER')}`);
  lines.push(`  ${c.faint(heavy)}`);
  lines.push('');

  // ─── Quick start lane — single most useful line in the file ────────────
  lines.push(`  ${c.cyan.bold('QUICK START')}`);
  lines.push(`     ${c.muted('1.')} ${c.teal.bold('init')}                     ${c.muted('# create ~/.magic/.env')}`);
  lines.push(`     ${c.muted('2.')} ${c.teal.bold('rpc set <https://...>')}    ${c.muted('# set a paid RPC (Helius/QuickNode/Triton)')}`);
  lines.push(`     ${c.muted('3.')} ${c.teal.bold('setup')}                    ${c.muted('# on-chain UDL + basket + delegate')}`);
  lines.push(`     ${c.muted('4.')} ${c.teal.bold('deposit USDC 50')}          ${c.muted('# fund the basket')}`);
  lines.push(`     ${c.muted('5.')} ${c.teal.bold('long SOL 5 2x')}            ${c.muted('# open a 2x long with 5 USDC collateral')}`);
  lines.push(`     ${c.muted('6.')} ${c.teal.bold('monitor')}                  ${c.muted('# live market TUI (q to exit)')}`);
  lines.push('');

  // ─── Trading syntax cheatsheet ─────────────────────────────────────────
  lines.push(`  ${c.cyan.bold('SYNTAX')}    ${c.muted('Side-first or verb-first; both work everywhere.')}`);
  lines.push(`     ${c.long.bold('long')}  ${c.muted('|')}  ${c.short.bold('short')}  ${c.muted('|')}  ${c.primary('open')}  ${c.muted('|')}  ${c.primary('close')}  ${c.muted('|')}  ${c.primary('limit')}  ${c.muted('|')}  ${c.primary('reverse')}  ${c.muted('|')}  ${c.primary('partial')}  ${c.muted('|')}  ${c.primary('add')}  ${c.muted('/')}  ${c.primary('remove')}`);
  lines.push(`     ${c.faint('Args order:  <market> <side?> <collateral> <leverage> [tp <px>] [sl <px>]')}`);
  lines.push('');

  // ─── Groups, two columns where it fits ──────────────────────────────────
  for (const group of HELP_GROUPS) {
    lines.push(`  ${c.cyan.bold(group.title.toUpperCase())}`);
    const cmdW = Math.max(...group.entries.map((e) => e.cmd.length)) + 2;
    for (const e of group.entries) {
      lines.push(`     ${c.teal(helpPad(e.cmd, cmdW))} ${c.muted(e.hint)}`);
    }
    lines.push('');
  }

  // ─── Built-ins ──────────────────────────────────────────────────────────
  // Use the SAME dynamic padding rule as the groups above so the cmd column
  // visually aligns instead of hard-coding 20 (which leaves an awkward gap
  // for short names and clips longer ones once we add more built-ins).
  const builtIns: HelpEntry[] = [
    { cmd: 'help',         hint: 'Show this help screen' },
    { cmd: 'help <cmd>',   hint: 'Per-verb usage hint (e.g. ' + c.teal.italic('help open') + ')' },
    { cmd: 'clear',        hint: 'Clear the screen' },
    { cmd: 'exit / quit',  hint: 'Close the terminal' },
  ];
  lines.push(`  ${c.cyan.bold('BUILT-INS')}`);
  const builtInW = Math.max(...builtIns.map((e) => e.cmd.length)) + 2;
  for (const e of builtIns) {
    lines.push(`     ${c.teal(helpPad(e.cmd, builtInW))} ${c.muted(e.hint)}`);
  }
  lines.push('');

  // ─── Footer — agent + safety pointers ──────────────────────────────────
  lines.push(`  ${c.faint(light)}`);
  lines.push(`  ${c.muted('Agent mode:')}  ${c.cyan('NO_DNA=1 magic <verb>')}  ${c.muted('→ JSON output, no prompts (https://no-dna.org)')}`);
  lines.push(`  ${c.muted('Health:')}      ${c.cyan('doctor')} ${c.muted('and')} ${c.cyan('perf')} ${c.muted('show RPC / cache / ER state at a glance')}`);
  lines.push(`  ${c.muted('Safety:')}      ${c.cyan('kill')} ${c.muted('refuses signing across restarts; ')}${c.cyan('resume')} ${c.muted('to re-enable')}`);
  lines.push(`  ${c.muted('Tab + ↑↓:')}   ${c.muted('verb completion + history navigation')}`);
  lines.push('');
  return lines.join('\n');
}

// ─── Magic Terminal ───────────────────────────────────────────────────────────

export class MagicTerminal {
  private config: MagicConfig;
  private walletManager: WalletManager;
  private engine: ToolEngine;
  private context: ToolContext;
  private rl: Interface;
  private processing = false;
  /**
   * Tracks the last command's failure state. The interactive REPL never
   * reads it (errors are surfaced inline + we keep going), but the
   * one-shot path (`runOnce`) uses it to set the process exit code.
   * Reset to `false` at the top of every `handle()`.
   */
  private lastFailed = false;

  /**
   * True once the interactive REPL loop is running (`start()`), false in the
   * one-shot (`runOnce`) / agent path. Gates the guided `init` onboarding —
   * chaining setup + deposit prompts only makes sense in a live session, never
   * in a run-and-exit `magic init`.
   */
  private inRepl = false;

  /**
   * Tiered intent resolver (deterministic-first; AI is advisory-only and
   * re-parsed through the same `parseCommand` firewall). Disabled entirely in
   * agent mode (`NO_DNA`) and under `--no-ai` so the trading path never depends
   * on AI. See src/ai/interpret.ts.
   */
  private readonly aiResolver: IntentResolver;

  constructor(config: MagicConfig, walletManager: WalletManager) {
    this.config = config;
    this.walletManager = walletManager;
    this.engine = getEngine();
    this.context = { walletManager, config };
    // AI is off for agents (NO_DNA) and under `--no-ai`; otherwise it activates
    // only when ANTHROPIC_API_KEY is set. The resolver is safe to build either
    // way — a disabled resolver simply always returns the deterministic result.
    const noAi = process.argv.includes('--no-ai') || !!process.env.NO_DNA;
    this.aiResolver = new IntentResolver(loadAiConfig(noAi));
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: this.makePrompt(),
      terminal: true,
      // Tab completion for verbs. Only completes the first token; once the
      // user is past the verb we don't second-guess what asset / amount they
      // want. Returns the full candidate set on empty input so `tab` shows
      // every available verb.
      completer: (line: string): [string[], string] => {
        const trimmed = line.trimStart();
        // Don't complete past the first space — the rest is verb-specific args.
        if (trimmed.includes(' ')) return [[], line];
        const verbs = new Set<string>([
          ...Object.keys(VERB_ALIASES),
          'help', 'exit', 'quit', 'clear', 'wallet', 'rpc', 'monitor', 'watch',
          'kill', 'resume', 'init', 'env', 'feedback', 'ai',
        ]);
        const matches = Array.from(verbs)
          .filter((v) => v.startsWith(trimmed.toLowerCase()))
          .sort();
        return [matches, trimmed];
      },
    });
    // Register the readline interface so background tickers (RPC failover
    // banner, ER tx post-confirm warnings, alert dispatches) can write
    // without corrupting the prompt the user is typing on.
    bindReadline(this.rl);
  }

  private makePrompt(): string {
    // Surface the kill-switch in the prompt so the user is reminded every
    // line that signing is currently disabled — no chance of typing
    // `open SOL ...`, hitting enter, then realising halfway through the
    // wait that nothing is going to land. `isKilled()` is a single existsSync
    // call, well within any prompt-rendering budget.
    let killBadge = '';
    try {
      if (isKilled()) killBadge = `${c.short.bold('●KILL ')}`;
    } catch { /* no badge */ }
    // Persistent, never-hidden regex-only indicator: shown only when AI WAS
    // available (key present, not --no-ai) but is currently suppressed
    // (session-off or budget cap reached) — so the user always knows.
    let aiBadge = '';
    try {
      if (this.aiResolver?.regexOnly) aiBadge = `${c.faint('⌁regex ')}`;
    } catch { /* no badge */ }
    return `${killBadge}${aiBadge}${c.teal.bold('flash')} ${c.muted('›')} `;
  }

  /**
   * Cold-start path: render banner, pre-warm the SDK client, install signal
   * handlers, then enter the readline loop.
   */
  async start(): Promise<void> {
    this.inRepl = true;
    initLogger({
      logFile: join(homedir(), '.magic', 'magic.log'),
      level: LogLevel.Info,
    });
    initSigningGuard({
      maxCollateralPerTrade: this.config.maxCollateralPerTrade,
      maxPositionSize: this.config.maxPositionSize,
      maxLeverage: this.config.maxLeverage,
      maxTradesPerMinute: this.config.maxTradesPerMinute,
      minDelayBetweenTradesMs: this.config.minDelayBetweenTradesMs,
    });

    const programId = this.resolveProgramId();
    process.stdout.write(
      renderSession({
        network: this.config.network,
        pool: this.config.poolName,
        programId,
        walletAddress: this.walletManager.address ?? undefined,
        erUrl: this.config.erRpcUrl,
      }),
    );

    // Loud warning when the user is on the public Solana RPC. Public RPCs
    // are rate-limited so aggressively that the polling-side of every L1 op
    // hits "block height exceeded" before confirmation. We surface this
    // BEFORE the user types their first command so they don't waste time
    // wondering why deposits/withdraws/settles "fail".
    if (/api\.(mainnet-beta|devnet)\.solana\.com/i.test(this.config.l1RpcUrl)) {
      process.stdout.write([
        '',
        `  ${c.warn.bold('⚠  Public RPC detected')}  ${c.muted('— this will be slow.')}`,
        `  ${c.muted('Public api.mainnet-beta.solana.com is rate-limited and times out polling for confirmations,')}`,
        `  ${c.muted('which surfaces as "block height exceeded" on deposit / withdraw / settle.')}`,
        '',
        `  ${c.muted('Fix in ~60 seconds:')}`,
        `     1. ${c.muted('Get a free key from')} ${c.cyan('helius.dev')} ${c.muted('/')} ${c.cyan('quicknode.com')} ${c.muted('/')} ${c.cyan('triton.one')}`,
        `     2. ${c.teal.bold('rpc set https://<your-rpc-url>')}    ${c.muted('# persists to ~/.magic/config.json')}`,
        `     3. ${c.teal.bold('rpc test')}                          ${c.muted('# verify latency drops to ~50–150ms')}`,
        '',
      ].join('\n'));
    }

    // Pre-warm the SDK client so the first trade is fast.
    if (this.walletManager.isConnected) {
      const kp = this.walletManager.getKeypair();
      if (kp) {
        try {
          const warmed = prewarmMagicClient({
            walletKeypair: kp,
            network: this.config.network,
            poolName: this.config.poolName,
            erEndpoint: this.config.erRpcUrl,
            l1Url: this.config.l1RpcUrl,
            programIdOverride: this.config.programIdOverride,
            prioritizationFee: this.config.computeUnitPrice,
            fastConfirm: this.config.fastConfirm,
          });
          // Hand the warmed client to the reconciler — it will pull live state
          // ~1.5s after start and again every 60s, surfacing any drift between
          // the CLI's idea of positions/orders and what the program reports.
          try {
            const { getReconciler } = await import('../core/state-reconciliation.js');
            getReconciler().setClient(warmed);
          } catch (err) {
            getLogger().warn('startup', `reconcile init failed: ${err instanceof Error ? err.message : String(err)}`);
          }

          // Spin up the in-process volume indexer so V2-only markets that
          // fstats doesn't track (MON, SUI, AMZN, …) accumulate per-symbol
          // 24 h volume from ER program logs. Fire-and-forget — the monitor
          // reads from `getVolumeIndexer()` and renders '—' until a market
          // sees its first event.
          try {
            const sdkAny = (warmed as unknown as {
              sdk: { program: import('@coral-xyz/anchor').Program; erConnection: import('@solana/web3.js').Connection };
              poolConfig: import('@flash_trade/magic-trade-client').PoolConfig;
            });
            if (sdkAny.sdk.program && sdkAny.sdk.erConnection) {
              const { VolumeIndexer, setVolumeIndexer } = await import('../data/volume-indexer.js');
              const indexer = new VolumeIndexer(sdkAny.sdk.erConnection, sdkAny.sdk.program, sdkAny.poolConfig);
              setVolumeIndexer(indexer);
              indexer.start().catch((err: Error) =>
                getLogger().debug('volume-indexer', `start failed: ${err.message}`),
              );
            }
          } catch (err) {
            getLogger().warn('startup', `volume indexer init failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        } catch (err) {
          getLogger().warn('startup', `pre-warm failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    this.installSignalHandlers();
    this.installLineHandler();
    this.rl.prompt();

    await new Promise<void>((resolve) => this.rl.once('close', () => resolve()));
  }

  private resolveProgramId(): string {
    if (this.config.programIdOverride) return this.config.programIdOverride;
    try {
      const cluster = this.config.network === 'devnet' ? 'devnet' : 'mainnet-beta';
      const p = getPoolConfig(this.config.poolName, cluster);
      return new PublicKey(p.programId).toBase58();
    } catch {
      return '—';
    }
  }

  private installSignalHandlers(): void {
    const cleanShutdown = (signal: string): void => {
      process.stdout.write(`\n${c.muted(`received ${signal}, shutting down…`)}\n`);
      this.shutdown().finally(() => process.exit(0));
    };
    // SIGINT during a trade: a single Ctrl-C used to force-exit, leaving the
    // user with no visibility into whether their already-submitted trade
    // landed. Now: if processing, warn once and require a second Ctrl-C
    // within 3 s to force exit. Quiescent state still exits on first press.
    let lastSigintAt = 0;
    process.on('SIGINT', () => {
      const now = Date.now();
      if (this.processing && now - lastSigintAt > 3_000) {
        lastSigintAt = now;
        process.stdout.write(
          `\n  ${c.warn('⚠')} ${c.muted('trade in flight — press Ctrl-C again within 3 s to force exit')}\n`,
        );
        return;
      }
      cleanShutdown('SIGINT');
    });
    // SIGTERM is owned by `src/index.ts` — it registers a single handler
    // that calls `terminal.shutdown()`. Registering one HERE too caused
    // `shutdown()` to run twice on a kill signal (rl.close() throws on
    // the second call, alerts/reconciler/timers are stopped twice). Idempotency
    // in shutdown() guards against the double-fire if anything still races.
  }

  private installLineHandler(): void {
    this.rl.on('line', async (raw) => {
      if (this.processing) {
        // Buffered input is dropped silently while a command runs to avoid races.
        return;
      }
      const line = raw.trim();
      if (line.length === 0) {
        this.rl.prompt();
        return;
      }
      this.processing = true;
      try {
        await this.handle(line);
      } catch (err) {
        process.stdout.write(`${chalk.red('error: ')}${err instanceof Error ? err.message : String(err)}\n`);
      } finally {
        this.processing = false;
        this.rl.prompt();
      }
    });
  }

  /** Route a single command line. */
  /**
   * Pre-sign confirmation card — the gate between intent and on-chain
   * effect. Same accent-bar visual identity as the success cards, so the
   * confirm → fire → success sequence reads as one coherent visual flow.
   *
   * Improvements over the v1 (bolt-terminal) gate:
   *   - Same `renderCard` accent bar as success cards (was plain text)
   *   - Two-column body when ≥4 rows fit, single-column otherwise
   *   - Risk metrics surfaced prominently — distance-to-liq with color band
   *   - TP / SL show absolute price + % delta from entry
   *   - Live countdown in the prompt (`auto-cancel in 1:59`)
   *   - Discard pre-typed input on live mode so the user must SEE the card
   *     before deciding (prevents accidental auto-confirmation)
   *   - 120 s timeout, unref'd
   *
   * Returns true on yes; false on no / timeout / cancellation.
   */
  private async confirmTrade(parsed: ParsedCommand, aiInterpreted = false): Promise<boolean> {
    const { renderCard, marketHeader, c: theme, DIAMOND } = await import('./magic-theme.js');
    void theme; // keep `c` (the file-level alias) as the in-method palette

    // AI-interpreted orders get an explicit "verify these values" banner above
    // the card — the human is the last line of defence against a mis-parse.
    if (aiInterpreted) {
      process.stdout.write(
        `  ${c.warn('⚠ AI-interpreted order')} ${c.muted('— verify the values below before confirming.')}\n`,
      );
    }

    const fmtUsd = (v: number): string =>
      `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const fmtPx = (v: number): string => {
      if (!Number.isFinite(v) || v <= 0) return c.muted('—');
      if (v >= 1000) return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      if (v >= 1) return `$${v.toFixed(4)}`;
      return `$${v.toFixed(6)}`;
    };
    const fmtPctSigned = (v: number): string => {
      if (!Number.isFinite(v)) return '';
      const sign = v >= 0 ? '+' : '';
      return `${sign}${v.toFixed(2)}%`;
    };

    // Verb-specific titles. Better than `Confirm open` because the user
    // sees the actual on-chain effect, not the parser alias.
    const titleMap: Record<string, string> = {
      'open':              'Open Position',
      'close':             'Close Position',
      'reverse':           'Reverse Position',
      'increase':          'Increase Position',
      'partial-close':     'Partial Close',
      'add-collateral':    'Add Collateral',
      'remove-collateral': 'Remove Collateral',
      'place-limit':       'Place Limit',
      'cancel':            'Cancel Order',
      'cancel-limit':      'Cancel Limit',
      'cancel-trigger':    'Cancel Trigger',
      'trigger-order':     'Place Trigger',
      'set-triggers':      'Set TP / SL',
      'liquidate':         'Liquidate Position',
      'close-all':         'Close All Positions',
      'deposit':           'Deposit to Vault',
      'withdraw':          'Withdraw from Vault',
      'settle':            'Settle Custody',
      'setup':             'On-Chain Setup',
      'builder':           'V2 Builder',
    };
    const title = titleMap[parsed.alias] ?? parsed.alias.replace(/^./, (s) => s.toUpperCase());

    let subtitle = '';
    const rows: { label: string; value: string }[] = [];
    let columnsHint: 1 | 2 = 1;

    if (parsed.alias === 'open') {
      const market = String(parsed.params.market ?? '').toUpperCase();
      const sideStr = String(parsed.params.side ?? 'long').toLowerCase();
      const rawCollateral = Number(parsed.params.collateral ?? 0);
      const rawLeverage = Number(parsed.params.leverage ?? 0);
      // Hard guards against NaN / Infinity slipping into the confirm
      // card. Either would render as `NaN x` / `$NaN`, breaking trust
      // and (worse) bypassing the per-trade size cap silently. Reject
      // by zeroing — the downstream `previewOpen` call then surfaces
      // a real error rather than us pretending the trade is legitimate.
      const collateral = Number.isFinite(rawCollateral) && rawCollateral > 0 ? rawCollateral : 0;
      const leverage = Number.isFinite(rawLeverage) && rawLeverage > 0 ? rawLeverage : 0;
      const collateralToken = parsed.params.collateralToken
        ? String(parsed.params.collateralToken).toUpperCase()
        : 'USDC';
      subtitle = marketHeader(market, sideStr, leverage);
      try {
        const { buildMagicClient } = await import('../tools/magic-tools.js');
        const { TradeSide } = await import('../types/index.js');
        const client = buildMagicClient(this.context);
        const side = sideStr === 'short' ? TradeSide.Short : TradeSide.Long;
        const preview = await client.previewOpen(market, side, collateral, leverage, collateralToken);

        // Compose the Liquidation row with an inline risk badge:
        //   `$0.4997  ◐ 49.91%`
        // Visual hierarchy: price first (the number you act on), then a
        // risk dot color-coded by distance to liquidation, then the
        // percentage. Single row beats two — used to eat 4 lines, now 2.
        let liqValue = c.muted('—');
        if (preview.liquidationPrice > 0) {
          const px = c.warn(fmtPx(preview.liquidationPrice));
          if (preview.entryPrice > 0) {
            const distPct = Math.abs(preview.entryPrice - preview.liquidationPrice) / preview.entryPrice * 100;
            // Risk band glyph + color:
            //   ●  > 30%  safe
            //   ◐  10–30% warn
            //   ●  <10%   danger (red)
            const dot = distPct > 30 ? c.long('●') : distPct > 10 ? c.warn('◐') : c.short('●');
            const pctC = distPct > 30 ? c.long : distPct > 10 ? c.warn : c.short;
            liqValue = `${px}  ${dot} ${pctC(`${distPct.toFixed(2)}%`)}`;
          } else {
            liqValue = px;
          }
        }

        rows.push({ label: 'Pay',         value: c.primary(`${fmtUsd(collateral)} ${collateralToken}`) });
        rows.push({ label: 'Size',        value: c.primary.bold(fmtUsd(preview.sizeUsd)) });
        rows.push({ label: 'Entry',       value: c.primary(fmtPx(preview.entryPrice)) });
        rows.push({ label: 'Liquidation', value: liqValue });
        // Hide Open Fee when it's effectively zero — eliminates a row
        // that's $0.00 in 99% of cases. The user can still see fees in
        // the success card if they want; here it's noise.
        if ((preview.feeUsd ?? 0) >= 0.005) {
          rows.push({ label: 'Open Fee', value: c.muted(fmtUsd(preview.feeUsd ?? 0)) });
        }
        // Swap row historically exposed Flash's lock-asset mechanic
        // (SUI long → BTC lock). It read as "your USDC becomes BTC",
        // which is wrong — the position is SUI. Omitted; power users
        // can run `markets <sym>` for the lock structure.
        if ((parsed.params.tp as number | undefined) !== undefined) {
          const tp = parsed.params.tp as number;
          const pct = preview.entryPrice > 0
            ? (sideStr === 'short' ? -1 : 1) * ((tp - preview.entryPrice) / preview.entryPrice) * 100
            : NaN;
          rows.push({
            label: 'Take Profit',
            value: `${c.long(fmtPx(tp))}  ${c.muted(fmtPctSigned(pct))}`,
          });
        }
        if ((parsed.params.sl as number | undefined) !== undefined) {
          const sl = parsed.params.sl as number;
          const pct = preview.entryPrice > 0
            ? (sideStr === 'short' ? 1 : -1) * ((preview.entryPrice - sl) / preview.entryPrice) * 100
            : NaN;
          rows.push({
            label: 'Stop Loss',
            value: `${c.short(fmtPx(sl))}  ${c.muted(fmtPctSigned(pct))}`,
          });
        }
        columnsHint = rows.length >= 4 ? 2 : 1;
      } catch (err) {
        rows.push({ label: 'Pay',      value: c.primary(`${collateral} ${collateralToken}`) });
        rows.push({ label: 'Leverage', value: c.primary(`${leverage}x`) });
        rows.push({ label: 'Preview',  value: c.short(`unavailable — ${getErrorMessage(err)}`) });
      }
    } else if (parsed.alias === 'close' || parsed.alias === 'reverse' || parsed.alias === 'partial-close' || parsed.alias === 'increase') {
      const market = String(parsed.params.market ?? '').toUpperCase();
      const sideStr = String(parsed.params.side ?? '').toLowerCase();
      subtitle = sideStr ? marketHeader(market, sideStr) : c.primary.bold(market);
      if (parsed.params.amount !== undefined) rows.push({ label: 'Amount',  value: c.primary(fmtUsd(Number(parsed.params.amount))) });
      if (parsed.params.percent !== undefined) rows.push({ label: 'Percent', value: c.primary(`${Number(parsed.params.percent).toFixed(0)}%`) });
      if (parsed.params.receiveToken !== undefined) rows.push({ label: 'Receive in', value: c.primary(String(parsed.params.receiveToken).toUpperCase()) });
      if (rows.length === 0) rows.push({ label: 'Action', value: c.primary(parsed.alias.toUpperCase()) });
    } else if (parsed.alias === 'add-collateral' || parsed.alias === 'remove-collateral') {
      const market = String(parsed.params.market ?? '').toUpperCase();
      const sideStr = String(parsed.params.side ?? '').toLowerCase();
      subtitle = sideStr ? marketHeader(market, sideStr) : c.primary.bold(market);
      rows.push({ label: 'Amount', value: c.primary(fmtUsd(Number(parsed.params.amount ?? 0))) });
      if (parsed.params.token) rows.push({ label: 'Token', value: c.primary(String(parsed.params.token).toUpperCase()) });
    } else if (parsed.alias === 'deposit' || parsed.alias === 'withdraw') {
      const token = String(parsed.params.token ?? 'USDC').toUpperCase();
      const rawAmount = parsed.params.amount;
      // `withdraw <token> all|max|100%` arrives here as the literal
      // string `'max'`. Resolve it to the live basket balance for the
      // user-visible confirm card so they see the actual number they're
      // about to sign for, not `NaN USDC`. Fallback when balance read
      // fails: render the literal `max` (still informative).
      let amountLabel: string;
      if (rawAmount === 'max') {
        let resolved: number | null = null;
        try {
          const { buildMagicClient } = await import('../tools/magic-tools.js');
          const client = buildMagicClient(this.context);
          const bals = await client.getAvailableBalances();
          const v = bals.get(token)?.available;
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) resolved = v;
        } catch { /* fall through */ }
        amountLabel = resolved !== null
          ? `${resolved.toFixed(6).replace(/\.?0+$/, '')} ${token}  ${c.muted('(max)')}`
          : `max ${token}`;
      } else {
        const n = Number(rawAmount ?? 0);
        amountLabel = `${Number.isFinite(n) ? n : 0} ${token}`;
      }
      subtitle = `${DIAMOND}  ${c.primary.bold(token)}`;
      rows.push({ label: 'Token',  value: c.primary.bold(token) });
      rows.push({ label: 'Amount', value: c.primary(amountLabel) });
      if (parsed.alias === 'withdraw') {
        rows.push({ label: '', value: c.muted('2-step L1 request + L1 settle · ~1–2 s') });
      }
    } else {
      // Generic fallback — render whichever params are set.
      const market = String(parsed.params.market ?? '').toUpperCase();
      if (market) subtitle = c.primary.bold(market);
      for (const [k, v] of Object.entries(parsed.params)) {
        if (v === undefined || v === null) continue;
        const label = k.charAt(0).toUpperCase() + k.slice(1);
        rows.push({ label, value: c.primary(String(v)) });
      }
    }

    process.stdout.write(renderCard({
      status: title,
      tone: 'warn',
      subtitle: subtitle || c.muted('pre-sign confirmation'),
      columns: columnsHint,
      rows,
    }));

    // 120s auto-cancel with a live countdown so the user knows how long
    // they have. The countdown rewrites in place (single line) so the
    // REPL doesn't fill with timer ticks.
    const TIMEOUT_MS = 120_000;
    const startedAt = Date.now();
    // Single-line action prompt outside the card frame — card carries
    // data, prompt carries action. Enter is the obvious next step (the
    // user has already SEEN the card by the time the prompt appears).
    //
    // Layout:
    //   ↵ sign  ·  n cancel  ·  ⏲ 1:58
    //
    // Inspired by `fzf` / `lazygit` keystroke hints and the GitHub-CLI
    // (`gh`) prompt convention of showing the default action first.
    const promptText = (remaining: number): string => {
      const m = Math.floor(remaining / 60_000);
      const s = Math.floor((remaining % 60_000) / 1000);
      const mm = m.toString();
      const ss = s.toString().padStart(2, '0');
      return `  ${c.long.bold('y')} ${c.muted('sign')}  ${c.faint('·')}  ${c.cyan.bold('↵')} ${c.muted('cancel')}  ${c.faint('·')}  ${c.faint(`⏲ ${mm}:${ss}`)} `;
    };

    // We do NOT rely on flushing pre-typed input (readline buffers via the
    // input stream; there's nothing to clear synchronously). Instead, signing
    // requires an explicit `y` and empty/Enter cancels — so a stray Enter that
    // lands right after the card renders cancels rather than signs.

    const confirmed = await new Promise<boolean>((resolve) => {
      let settled = false;
      const tickHandle: NodeJS.Timeout = setInterval(() => {
        if (settled) return;
        const remaining = TIMEOUT_MS - (Date.now() - startedAt);
        if (remaining <= 0) return; // timeout-handler will fire
        // Rewrite the prompt line (carriage-return + clear-eol).
        try {
          process.stdout.write(`\r\x1b[2K${promptText(remaining)}`);
        } catch { /* stdout closed */ }
      }, 1000);
      tickHandle.unref?.();

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearInterval(tickHandle);
        try { process.stdout.write(`\n\n  ${c.warn('⏲')}  ${c.warn('Confirmation timed out')} ${c.muted('— trade cancelled.')}\n\n`); } catch { /* ignore */ }
        resolve(false);
      }, TIMEOUT_MS);
      timeout.unref?.();

      this.rl.question(promptText(TIMEOUT_MS), (a) => {
        if (settled) return;
        settled = true;
        clearInterval(tickHandle);
        clearTimeout(timeout);
        const trimmed = (a ?? '').trim();
        // Signing a real trade requires an EXPLICIT `y`/`yes`. Empty input
        // (a reflexive/stray Enter after the card renders) CANCELS — never
        // signs. This is the safe default for an irreversible money action.
        resolve(/^y(es)?$/i.test(trimmed));
      });
    });

    if (!confirmed) {
      process.stdout.write(`  ${c.muted('cancelled — no transaction sent.')}\n\n`);
    } else {
      process.stdout.write('\n');
    }
    return confirmed;
  }

  private async handle(line: string): Promise<void> {
    this.lastFailed = false;
    // Pasted-in / shell-history input often arrives with stray junk: a
    // trailing line-continuation backslash (`help\`), a stray semicolon, a
    // markdown bullet, etc. Strip the obvious cases so the user gets the
    // command they typed instead of a "did you mean: help?" miss.
    line = line
      .replace(/^[\s>•·*]+/, '')      // leading whitespace / quoting glyphs
      .replace(/[\s\\;,]+$/, '')      // trailing whitespace / `\` / `;` / `,`
      .trim();
    if (!line) return;
    const lower = line.toLowerCase();
    if (lower === 'help' || lower === '?') {
      process.stdout.write(renderHelp(this.engine));
      return;
    }
    // Common confusion: a user types `magic` (the binary name) inside the
    // REPL because they're following a doc that said "run `magic`". They're
    // already in it — show a friendly note + redirect to help instead of
    // the cryptic "unknown command".
    if (lower === 'magic' || lower === 'flash-magic') {
      process.stdout.write(
        `  ${c.muted('You are already inside')} ${c.teal.bold('magic')}${c.muted('. Type')} ${c.teal.bold('help')} ${c.muted('for the command list, or')} ${c.teal.bold('exit')} ${c.muted('to leave.')}\n`,
      );
      return;
    }
    // `help <verb>` — surface the per-verb USAGE_HINTS so users don't have to
    // scroll the full help page to find one example. Aliases are resolved
    // through VERB_ALIASES so `help o` works the same as `help open`.
    if (lower.startsWith('help ') || lower.startsWith('? ')) {
      const arg = lower.split(/\s+/, 2)[1]?.trim();
      if (arg) {
        const alias = VERB_ALIASES[arg] ?? arg;
        const hint = USAGE_HINTS[alias];
        if (hint) {
          process.stdout.write(`  ${c.muted('usage:')} ${c.teal.bold(hint)}\n`);
        } else {
          // Unknown — try did-you-mean over the alias map.
          const suggestion = nearestVerb(arg);
          process.stdout.write(
            `  ${c.muted(`no help for '${arg}'`)}` +
            (suggestion ? ` ${c.muted('— did you mean')} ${c.teal.bold(suggestion)}${c.muted('?')}` : '') +
            '\n',
          );
        }
      } else {
        process.stdout.write(renderHelp(this.engine));
      }
      return;
    }
    if (lower === 'exit' || lower === 'quit') {
      this.rl.close();
      return;
    }
    if (lower === 'clear') {
      process.stdout.write('\x1b[2J\x1b[H');
      return;
    }

    // Bump the wallet's idle timer on EVERY command so an active session
    // doesn't get auto-disconnected mid-trade by the 15-min security timeout.
    if (this.walletManager.isConnected) this.walletManager.resetIdleTimer();

    // `wallet ...` subcommands — manage the active wallet without exiting.
    if (lower === 'wallet' || lower.startsWith('wallet ')) {
      await this.handleWalletSubcommand(line);
      return;
    }

    // `rpc ...` subcommands — manage L1 RPC endpoints (set/add/remove/test/list).
    // Changes persist to ~/.magic/config.json so they survive restarts.
    if (lower === 'rpc' || lower.startsWith('rpc ')) {
      await this.handleRpcSubcommand(line);
      return;
    }

    // Persistent kill-switch — refuses every signing path until cleared.
    // Survives process restarts (~/.magic/disabled flag file).
    // `init` — first-run / npm-installed-user onboarding. Creates ~/.magic/
    // with .env and config.json from a template, prints next-step hints.
    // `init` accepts optional flags: --quick / -q (zero prompts) and
    // --devnet (default network = devnet). Anything else after `init`
    // is forwarded for the wizard to ignore.
    if (lower === 'init' || lower.startsWith('init ')) {
      const tokens = line.split(/\s+/).slice(1);
      await this.handleInit(tokens);
      return;
    }
    // `ai` — intent-layer status/telemetry + session on/off toggle. Read-only
    // control surface; it never touches the trading path.
    if (lower === 'ai' || lower === 'ai stats' || lower === 'ai on' || lower === 'ai off') {
      this.handleAiCommand(lower);
      return;
    }
    // `env` — show where the env file lives, what's currently set (masked),
    // and where the config.json lives.
    if (lower === 'env' || lower === 'env show') {
      await this.handleEnvShow();
      return;
    }

    // `feedback` — capture a free-form note in `~/.magic/feedback.jsonl`
    // with a sanitised env fingerprint so the user has structured forensic
    // context to attach when they file a bug. `feedback list` shows recent.
    if (lower === 'feedback' || lower === 'feedback list' || lower.startsWith('feedback ')) {
      await this.handleFeedback(line);
      return;
    }

    if (lower === 'kill' || lower.startsWith('kill ')) {
      const reason = line.slice(4).trim();
      const { killSwitchOn } = await import('../security/kill-switch.js');
      killSwitchOn(reason);
      process.stdout.write(
        `  ${c.warn('●')} ${c.short.bold('SIGNING DISABLED')}` +
        (reason ? ` — ${c.muted(reason)}` : '') +
        `\n  ${c.muted('run')} ${c.teal.bold('resume')} ${c.muted("to re-enable")}\n`,
      );
      // Refresh the prompt so the badge appears on the next line without restart.
      this.rl.setPrompt(this.makePrompt());
      return;
    }
    if (lower === 'resume' || lower === 'unkill') {
      const { killSwitchState, killSwitchOff } = await import('../security/kill-switch.js');
      const before = killSwitchState();
      if (!before.active) {
        process.stdout.write(`  ${c.muted('signing was already enabled')}\n`);
        return;
      }
      killSwitchOff();
      process.stdout.write(`  ${c.long('●')} ${c.teal.bold('signing re-enabled')}\n`);
      this.rl.setPrompt(this.makePrompt());
      return;
    }

    // Live market monitor — TUI mode owns stdin while it runs.
    // Verb-only intercept here (NOT in parseCommand) because the TUI needs
    // direct readline access; routing it through the engine would lose `rl`.
    if (lower === 'monitor' || lower === 'watch' || lower.startsWith('monitor ') || lower.startsWith('watch ')) {
      const filter = line.split(/\s+/).slice(1)[0];
      const { runV2MarketMonitor } = await import('./v2-market-monitor.js');
      const { buildMagicClient } = await import('../tools/magic-tools.js');
      const client = buildMagicClient(this.context);
      await runV2MarketMonitor({ rl: this.rl, client }, filter);
      return;
    }

    // ── Tiered intent resolution ────────────────────────────────────────
    // Deterministic parse first (Tier 0/1). Only on a deterministic miss, for
    // a plausible trade phrasing, with AI enabled + in-budget + reachable, is
    // the model consulted (Tier 2) — and its output is a mere command STRING
    // re-parsed through THIS SAME parseCommand. AI never yields a command that
    // didn't pass deterministic validation. See src/ai/interpret.ts.
    let resolution: ResolveResult;
    try {
      resolution = await this.aiResolver.resolve(line, (l) => parseCommand(l, this.config));
    } catch (err) {
      // Ambiguous fuzzy match — show the candidates so the user can retype
      // unambiguously. Better to refuse than to route a trade to the wrong
      // asset.
      this.lastFailed = true;
      const msg = err instanceof Error ? err.message : String(err);
      if (process.env.NO_DNA) {
        process.stderr.write(JSON.stringify({
          ts: new Date().toISOString(),
          kind: 'error',
          code: 'AMBIGUOUS',
          message: msg,
        }) + '\n');
      } else {
        process.stdout.write(`${chalk.red('ambiguous: ')}${msg}\n`);
      }
      return;
    }
    const parsed: ParsedCommand | null = resolution.command;
    if (!parsed) {
      this.lastFailed = true;
      const firstTok = line.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
      const suggestion = firstTok ? nearestVerb(firstTok) : null;
      if (process.env.NO_DNA) {
        process.stderr.write(JSON.stringify({
          ts: new Date().toISOString(),
          kind: 'error',
          code: 'UNKNOWN_COMMAND',
          message: `unknown command: ${line}`,
          ...(suggestion ? { suggestion } : {}),
          ...(resolution.degraded && resolution.fallbackReason ? { aiFallback: resolution.fallbackReason } : {}),
        }) + '\n');
      } else {
        const hint = suggestion
          ? ` ${c.muted('— did you mean')} ${c.teal.bold(suggestion)}${c.muted('?')}`
          : ` ${c.muted("type 'help' to see commands")}`;
        process.stdout.write(`${chalk.red('unknown command: ')}${line}${hint}\n`);
        // Visible, non-hidden signal that AI understanding was unavailable.
        if (resolution.degraded && resolution.fallbackReason) {
          process.stdout.write(`  ${c.faint(`(regex-only: ${resolution.fallbackReason} — plain commands still work; try 'help')`)}\n`);
        }
      }
      return;
    }
    // AI-interpreted commands are shown verbatim and ALWAYS require an explicit
    // confirm (below) so a mis-parse is caught by the human, not trusted.
    if (resolution.aiInterpreted && !process.env.NO_DNA) {
      process.stdout.write(
        `  ${c.warn('◆ AI-interpreted')} ${c.faint(`"${line}"`)} ${c.muted('→')} ${c.teal.bold(resolution.aiSource ?? '')}\n`,
      );
    }

    // Pre-sign confirmation gate. When `MAGIC_AUTO_CONFIRM=false`, render a
    // one-shot preview of money-touching commands and require explicit `y`
    // before dispatch. The default is `false` (confirm gate ON); a power user
    // can set `MAGIC_AUTO_CONFIRM=true` to preserve the fast trading flow, but from
    // a shared host or via paste is one env var away from a real preview step.
    const needsSigningConfirm =
      SIGNING_VERBS.has(parsed.alias) && !(parsed.alias === 'builder' && parsed.params.sign !== true);
    // An AI-interpreted order is confirmed even when autoConfirm is on — the
    // human must verify the interpreted values before anything signs.
    const forceConfirm = resolution.aiInterpreted;
    if ((!this.config.autoConfirm || forceConfirm) && needsSigningConfirm) {
      // NO_DNA agent mode: the spec says "never prompt — fail or use sensible
      // defaults". With autoConfirm=false, "fail" is the only safe default
      // (the alternative would be auto-signing without preview, which is
      // exactly what the user opted out of). Tell the agent why explicitly.
      if (process.env.NO_DNA) {
        this.lastFailed = true;
        const errLine = JSON.stringify({
          ts: new Date().toISOString(),
          kind: 'error',
          alias: parsed.alias,
          code: 'CONFIRM_REQUIRED',
          message:
            'autoConfirm is false and NO_DNA blocks interactive prompts. ' +
            'Set MAGIC_AUTO_CONFIRM=true to allow agent-driven signing.',
        });
        process.stderr.write(errLine + '\n');
        return;
      }
      const proceed = await this.confirmTrade(parsed, resolution.aiInterpreted);
      if (!proceed) {
        this.lastFailed = true;
        process.stdout.write(c.muted('  cancelled.\n'));
        return;
      }
    }

    const startedAt = Date.now();
    let result: ToolResult;
    try {
      // withSpinner is a no-op if (a) we're in NO_DNA/non-TTY mode or
      // (b) the dispatch resolves within 200ms. So the happy path
      // (cache-hit reads, fast trades) shows nothing; only genuinely slow
      // ops surface a "submitting…" indicator.
      result = await withSpinner(
        spinnerLabelFor(parsed.alias),
        () => this.engine.dispatch(parsed.alias, parsed.params, this.context),
      );
    } catch (err) {
      this.lastFailed = true;
      const msg = err instanceof Error ? err.message : String(err);
      if (process.env.NO_DNA) {
        process.stderr.write(JSON.stringify({
          ts: new Date().toISOString(),
          kind: 'error',
          alias: parsed.alias,
          message: msg,
        }) + '\n');
      } else {
        process.stdout.write(`${chalk.red('error: ')}${msg}\n`);
      }
      return;
    }
    if (!result.success) this.lastFailed = true;

    const elapsed = Date.now() - startedAt;
    if (process.env.NO_DNA) {
      // Structured JSON for agents — stable shape, ISO timestamp, both
      // human-readable message and structured data preserved. Streamed on
      // stdout so the line buffer can be split on `\n` by the caller.
      const record = {
        ts: new Date().toISOString(),
        kind: 'result',
        alias: parsed.alias,
        success: result.success,
        message: result.message,
        elapsedMs: elapsed,
        ...(result.txSignature ? { txSignature: result.txSignature } : {}),
        ...(result.data ? { data: result.data } : {}),
      };
      process.stdout.write(JSON.stringify(record) + '\n');
    } else {
      const head = result.success ? '' : chalk.red('error: ');
      let resultMessage = result.message;
      // When Zod rejects params, append a one-line usage hint so the user
      // knows exactly what shape the command wants instead of decoding the
      // raw error.
      if (!result.success && /Invalid parameters/i.test(result.message)) {
        const hint = USAGE_HINTS[parsed.alias];
        if (hint) resultMessage += `\n${c.muted('  usage: ')}${c.teal.bold(hint)}`;
      }
      process.stdout.write(`${head}${resultMessage}\n`);
      process.stdout.write(`${c.muted('  → ')}${latencyPill(elapsed)}\n`);
    }

    // Update session stats for trade-y verbs.
    if (result.success && (parsed.alias === 'open' || parsed.alias === 'close')) {
      const data = (result.data ?? {}) as { pnlUsd?: number };
      recordMagicAction({ type: parsed.alias as 'open' | 'close', pnlUsd: data.pnlUsd });
    }

    // Journal every signed action that produced a real on-chain signature so
    // `magic history` / `journal` reflects the full trail (cancellations,
    // settles, withdraws, trigger flips — not just open/close). Silent
    // sentinels (`already-landed`, `expired-but-landed`) are filtered inside
    // journalMagicTrade so we don't double-check here.
    if (result.success && result.txSignature) {
      const aliasToType: Record<string, import('../security/magic-history.js').MagicTradeEntry['type'] | undefined> = {
        'open': 'open',
        'close': 'close',
        'partial-close': 'partial_close',
        'increase': 'increase',
        'reverse': 'reverse',
        'add-collateral': 'add_collateral',
        'remove-collateral': 'remove_collateral',
        'place-limit': 'limit_place',
        'cancel-limit': 'limit_cancel',
        'cancel-trigger': 'trigger_cancel',
        'cancel': 'limit_cancel',
        'liquidate': 'liquidate',
        'deposit': 'deposit',
        'withdraw': 'withdraw',
        'settle': 'settle',
      };
      const type = aliasToType[parsed.alias];
      if (type) {
        const market = (parsed.params.market as string | undefined);
        const sideRaw = (parsed.params.side as string | undefined);
        const side: 'long' | 'short' | undefined =
          sideRaw === 'short' ? 'short' : sideRaw === 'long' ? 'long' : undefined;
        const data = (result.data ?? {}) as Record<string, unknown>;
        const num = (v: unknown): number | undefined =>
          typeof v === 'number' && Number.isFinite(v) ? v : undefined;
        journalMagicTrade(this.context, type, {
          ...(market ? { market } : {}),
          ...(side ? { side } : {}),
          collateralUsd: num(data.collateralUsd) ?? num((parsed.params as Record<string, unknown>).collateralUsd),
          sizeUsd: num(data.sizeUsd),
          leverage: num(data.leverage) ?? num((parsed.params as Record<string, unknown>).leverage),
          triggerPriceUsd: num(data.triggerPriceUsd) ?? num((parsed.params as Record<string, unknown>).triggerPriceUsd),
          txSignature: result.txSignature,
        });
      }
    }
    void elapsed;
  }

  /**
   * `wallet ...` subcommands — mirror the v1 (`flash`) terminal so users can
   * switch / reconnect / inspect without exiting the CLI:
   *   wallet                — show current
   *   wallet status         — same as bare `wallet`
   *   wallet list           — list saved wallets
   *   wallet use <name>     — switch to a saved wallet
   *   wallet connect <path> — load a keypair file (transient, not saved)
   *   wallet disconnect     — clear the loaded keypair
   *   wallet tokens         — show wallet token balances (existing)
   */
  private async handleWalletSubcommand(line: string): Promise<void> {
    const parts = line.trim().split(/\s+/);
    const sub = (parts[1] ?? 'status').toLowerCase();
    const arg = parts[2];

    const { WalletStore } = await import('../wallet/wallet-store.js');
    const { tryConnectWallet } = await import('./wallet-flows.js');
    const { updateLastWallet } = await import('../wallet/session.js');
    const { shortAddress } = await import('../utils/format.js');
    const { shutdownMagicClients } = await import('../tools/magic-tools.js');
    const store = new WalletStore();

    const printStatus = () => {
      const addr = this.walletManager.address;
      if (addr) {
        process.stdout.write(`  ${c.long('●')} ${c.primary('Connected')}  ${c.muted(addr)}\n`);
      } else {
        process.stdout.write(`  ${c.short('○')} ${c.muted('No wallet loaded.')} ${c.muted('Run')} ${c.cyan('wallet use <name>')} ${c.muted('or')} ${c.cyan('wallet list')}.\n`);
      }
    };

    if (sub === 'status' || sub === '') {
      printStatus();
      return;
    }

    if (sub === 'list') {
      const wallets = store.listWallets();
      const def = store.getDefault();
      if (wallets.length === 0) {
        process.stdout.write(`  ${c.muted('No saved wallets.')}\n`);
        return;
      }
      for (const name of wallets) {
        const isCurrent = this.walletManager.address && (() => {
          try { return store.getAddress(name) === this.walletManager.address; }
          catch { return false; }
        })();
        const marker = isCurrent ? c.long('●') : c.muted('○');
        const tag = name === def ? c.yellow(' ★ default') : '';
        try {
          const addr = store.getAddress(name);
          process.stdout.write(`  ${marker}  ${c.primary.bold(name)}  ${c.muted(shortAddress(addr))}${tag}\n`);
        } catch {
          process.stdout.write(`  ${marker}  ${c.primary.bold(name)}${tag}\n`);
        }
      }
      return;
    }

    if (sub === 'use') {
      if (!arg) {
        process.stdout.write(`  ${c.muted('usage:')} ${c.cyan('wallet use <name>')}\n`);
        return;
      }
      const wallets = store.listWallets();
      // Case-insensitive lookup — `wallet use abdr` should match `ABDR`.
      const match = wallets.find((n) => n.toLowerCase() === arg.toLowerCase());
      if (!match) {
        const closeMatches = wallets.filter((n) => n.toLowerCase().includes(arg.toLowerCase()));
        const hint = closeMatches.length > 0
          ? `Did you mean ${closeMatches.map((n) => c.cyan(n)).join(', ')}?`
          : `Run ${c.cyan('wallet list')}.`;
        process.stdout.write(`  ${c.short('✖')} ${c.muted(`No wallet named "${arg}".`)} ${hint}\n`);
        return;
      }
      try {
        const path = store.getWalletPath(match);
        const info = tryConnectWallet(this.walletManager, path);
        if (!info) return;
        store.setDefault(match);
        updateLastWallet(match);
        shutdownMagicClients();
        // Drop the reconciler's reference to the prior wallet's client so it
        // doesn't keep pulling positions for the wrong account in the
        // background. The next trade pre-warms a fresh client and a new
        // reconciler attachment will be installed there.
        try {
          (await import('../core/state-reconciliation.js')).getReconciler().setClient(null);
        } catch { /* ignore */ }
        process.stdout.write(`  ${c.long('✔')} ${c.primary('Switched to')} ${c.primary.bold(match)}  ${c.muted(shortAddress(info.address))}\n`);
      } catch (err) {
        process.stdout.write(`  ${c.short('✖')} ${c.muted(getErrorMessage(err))}\n`);
      }
      return;
    }

    if (sub === 'connect') {
      if (!arg) {
        process.stdout.write(`  ${c.muted('usage:')} ${c.cyan('wallet connect <path-to-keypair.json>')}\n`);
        return;
      }
      // If `arg` looks like a bare name (no slash, no .json) and matches a
      // saved wallet (case-insensitive), redirect to `wallet use`. Saves the
      // user from getting "file not found" when they meant to switch.
      const looksLikeName = !arg.includes('/') && !arg.includes('\\') && !arg.endsWith('.json');
      if (looksLikeName) {
        const wallets = store.listWallets();
        const match = wallets.find((n) => n.toLowerCase() === arg.toLowerCase());
        if (match) {
          process.stdout.write(`  ${c.muted(`"${arg}" is a saved wallet — using`)} ${c.cyan(`wallet use ${match}`)} ${c.muted('instead.')}\n`);
          await this.handleWalletSubcommand(`wallet use ${match}`);
          return;
        }
      }
      const info = tryConnectWallet(this.walletManager, arg);
      if (!info) return;
      shutdownMagicClients();
      process.stdout.write(`  ${c.long('✔')} ${c.primary('Connected')}  ${c.muted(info.address)}\n`);
      return;
    }

    if (sub === 'disconnect') {
      this.walletManager.disconnect();
      shutdownMagicClients();
      process.stdout.write(`  ${c.long('✔')} ${c.muted('Wallet disconnected.')}\n`);
      return;
    }

    if (sub === 'tokens') {
      // Reuse the engine's deposit/balance reading via wallet manager directly.
      try {
        const { sol, tokens } = await this.walletManager.getTokenBalances();
        process.stdout.write(`  ${c.muted('SOL')}        ${c.primary(sol.toFixed(4))}\n`);
        for (const t of tokens) {
          process.stdout.write(`  ${c.muted(t.symbol.padEnd(10))} ${c.primary(t.amount.toString())}\n`);
        }
      } catch (err) {
        process.stdout.write(`  ${c.short('✖')} ${c.muted(getErrorMessage(err))}\n`);
      }
      return;
    }

    process.stdout.write(`  ${c.muted('unknown:')} ${c.cyan(`wallet ${sub}`)}. ${c.muted('Try')} ${c.cyan('wallet status | list | use <name> | connect <path> | disconnect | tokens')}.\n`);
  }

  /**
   * `rpc ...` subcommands — mirror the v1 (`flash`) terminal so users can
   * inspect / test / change L1 RPC endpoints from inside magic. Changes
   * persist to `~/.magic/config.json` so they survive restarts.
   *
   *   rpc                — show currently active endpoint (alias of `rpc status`)
   *   rpc status         — same
   *   rpc list           — list every configured endpoint with latency markers
   *   rpc test           — measure latency of every configured endpoint
   *   rpc set <url>      — switch active endpoint (adds if not present, persists)
   *   rpc add <url>      — append a backup endpoint (persists)
   *   rpc remove <url>   — remove a backup endpoint (cannot remove active)
   */
  private async handleRpcSubcommand(line: string): Promise<void> {
    const parts = line.trim().split(/\s+/);
    const sub = (parts[1] ?? 'status').toLowerCase();
    const arg = parts.slice(2).join(' ').trim();

    const { getRpcManager, maskRpcUrl } = await import('../network/rpc-manager.js');
    const { saveConfigField, validateRpcUrl, syncEnvLine } = await import('../config/index.js');
    const { shutdownMagicClients } = await import('../tools/magic-tools.js');
    const mgr = getRpcManager();
    if (!mgr) {
      process.stdout.write(`  ${c.short('✖')} ${c.muted('RPC manager not initialised.')}\n`);
      return;
    }

    if (sub === 'status' || sub === '') {
      const ep = mgr.activeEndpoint;
      const ms = await mgr.measureOne(ep.url);
      const latency = ms < 0 ? c.short('unreachable')
        : ms < 200 ? c.long(`${ms}ms`)
        : ms < 600 ? c.warn(`${ms}ms`)
        : c.short(`${ms}ms`);
      process.stdout.write(`  ${c.long('●')} ${c.primary.bold(ep.label)}  ${c.muted(maskRpcUrl(ep.url))}  ${latency}\n`);
      process.stdout.write(`  ${c.muted(`${mgr.totalEndpoints} configured · use \`rpc list\` for details`)}\n`);
      return;
    }

    if (sub === 'list') {
      const eps = mgr.getEndpoints();
      const active = mgr.activeEndpoint;
      for (const ep of eps) {
        const isActive = ep.url === active.url;
        const dot = isActive ? c.long('●') : c.muted('○');
        const lat = mgr.getEndpointLatency(ep.url);
        const latStr = lat > 0 ? c.faint(` (${lat}ms)`) : '';
        const labelStr = isActive ? c.primary.bold(ep.label) : c.primary(ep.label);
        process.stdout.write(`  ${dot} ${labelStr}${latStr}\n`);
        process.stdout.write(`    ${c.faint(maskRpcUrl(ep.url))}\n`);
      }
      process.stdout.write(`\n  ${c.muted('rpc set <url>  ·  rpc add <url>  ·  rpc remove <url>  ·  rpc test')}\n`);
      return;
    }

    if (sub === 'test') {
      process.stdout.write(`  ${c.muted('measuring all endpoints…')}\n`);
      const results = await mgr.measureAll();
      for (const r of results) {
        const isActive = r.url === mgr.activeEndpoint.url;
        const dot = isActive ? c.long('●') : c.muted('○');
        const ms = r.ms < 0 ? c.short('  ✖ unreachable')
          : r.ms < 200 ? c.long(`${r.ms}ms`)
          : r.ms < 600 ? c.warn(`${r.ms}ms`)
          : c.short(`${r.ms}ms`);
        process.stdout.write(`  ${dot} ${c.primary(r.label.padEnd(28))} ${ms}\n`);
        process.stdout.write(`    ${c.faint(maskRpcUrl(r.url))}\n`);
      }
      return;
    }

    if (sub === 'set') {
      if (!arg) {
        process.stdout.write(`  ${c.muted('usage:')} ${c.cyan('rpc set <https-url>')}\n`);
        return;
      }
      try {
        const url = validateRpcUrl(arg, 'rpc set');
        mgr.addEndpoint(url);
        const switched = mgr.switchTo(url);
        // Persist as the new primary in config.json.
        saveConfigField('l1_rpc_url', url);
        // Drop this URL from the backup list if it was there before.
        const { loadBackupL1Rpcs } = await import('../config/index.js');
        const backups = loadBackupL1Rpcs().filter((u) => u !== url);
        saveConfigField('backup_l1_rpc_urls', backups);
        // Also sync ~/.magic/.env in case the user has an active (uncommented)
        // MAGIC_L1_RPC_URL line — env takes precedence over config.json on
        // boot, so without this the next `magic` invocation would silently
        // revert to the .env value. syncEnvLine only edits an UNCOMMENTED
        // line; if the user has it commented, config.json wins on its own.
        const envSynced = syncEnvLine('MAGIC_L1_RPC_URL', url);
        // Force every cached client to be rebuilt against the new connection.
        shutdownMagicClients();
        this.config.l1RpcUrl = url;
        process.stdout.write(`  ${c.long('✔')} ${c.primary('Primary RPC')}  ${c.muted(maskRpcUrl(url))}\n`);
        if (envSynced) {
          process.stdout.write(`  ${c.muted('also updated MAGIC_L1_RPC_URL in ~/.magic/.env (was overriding config.json)')}\n`);
        }
        if (!switched) process.stdout.write(`  ${c.muted('(was already active)')}\n`);
      } catch (err) {
        process.stdout.write(`  ${c.short('✖')} ${c.muted(getErrorMessage(err))}\n`);
      }
      return;
    }

    if (sub === 'add') {
      if (!arg) {
        process.stdout.write(`  ${c.muted('usage:')} ${c.cyan('rpc add <https-url>')}\n`);
        return;
      }
      try {
        const url = validateRpcUrl(arg, 'rpc add');
        const added = mgr.addEndpoint(url);
        if (!added) {
          process.stdout.write(`  ${c.warn('⚠')} ${c.muted('already configured.')}\n`);
          return;
        }
        const { loadBackupL1Rpcs } = await import('../config/index.js');
        const backups = loadBackupL1Rpcs();
        if (!backups.includes(url) && url !== this.config.l1RpcUrl) {
          backups.push(url);
          saveConfigField('backup_l1_rpc_urls', backups);
        }
        process.stdout.write(`  ${c.long('✔')} ${c.primary('Added')}  ${c.muted(maskRpcUrl(url))}\n`);
        process.stdout.write(`  ${c.muted(`${mgr.totalEndpoints} endpoints configured`)}\n`);
      } catch (err) {
        process.stdout.write(`  ${c.short('✖')} ${c.muted(getErrorMessage(err))}\n`);
      }
      return;
    }

    if (sub === 'remove' || sub === 'rm') {
      if (!arg) {
        process.stdout.write(`  ${c.muted('usage:')} ${c.cyan('rpc remove <url>')}\n`);
        return;
      }
      const active = mgr.activeEndpoint;
      if (active.url === arg) {
        process.stdout.write(`  ${c.short('✖')} ${c.muted('cannot remove the active endpoint. switch first with `rpc set <url>`.')}\n`);
        return;
      }
      const removed = mgr.removeEndpoint(arg);
      if (!removed) {
        process.stdout.write(`  ${c.warn('⚠')} ${c.muted('endpoint not found.')}\n`);
        return;
      }
      const { loadBackupL1Rpcs } = await import('../config/index.js');
      const backups = loadBackupL1Rpcs().filter((u) => u !== arg);
      saveConfigField('backup_l1_rpc_urls', backups);
      process.stdout.write(`  ${c.long('✔')} ${c.primary('Removed')}  ${c.muted(maskRpcUrl(arg))}\n`);
      process.stdout.write(`  ${c.muted(`${mgr.totalEndpoints} endpoints remaining`)}\n`);
      return;
    }

    process.stdout.write(`  ${c.muted('unknown:')} ${c.cyan(`rpc ${sub}`)}. ${c.muted('try')} ${c.cyan('rpc status | list | test | set <url> | add <url> | remove <url>')}\n`);
  }

  /**
   * Non-interactive entry — execute one command line and return an exit
   * code (0 success, 1 failure). Used by the one-shot CLI mode in
   * `src/index.ts` and by external automation that imports this class
   * directly. Skips banner / readline / prompt entirely.
   *
   * Honors NO_DNA: in agent mode the dispatch's success/error output is
   * already JSON, so this method's return value is the only side channel
   * the caller needs.
   */
  async runOnce(line: string): Promise<number> {
    initLogger({
      logFile: join(homedir(), '.magic', 'magic.log'),
      level: process.env.NO_DNA ? LogLevel.Debug : LogLevel.Info,
    });
    initSigningGuard({
      maxCollateralPerTrade: this.config.maxCollateralPerTrade,
      maxPositionSize: this.config.maxPositionSize,
      maxLeverage: this.config.maxLeverage,
      maxTradesPerMinute: this.config.maxTradesPerMinute,
      minDelayBetweenTradesMs: this.config.minDelayBetweenTradesMs,
    });
    // Pre-warm the SDK client so the first dispatch doesn't pay cold-start
    // cost. Keypair must be loaded first — the runOneShot caller does that.
    if (this.walletManager.isConnected) {
      const kp = this.walletManager.getKeypair();
      if (kp) {
        try {
          prewarmMagicClient({
            walletKeypair: kp,
            network: this.config.network,
            poolName: this.config.poolName,
            erEndpoint: this.config.erRpcUrl,
            l1Url: this.config.l1RpcUrl,
            programIdOverride: this.config.programIdOverride,
            prioritizationFee: this.config.computeUnitPrice,
            fastConfirm: this.config.fastConfirm,
          });
        } catch { /* best-effort */ }
      }
    }
    // Resolve the symbol set so the interpreter's fuzzy match works.
    try {
      const { symbols, aliases } = getMagicSymbolSet(this.config.network, this.config.poolName);
      configureSymbols(symbols, aliases.entries());
    } catch { /* fall through */ }
    try {
      await this.handle(line);
      // handle() catches dispatch errors internally and surfaces them via
      // stderr/stdout. Use the lastFailed flag (set by every error path in
      // handle) to propagate the right exit code to the shell.
      return this.lastFailed ? 1 : 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (process.env.NO_DNA) {
        process.stderr.write(JSON.stringify({
          ts: new Date().toISOString(),
          kind: 'error',
          message: msg,
        }) + '\n');
      } else {
        process.stderr.write(`${chalk.red('error: ')}${msg}\n`);
      }
      return 1;
    }
  }

  /**
   * `magic init` — bootstrap the user-global config so an npm-installed
   * user has an obvious place to put their RPC URL / wallet path / caps
   * without having to grep the README for `~/.magic/.env`.
   *
   * Idempotent — never overwrites an existing .env. Always shows the path
   * after running so the user can `cat ~/.magic/.env` or open the editor.
   */
  private async handleInit(tokens: string[] = []): Promise<void> {
    const { userEnvFilePath, userConfigPath, envExampleContent } = await import('../config/index.js');
    const envPath = userEnvFilePath();
    const cfgPath = userConfigPath();
    const dir = dirname(envPath);
    const { existsSync, mkdirSync, writeFileSync } = await import('fs');

    // Agent mode: no prompts ever — write the canonical template + return
    // a single JSON line. This is the only path that NO_DNA agents will
    // ever take, so it has to stay deterministic and non-interactive.
    if (process.env.NO_DNA) {
      let action: 'created' | 'exists';
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (existsSync(envPath)) {
        action = 'exists';
      } else {
        writeFileSync(envPath, envExampleContent(), { mode: 0o600 });
        action = 'created';
      }
      this.lastFailed = false;
      process.stdout.write(JSON.stringify({
        ts: new Date().toISOString(),
        kind: 'result',
        alias: 'init',
        success: true,
        envPath,
        configPath: cfgPath,
        envFileAction: action,
        message: action === 'created'
          ? `Created ${envPath}. Edit it to set your RPC + wallet, then run \`magic\`.`
          : `Env file already exists at ${envPath}.`,
      }) + '\n');
      return;
    }

    // Human mode: run the interactive wizard. Auto-detects the Solana
    // CLI wallet, asks ONE question (RPC URL), validates, writes a
    // ready-to-use .env. End state = user can type `magic` and trade.
    //
    // `--quick` skips the one prompt and uses the public RPC; intended
    // for scripted onboarding (see scripts/smoke-local.sh) and any
    // power-user who wants the file written without ceremony. `--devnet`
    // selects the devnet pool. Both can be passed in either context —
    // inside the REPL via `init --quick` or one-shot via `magic init -q`.
    const argv = [...tokens, ...process.argv.slice(2)];
    const quick = argv.includes('--quick') || argv.includes('-q');
    const networkFlag = argv.includes('--devnet') ? 'devnet' as const : 'mainnet-beta' as const;

    const { runInitWizard } = await import('./init-wizard.js');
    // Reuse THIS terminal's readline. Opening a second interface on stdin
    // (the wizard's old behaviour) makes both echo every keystroke, so the
    // user sees `hhttttppss::…`. Masking hides the API key in the pasted URL.
    const result = await runInitWizard({
      quick,
      network: networkFlag,
      rl: this.rl,
      maskRpc: !quick,
    });
    if (result.cancelled) {
      this.lastFailed = false;
      process.stdout.write(c.muted('  init cancelled — no changes written\n'));
      return;
    }

    // Guided continuation: only in the live REPL. A one-shot `magic init`
    // writes the file and exits; agents (NO_DNA) returned above. `--quick`
    // opted out of prompts entirely, so we honour that and stop here too.
    if (!this.inRepl || quick) {
      void cfgPath;
      return;
    }

    await this.runGuidedOnboarding(result.l1RpcUrl);
    void cfgPath; // referenced only by NO_DNA branch; kept for future re-use.
  }

  /**
   * The "people do it like this" tail of `init`: now that the .env is written,
   * walk the user straight into a tradable state without a restart —
   *
   *   1. Hot-swap the freshly-chosen RPC into the running session (reuses the
   *      tested `rpc set` path: switchTo + persist + rebuild cached clients).
   *   2. Offer on-chain `setup` (UDL + basket + delegate; idempotent).
   *   3. Offer a first `deposit` to fund the basket.
   *
   * Steps 2 & 3 route through the normal `handle()` pipeline, so the standard
   * confirm gate + spinner + journaling all still apply — nothing signs
   * silently just because it was reached via onboarding.
   */
  private async runGuidedOnboarding(l1RpcUrl: string): Promise<void> {
    // 1 ─ Live RPC swap so setup/deposit below hit the paid endpoint.
    process.stdout.write('\n');
    try {
      await this.handleRpcSubcommand(`rpc set ${l1RpcUrl}`);
    } catch (err) {
      process.stdout.write(
        `  ${c.warn('⚠')} ${c.muted('could not hot-swap RPC — restart magic to pick it up')} ${c.faint(`(${getErrorMessage(err)})`)}\n`,
      );
    }

    // 2 ─ On-chain setup.
    process.stdout.write('\n');
    const doSetup = await this.promptYesNo(
      `  ${c.teal.bold('Run on-chain setup now?')} ${c.muted('— UDL + basket + delegate')}`,
      true,
    );
    if (doSetup) {
      await this.handle('setup');
    } else {
      process.stdout.write(`  ${c.muted('skipped — run')} ${c.teal.bold('setup')} ${c.muted('when ready.')}\n`);
    }

    // 3 ─ Fund the basket.
    process.stdout.write('\n');
    const amt = await this.promptAmount(
      `  ${c.teal.bold('Deposit USDC now?')} ${c.muted('— enter an amount, or')} ${c.cyan('[enter]')} ${c.muted('to skip')}`,
    );
    if (amt !== null) {
      await this.handle(`deposit USDC ${amt}`);
    } else {
      process.stdout.write(`  ${c.muted('skipped — run')} ${c.teal.bold('deposit USDC <amount>')} ${c.muted('when ready.')}\n`);
    }

    process.stdout.write(
      `\n  ${c.teal.bold('You’re set.')} ${c.muted('Type')} ${c.teal.bold('help')} ${c.muted('or jump in:')} ${c.teal.bold('long SOL 5 2x')}\n`,
    );
  }

  /**
   * `ai` / `ai stats` / `ai on` / `ai off` — the intent layer's observability +
   * session toggle. Makes credit spend, cache hit-rate, and fallbacks visible
   * rather than a black box. Never signs, never trades.
   */
  private handleAiCommand(lower: string): void {
    if (lower === 'ai on' || lower === 'ai off') {
      const off = lower === 'ai off';
      this.aiResolver.setSessionDisabled(off);
      const m = this.aiResolver.mode();
      process.stdout.write(
        off
          ? `  ${c.warn('●')} ${c.muted('AI intent layer disabled this session — regex-only. Type')} ${c.teal.bold('ai on')} ${c.muted('to re-enable.')}\n`
          : m.active
            ? `  ${c.long('●')} ${c.muted('AI intent layer enabled.')}\n`
            : `  ${c.warn('●')} ${c.muted(`AI still inactive: ${m.reason ?? 'unavailable'}.`)}\n`,
      );
      return;
    }

    const s = this.aiResolver.stats();
    const money = (v: number): string => `$${v.toFixed(4)}`;
    const tok = (v: number): string => (v === Infinity ? '∞' : v.toLocaleString('en-US'));
    const dot = s.mode.active ? c.long('●') : c.warn('●');
    process.stdout.write('\n');
    process.stdout.write(`  ${dot} ${c.teal.bold('AI intent layer')}  ${s.mode.active ? c.long('active') : c.short('regex-only')}${s.mode.reason ? ` ${c.faint(`(${s.mode.reason})`)}` : ''}\n`);
    process.stdout.write(`  ${c.muted('model')}        ${c.cyan(s.model)}  ${c.faint(`· threshold ${s.confidenceThreshold}`)}\n`);
    process.stdout.write(`  ${c.muted('session')}      ${c.primary(`${s.budget.session.calls} calls`)}  ${c.faint(`${tok(s.budget.session.tokens)} tok · ${money(s.budget.session.costUsd)} · ${tok(s.budget.session.remainingTokens)} left`)}\n`);
    process.stdout.write(`  ${c.muted('today')}        ${c.primary(`${s.budget.day.calls} calls`)}  ${c.faint(`${tok(s.budget.day.tokens)} tok · ${money(s.budget.day.costUsd)} · ${tok(s.budget.day.remainingTokens)} left`)}\n`);
    process.stdout.write(`  ${c.muted('cache')}        ${c.primary(`${(s.cache.hitRate * 100).toFixed(0)}% hit`)}  ${c.faint(`${s.cache.hits}/${s.cache.hits + s.cache.misses} · ${s.cache.size} entries`)}\n`);
    process.stdout.write(`  ${c.muted('fallbacks')}    ${c.primary(String(s.fallbacks))}  ${c.faint('(deterministic-only resolutions after a miss)')}\n`);
    process.stdout.write(`  ${c.faint('toggle with')} ${c.teal.bold('ai off')} ${c.faint('/')} ${c.teal.bold('ai on')}\n`);
    process.stdout.write('\n');
  }

  /** Y/N confirm on the REPL's own readline. Empty input takes `defaultYes`. */
  private promptYesNo(query: string, defaultYes: boolean): Promise<boolean> {
    const suffix = defaultYes ? c.muted(' [Y/n] ') : c.muted(' [y/N] ');
    return new Promise((resolve) => {
      this.rl.question(`${query}${suffix}`, (a) => {
        const t = (a ?? '').trim().toLowerCase();
        if (t === '') return resolve(defaultYes);
        resolve(/^y(es)?$/.test(t));
      });
    });
  }

  /**
   * Prompt for a positive USDC amount on the REPL's readline. Returns the
   * parsed number, or `null` for empty / non-positive / unparseable input
   * (all of which mean "skip the deposit").
   */
  private promptAmount(query: string): Promise<number | null> {
    return new Promise((resolve) => {
      this.rl.question(`${query} `, (a) => {
        const t = (a ?? '').trim().replace(/^\$/, '').replace(/[,_\s]/g, '');
        if (t === '') return resolve(null);
        const n = Number(t);
        resolve(Number.isFinite(n) && n > 0 ? n : null);
      });
    });
  }

  /**
   * `feedback "msg"` / `feedback list` — local journal of user notes,
   * captured with a sanitised env fingerprint. Lives at
   * `~/.magic/feedback.jsonl` (mode 0600, no key material). The user
   * attaches it when filing a bug; we never auto-upload.
   */
  private async handleFeedback(line: string): Promise<void> {
    const { recordFeedback, readFeedback, buildEnvFingerprint } =
      await import('../security/feedback-journal.js');
    const rest = line.replace(/^feedback\s*/i, '').trim();

    if (rest === 'list' || rest === '') {
      // Default no-arg behaviour shows recent entries — short rather than
      // making the user remember a separate `list` subcommand. They get
      // the typical "where's my feedback go" answer in one shot.
      if (rest === '') {
        process.stdout.write([
          '',
          `  ${c.cyan.bold('Feedback')}`,
          c.faint('  ' + '─'.repeat(60)),
          `  ${c.muted('Capture a quick note (saved to ~/.magic/feedback.jsonl):')}`,
          `    ${c.teal.bold('feedback "the close button shows wrong PnL"')}`,
          `    ${c.teal.bold('feedback list')}                      ${c.muted('show recent entries')}`,
          '',
          `  ${c.muted('Categorise:')}  ${c.teal('feedback bug "..."')} ${c.muted('|')} ${c.teal('feature')} ${c.muted('|')} ${c.teal('praise')} ${c.muted('|')} ${c.teal('confusion')}`,
          '',
        ].join('\n'));
      }
      const entries = readFeedback(10);
      if (entries.length === 0) {
        process.stdout.write(`  ${c.muted('no feedback recorded yet')}\n\n`);
        return;
      }
      process.stdout.write(`  ${c.cyan.bold('Recent feedback')}\n`);
      process.stdout.write(c.faint('  ' + '─'.repeat(60)) + '\n');
      for (const e of entries) {
        const t = new Date(e.ts).toLocaleString();
        const kindLabel = e.kind ? c.teal(e.kind.padEnd(9)) : c.muted('(other)  ');
        process.stdout.write(`  ${c.muted(t.padEnd(22))}${kindLabel} ${e.message}\n`);
      }
      process.stdout.write('\n');
      return;
    }

    // Parse optional kind prefix: `feedback bug "msg"` etc.
    const kinds = ['bug', 'feature', 'praise', 'confusion', 'other'] as const;
    let kind: typeof kinds[number] | undefined;
    let message = rest;
    const firstWord = rest.split(/\s+/, 1)[0]?.toLowerCase();
    if (firstWord && (kinds as readonly string[]).includes(firstWord)) {
      kind = firstWord as typeof kinds[number];
      message = rest.slice(firstWord.length).trim();
    }
    // Strip surrounding quotes if the user wrapped the message.
    message = message.replace(/^["']|["']$/g, '');

    if (!message) {
      process.stdout.write(c.short('  feedback message is empty\n'));
      this.lastFailed = true;
      return;
    }

    const env = buildEnvFingerprint({
      version: VERSION,
      network: this.config.network,
      pool: this.config.poolName,
      l1RpcUrl: this.config.l1RpcUrl,
      walletConnected: this.walletManager.isConnected,
    });

    const path = recordFeedback({
      ts: new Date().toISOString(),
      message,
      kind,
      env,
    });

    if (process.env.NO_DNA) {
      process.stdout.write(JSON.stringify({
        ts: new Date().toISOString(),
        kind: 'result',
        alias: 'feedback',
        success: !!path,
        recorded: !!path,
        path,
      }) + '\n');
      return;
    }

    if (!path) {
      process.stdout.write(c.short('  could not write to ~/.magic/feedback.jsonl\n'));
      this.lastFailed = true;
      return;
    }
    process.stdout.write(`  ${c.long('✔')}  ${c.muted('Recorded.')} ${c.faint(path)}\n`);
    process.stdout.write(`  ${c.muted('Attach this file when reporting bugs at:')} ${c.cyan('https://github.com/Abdr007/flash-builder-terminal/issues')}\n\n`);
  }

  /**
   * `magic env` — print the env file path, what's set (masked), and where
   * config.json lives. Useful when the user can't remember where their
   * settings are or wants to verify a change took effect.
   */
  private async handleEnvShow(): Promise<void> {
    const { userEnvFilePath, userConfigPath, loadBackupL1Rpcs } = await import('../config/index.js');
    const envPath = userEnvFilePath();
    const cfgPath = userConfigPath();
    const { existsSync } = await import('fs');

    // Reuse the rpc-manager's URL masker (it's the project's authoritative
    // path-token scrubber — handles QuickNode `/<token>/` paths, Triton
    // `<token>.solana-mainnet.rpcpool.com` subdomains, and `?api-key=`
    // query params). Without this, the env view leaks api keys to stdout
    // / NO_DNA agent transcripts.
    const { maskRpcUrl } = await import('../network/rpc-manager.js');
    const mask = (v: string | undefined): string => {
      if (!v) return c.faint('— unset —');
      // URL-shaped values get path+query-aware masking.
      if (/^https?:\/\//i.test(v)) return maskRpcUrl(v);
      // Long opaque strings — likely keys / tokens / sigs. Truncate aggressively.
      if (v.length > 32) return v.slice(0, 4) + '…' + v.slice(-4);
      return v;
    };
    const tracked = [
      'MAGIC_NETWORK', 'MAGIC_POOL_NAME', 'MAGIC_RPC_URL', 'MAGIC_L1_RPC_URL',
      'MAGIC_WALLET_PATH', 'MAGIC_AUTO_CONFIRM', 'MAGIC_FAST_CONFIRM',
      'MAX_COLLATERAL_PER_TRADE', 'MAX_POSITION_SIZE', 'MAX_LEVERAGE',
      'MAX_TRADES_PER_MINUTE', 'MIN_DELAY_BETWEEN_TRADES_MS',
      'MAGIC_LOG_LEVEL', 'MAGIC_LOG_FORMAT', 'NO_DNA',
    ];
    const values: Record<string, string | undefined> = {};
    for (const k of tracked) values[k] = process.env[k];
    const backups = loadBackupL1Rpcs();

    if (process.env.NO_DNA) {
      // CRITICAL: agents may pipe this to LLM transcripts / CI logs / shell
      // scrollback. Mask EVERY value — never emit raw URLs/tokens.
      const maskedEnv: Record<string, string> = {};
      for (const k of tracked) {
        const v = values[k];
        maskedEnv[k] = v == null ? '' : (
          /^https?:\/\//i.test(v) ? maskRpcUrl(v) :
          (v.length > 32 ? v.slice(0, 4) + '…' + v.slice(-4) : v)
        );
      }
      const maskedBackups = backups.map((b) => maskRpcUrl(b));
      process.stdout.write(JSON.stringify({
        ts: new Date().toISOString(),
        kind: 'result',
        alias: 'env',
        success: true,
        envPath,
        envExists: existsSync(envPath),
        configPath: cfgPath,
        configExists: existsSync(cfgPath),
        env: maskedEnv,
        backupRpcs: maskedBackups,
      }) + '\n');
      return;
    }

    const lines: string[] = [];
    lines.push('');
    lines.push(`  ${c.teal.bold('Environment')}  ${c.muted('— current settings')}`);
    lines.push(c.faint('  ' + '─'.repeat(60)));
    lines.push(`  ${c.muted('env file  ')} ${envPath}  ${existsSync(envPath) ? c.long('✓') : c.warn('(missing — run `magic init`)')}`);
    lines.push(`  ${c.muted('config    ')} ${cfgPath}  ${existsSync(cfgPath) ? c.long('✓') : c.muted('(empty)')}`);
    lines.push('');
    for (const k of tracked) {
      const v = values[k];
      lines.push(`  ${c.muted(k.padEnd(28))} ${v ? c.primary(mask(v)) : c.faint('— unset —')}`);
    }
    if (backups.length > 0) {
      lines.push('');
      lines.push(`  ${c.muted('backup RPCs:')}`);
      for (const b of backups) lines.push(`    ${c.primary(mask(b))}`);
    }
    lines.push('');
    lines.push(`  ${c.muted('Edit:')} ${c.cyan(`$EDITOR ${envPath}`)}  ${c.muted('· `rpc set <url>` updates ' + cfgPath)}`);
    lines.push('');
    process.stdout.write(lines.join('\n'));
  }

  /**
   * Idempotency flag — `shutdown()` is called from BOTH the graceful exit
   * path in `index.ts` (after `terminal.start()` returns) AND from any
   * signal handlers. Without this, double-fires double-close readline,
   * double-stop alerts/reconciler/timers, double-zero the keypair (the
   * try/catch ladder absorbs the errors but it's wasteful and racy).
   */
  private _shuttingDown = false;

  /** Tear down all background timers + cached clients. Idempotent. */
  async shutdown(): Promise<void> {
    if (this._shuttingDown) return;
    this._shuttingDown = true;
    try { unbindReadline(); } catch { /* ignore */ }
    try { this.rl.close(); } catch { /* ignore */ }
    try { stopMagicAlerts(); } catch { /* ignore */ }
    try { (await import('../network/rpc-manager.js')).getRpcManager()?.stopHealthMonitor(); } catch { /* ignore */ }
    try { (await import('../core/state-reconciliation.js')).getReconciler()?.stop(); } catch { /* ignore */ }
    try { await (await import('../data/volume-indexer.js')).getVolumeIndexer()?.stop(); } catch { /* ignore */ }
    // ER health monitor was registered as a global singleton; explicitly
    // tear it down so its 30s probe doesn't keep firing post-shutdown and
    // try to write to a closed stdout.
    try { (await import('../monitor/magic-er-health.js')).stopErHealthMonitor(); } catch { /* ignore */ }
    shutdownMagicClients();
    // Best-effort: zero the secret-key buffer on graceful shutdown so a
    // process snapshot taken right after exit doesn't capture key material.
    try { this.walletManager.disconnect(); } catch { /* ignore */ }
  }
}

// (Removed: a `void Connection;` line that claimed to defeat tree-shaking.
// This is a Node CLI binary, no bundler is involved, so the line was dead
// code with a misleading comment.)
