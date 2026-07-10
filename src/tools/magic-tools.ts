/**
 * Magic-mode CLI tools — bound to the new SDK-backed MagicTradeClient.
 *
 * Network-aware: defaults follow `config.magicNetwork` (mainnet-beta or devnet).
 * Mainnet uses Pool.0 on Flash's L1 program (FTv2…hrzV) delegated to the ER;
 * devnet uses Pool.1 on FMT (FMTgs…txvj).
 *
 * Categories:
 *   - inspection: `magic markets`, `magic portfolio`, `magic delegation`, `magic doctor`
 *   - lifecycle:  `magic status`, `setup`, `magic deposit`, `faucet`
 *   - trading:    `magic open`, `magic close`, `magic add-collateral`, `magic remove-collateral`
 *   - sessions:   `magic session start|stop|status` (P3 — wired in next pass)
 */

import { z } from 'zod';
import chalk from 'chalk';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { readFileSync, statSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { ToolDefinition, ToolContext, ToolResult } from '../types/index.js';
import { MagicTradeClient } from '../client/magic-client.js';
import {
  FlashV2BuilderClient,
  FLASH_V2_BUILDERS,
  FLASH_V2_PREVIEWS,
  type FlashV2BuilderName,
  type FlashV2BuilderResult,
  type JsonObject,
  uiAmount,
} from '../client/flash-v2-builder.js';
import { formatPrice, formatUsd, formatUsdExact } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import { readMagicHistory, recordMagicTrade } from '../security/magic-history.js';
import { startErHealthMonitor, getErHealthMonitor } from '../monitor/magic-er-health.js';
import { startMagicAlerts, stopMagicAlerts, getMagicAlerts } from '../monitor/magic-alerts.js';
import { renderCard, marketHeader, c, DIAMOND, DOT, pad, divider, vlen } from '../cli/magic-theme.js';
// Single source of truth for the oracle-price decoder. Property-tested.

/** USDC mints — mainnet vs devnet test stable. */
const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_MINT_DEVNET = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';

/**
 * Pick the explorer base host. Default: Solana Explorer.
 * Override via FLASH_EXPLORER=solscan (or =explorer to be explicit).
 *
 * For magic-mode mainnet trades, all writes hit the ER, so the tx is only
 * visible to clients pointed at the ER's RPC. Both Solscan and Solana Explorer
 * accept `?cluster=custom&customUrl=<er>`. URL-encoded so the link copies
 * cleanly into a browser bar without breaking on `://`.
 */
function explorerBase(): { tx: string; acct: string } {
  const which = (process.env.FLASH_EXPLORER ?? 'explorer').toLowerCase();
  if (which === 'solscan') return { tx: 'https://solscan.io/tx', acct: 'https://solscan.io/account' };
  return { tx: 'https://explorer.solana.com/tx', acct: 'https://explorer.solana.com/address' };
}

/** ER router URL — magic-mode trades land here on mainnet. */
const MAGIC_ER_URL = 'https://flashtrade.magicblock.app/';

/** Build a tx explorer URL. For magic mainnet, includes the ER customUrl. */
/**
 * Sentinels the recovery paths return when an on-chain tx landed but the
 * SDK's polling didn't observe confirmation. They're NOT real signatures —
 * shape-checked here so a stray downstream consumer (history, dashboard,
 * card) can't accidentally render them as `/tx/expired-but-landed` 404s.
 */
const SIG_SENTINELS = new Set(['already-landed', 'expired-but-landed']);

/** True iff `sig` looks like a real ed25519 signature (43-88 base58 chars). */
function isRealSignature(sig: string | undefined | null): sig is string {
  if (!sig) return false;
  if (SIG_SENTINELS.has(sig)) return false;
  return /^[1-9A-HJ-NP-Za-km-z]{43,88}$/.test(sig);
}

function solscanTx(sig: string, network: 'mainnet-beta' | 'devnet'): string {
  // Defensive: never produce a URL for a sentinel or malformed signature.
  // The caller is responsible for rendering an alternate string in that
  // case; we return a stable "(no link)" placeholder so an accidental
  // print doesn't ship a broken hyperlink.
  if (!isRealSignature(sig)) return '(no link — recovered via chain-truth check)';
  const { tx } = explorerBase();
  if (network === 'devnet') return `${tx}/${sig}?cluster=devnet`;
  // Magic mainnet — point at the ER router so the tx resolves.
  return `${tx}/${sig}?cluster=custom&customUrl=${encodeURIComponent(MAGIC_ER_URL)}`;
}

/** Build an account explorer URL. */
function solscanAcct(addr: string, network: 'mainnet-beta' | 'devnet'): string {
  const { acct } = explorerBase();
  if (network === 'devnet') return `${acct}/${addr}?cluster=devnet`;
  // For accounts on magic-mode mainnet, the on-chain account is also on L1
  // (UDL is L1-only, basket is delegated). Keep the link to L1 mainnet so
  // the user always sees the canonical state.
  return `${acct}/${addr}`;
}

/** Flash UI URL — opens in the user's connected-wallet view. */
function flashUiUrl(): string {
  return 'https://beta.flash.trade/';
}

/** Resolve the stable mint for the active network. */
function stableMintFor(network: 'mainnet-beta' | 'devnet'): string {
  return network === 'mainnet-beta' ? USDC_MINT_MAINNET : USDC_MINT_DEVNET;
}

/**
 * Cached MagicTradeClient per (network, pool, wallet, erEndpoint) tuple.
 *
 * Why cache: every magic command was rebuilding the client from scratch,
 * losing the warmed blockhash, oracle cache, quote cache, and validated
 * program-set hash. Caching keeps these warm across commands → second
 * trade in same session is significantly faster.
 *
 * When wallet/network/pool/endpoint changes, the old client is shut down
 * (timers cleared) and replaced — no leaks.
 */
const _magicClientCache = new Map<string, MagicTradeClient>();

export function buildMagicClient(context: ToolContext): MagicTradeClient {
  const kp = context.walletManager.getKeypair();
  if (!kp) {
    throw new Error(
      'No wallet loaded. Run `wallet list` to see saved wallets, then `wallet use <name>` ' +
        'to reconnect (or `wallet connect <path>` for a one-shot keypair file).',
    );
  }
  const network = context.config.network ?? 'mainnet-beta';
  const poolName = context.config.poolName ?? (network === 'mainnet-beta' ? 'Pool.0' : 'Pool.1');
  const erEndpoint = context.config.erRpcUrl ?? 'https://flashtrade.magicblock.app/';
  const cacheKey = `${network}:${poolName}:${kp.publicKey.toBase58()}:${erEndpoint}`;

  const cached = _magicClientCache.get(cacheKey);
  if (cached) return cached;

  // Tear down stale clients (different wallet/network/pool/endpoint) so their
  // background timers don't leak.
  for (const [k, c] of _magicClientCache) {
    if (k === cacheKey) continue;
    try {
      c.shutdown();
    } catch {
      /* best-effort */
    }
    _magicClientCache.delete(k);
  }

  const l1Url =
    context.config.l1RpcUrl ??
    (network === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
  const l1Connection = new Connection(l1Url, 'confirmed');
  const client = new MagicTradeClient({
    wallet: kp,
    l1Connection,
    network,
    poolName,
    erEndpoint,
    programIdOverride: context.config.programIdOverride,
    prioritizationFee: context.config.computeUnitPrice,
    fastConfirm: context.config.fastConfirm,
  });
  _magicClientCache.set(cacheKey, client);
  // Re-attach the reconciler whenever a fresh client is built. setClient is
  // idempotent for the same instance, so this is safe to call on every
  // dispatch — but it covers the wallet-switch path (where the prior client
  // was torn down and the reconciler reference nulled out) without needing
  // a separate hook.
  void import('../core/state-reconciliation.js')
    .then((m) => m.getReconciler().setClient(client))
    .catch(async (err) => {
      // A silent reconciler failure means the periodic chain-truth
      // sync isn't running and the user has no idea — they'd see
      // staleness only when a position diverged from chain. Log
      // it so the failure is observable in `~/.magic/logs/*.log`
      // and any debug session can spot it immediately.
      try {
        const { getLogger } = await import('../utils/logger.js');
        getLogger().warn('magic-tools', `reconciler.setClient failed: ${err instanceof Error ? err.message : String(err)}`);
      } catch { /* logger unavailable */ }
    });
  return client;
}

/**
 * Pre-build and cache a MagicTradeClient at terminal startup so the first
 * trade doesn't pay the cold-start cost (TLS handshakes, Anchor init, oracle
 * fetch). Idempotent — safe to call multiple times. Returns the cached client.
 */
export function prewarmMagicClient(opts: {
  walletKeypair: import('@solana/web3.js').Keypair;
  network: 'mainnet-beta' | 'devnet';
  poolName: string;
  erEndpoint: string;
  l1Url: string;
  programIdOverride?: string;
  prioritizationFee?: number;
  fastConfirm?: boolean;
}): MagicTradeClient {
  const cacheKey = `${opts.network}:${opts.poolName}:${opts.walletKeypair.publicKey.toBase58()}:${opts.erEndpoint}`;
  const existing = _magicClientCache.get(cacheKey);
  if (existing) return existing;
  const client = new MagicTradeClient({
    wallet: opts.walletKeypair,
    l1Connection: new Connection(opts.l1Url, 'confirmed'),
    network: opts.network,
    poolName: opts.poolName,
    erEndpoint: opts.erEndpoint,
    programIdOverride: opts.programIdOverride,
    prioritizationFee: opts.prioritizationFee,
    fastConfirm: opts.fastConfirm ?? true,
  });
  _magicClientCache.set(cacheKey, client);
  // Pre-warm the most-traded symbols (SOL + BTC) and start the background
  // refresher so subsequent opens skip the ~300-500ms quote simulate.
  // fetchOraclePrice now populates oracleCache directly, so the very first
  // trade after launch can synthesize size locally.
  for (const sym of ['SOL', 'BTC', 'ETH']) {
    client.watchOraclePrice(sym);
    client.fetchOraclePrice(sym).catch(() => undefined);
  }
  // Also pre-warm oracles for any market the user has an OPEN position
  // on. This means the very first close / reverse / increase on an
  // existing position pays no oracle round-trip — the synth-quote path
  // hits the cache immediately. Fully async; doesn't delay startup.
  void (async () => {
    try {
      const positions = await client.getPositions();
      const symbols = new Set(positions.map((p) => p.market.toUpperCase()));
      for (const sym of symbols) {
        client.watchOraclePrice(sym);
        client.fetchOraclePrice(sym).catch(() => undefined);
      }
    } catch { /* best-effort — startup must not block on this */ }
  })();
  return client;
}

/** Tear down all cached clients — used by tests + shutdown path. */
export function shutdownMagicClients(): void {
  for (const c of _magicClientCache.values()) {
    try {
      c.shutdown();
    } catch {
      /* best-effort */
    }
  }
  _magicClientCache.clear();
}

const _flashV2ClientCache = new Map<string, FlashV2BuilderClient>();

export function buildFlashV2Client(context: ToolContext): FlashV2BuilderClient {
  const l1Url =
    context.config.l1RpcUrl ??
    (context.config.network === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
  const apiUrl = context.config.flashApiUrl ?? 'https://flashapi.trade';
  const cacheKey = `${apiUrl}:${l1Url}`;
  const cached = _flashV2ClientCache.get(cacheKey);
  if (cached) return cached;
  const client = new FlashV2BuilderClient({
    baseUrl: apiUrl,
    l1Connection: new Connection(l1Url, 'confirmed'),
  });
  _flashV2ClientCache.set(cacheKey, client);
  return client;
}

function ownerKeypair(context: ToolContext): Keypair {
  const kp = context.walletManager.getKeypair();
  if (!kp) {
    throw new Error(
      'No wallet loaded. Run `wallet list` to see saved wallets, then `wallet use <name>` ' +
        'to reconnect (or `wallet connect <path>` for a one-shot keypair file).',
    );
  }
  return kp;
}

function loadKeypairFile(path: string): Keypair {
  const resolved = resolve(path);
  const home = homedir();
  const homePrefix = home.endsWith('/') ? home : home + '/';
  const inHome = (p: string): boolean => p === home || p.startsWith(homePrefix);
  if (!inHome(resolved)) {
    throw new Error(`Keypair path must be within home directory (${home}). Got: ${resolved}`);
  }
  // Resolve symlinks and re-check — a symlink inside home could point outside.
  let real = resolved;
  try { real = realpathSync(resolved); } catch { /* may not exist yet; fall back to resolved */ }
  if (!inHome(real)) {
    throw new Error(`Keypair path escapes the home directory via symlink: ${real}`);
  }
  const st = statSync(real);
  if (!st.isFile()) throw new Error(`Keypair path is not a regular file: ${real}`);
  if (st.size > 4096) throw new Error(`Keypair file too large (${st.size} bytes) — refusing to read.`);
  // Refuse group/world-accessible key files (POSIX only), matching the primary
  // wallet loader's 0600 gate. A fee-payer key is still a key.
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new Error(`Keypair file ${real} is group/world-accessible (mode ${(st.mode & 0o777).toString(8)}). Run: chmod 600 ${real}`);
  }
  const parsed = JSON.parse(readFileSync(real, 'utf8')) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new Error(`Invalid keypair file ${resolved}: expected 64-byte JSON array.`);
  }
  const bytes = Uint8Array.from(parsed.map((v) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {
      throw new Error(`Invalid keypair file ${resolved}: contains a non-byte value.`);
    }
    return v;
  }));
  return Keypair.fromSecretKey(bytes);
}

function withdrawFeePayer(context: ToolContext, owner: PublicKey): Keypair {
  const configured = context.config.withdrawFeePayerPath
    ? loadKeypairFile(context.config.withdrawFeePayerPath)
    : Keypair.generate();
  if (configured.publicKey.equals(owner)) {
    throw new Error('V2 withdrawals require feePayer !== owner. Set MAGIC_WITHDRAW_FEE_PAYER_PATH to a different keypair.');
  }
  return configured;
}

function v2Side(side: string): 'LONG' | 'SHORT' {
  return side.toLowerCase() === 'short' ? 'SHORT' : 'LONG';
}

function v2UiSide(side: string): 'long' | 'short' {
  return side.toLowerCase() === 'short' ? 'short' : 'long';
}

function records(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v));
  }
  if (!value || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>)
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v));
}

function isJsonRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecordBody(raw: unknown): JsonObject {
  const text = String(raw).trim();
  if (!text) throw new Error('JSON body is required.');
  let parsed = JSON.parse(text) as unknown;
  if (typeof parsed === 'string') parsed = JSON.parse(parsed) as unknown;
  if (!isJsonRecord(parsed)) throw new Error('JSON body must be an object.');
  return parsed;
}

function compactJson(value: unknown, maxChars = 2200): string {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + '…';
}

function jsonRows(value: unknown): Array<{ label: string; value: string }> {
  if (!isJsonRecord(value)) {
    return [{ label: 'Value', value: c.primary(String(value)) }];
  }
  const rows: Array<{ label: string; value: string }> = [];
  for (const [key, raw] of Object.entries(value).slice(0, 12)) {
    if (raw === null || typeof raw !== 'object') {
      rows.push({ label: key, value: c.primary(String(raw)) });
    } else if (Array.isArray(raw)) {
      rows.push({ label: key, value: c.primary(`${raw.length} items`) });
    } else {
      rows.push({ label: key, value: c.primary(`${Object.keys(raw).length} keys`) });
    }
  }
  return rows.length > 0 ? rows : [{ label: 'Result', value: c.muted('{}') }];
}

function fieldString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function fieldNumber(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[$,%x]/g, '').trim();
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function formatPendingAmount(amount: number, decimals: number): string {
  if (amount >= 0.01) return amount.toFixed(decimals === 6 ? 2 : 6);
  return amount.toFixed(Math.min(Math.max(decimals, 4), 6));
}

function positionsFromMetrics(metrics: JsonObject): PositionLike[] {
  return records(metrics).map((p) => {
    const market = fieldString(p, 'marketSymbol').toUpperCase();
    const side: 'long' | 'short' = fieldString(p, 'sideUi').toLowerCase() === 'short' ? 'short' : 'long';
    const sizeUsd = fieldNumber(p, 'sizeUsdUi');
    const collateralUsd = fieldNumber(p, 'collateralUsdUi') || fieldNumber(p, 'marginUsd');
    const leverage = fieldNumber(p, 'leverage') || fieldNumber(p, 'leverageUi') || (collateralUsd > 0 ? sizeUsd / collateralUsd : 0);
    return {
      market,
      side,
      entryPrice: fieldNumber(p, 'entryPriceUi'),
      markPrice: fieldNumber(p, 'exitPrice'),
      sizeUsd,
      sizeAmountUi: fieldNumber(p, 'sizeAmountUi'),
      collateralUsd,
      leverage,
      unrealizedPnl: fieldNumber(p, 'pnlWithFeeUsdUi'),
      unrealizedPnlPercent: fieldNumber(p, 'pnlPercentageWithFee'),
      liquidationPrice: fieldNumber(p, 'liquidationPrice') || fieldNumber(p, 'liquidationPriceUi'),
      raw: p,
    };
  }).filter((p) => p.market);
}

interface PositionLike {
  market: string;
  side: 'long' | 'short';
  entryPrice: number;
  markPrice: number;
  sizeUsd: number;
  sizeAmountUi: number;
  collateralUsd: number;
  leverage: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  liquidationPrice: number;
  raw: Record<string, unknown>;
}

interface V2BasketState {
  snapshot: JsonObject;
  basketPubkey: string;
  basketAccount: Record<string, unknown> | null;
  basketSource: string | null;
}

interface V2BasketTokenBalance {
  symbol: string;
  mint: string;
  decimals: number;
  isStable: boolean;
  debits: number;
  pendingCredits: number;
  total: number;
}

async function v2Positions(client: FlashV2BuilderClient, owner: string): Promise<PositionLike[]> {
  return positionsFromMetrics(await client.positions(owner));
}

async function v2OwnerPositions(client: FlashV2BuilderClient, owner: string): Promise<PositionLike[]> {
  const snapshot = await client.owner(owner);
  const metrics = snapshot.positionMetrics;
  return positionsFromMetrics((metrics && typeof metrics === 'object' && !Array.isArray(metrics) ? metrics : {}) as JsonObject);
}

async function sizeUsdToTokenAmount(client: FlashV2BuilderClient, market: string, sizeUsd: number): Promise<string> {
  const price = await client.prices(market);
  const px = typeof price === 'object' && price !== null && !Array.isArray(price)
    ? fieldNumber(price as Record<string, unknown>, 'priceUi')
    : 0;
  if (!Number.isFinite(px) || px <= 0) {
    throw new Error(`Cannot convert ${formatUsd(sizeUsd)} to ${market} size: V2 price unavailable.`);
  }
  return uiAmount(sizeUsd / px);
}

function builderTxRows(result: FlashV2BuilderResult, network: 'mainnet-beta' | 'devnet'): Array<{ label: string; value: string }> {
  if ('previewOnly' in result) {
    return [{ label: 'Mode', value: c.muted('preview only — no transaction returned') }];
  }
  return [
    { label: 'Tx', value: c.muted(solscanTx(result.signature, network)) },
    { label: 'State', value: c.muted('re-read basket snapshot / stream for final state') },
  ];
}

// Client-side slippage cap (a PERCENT, sent to the API as a string). Every
// market order carries this so a fill can't move arbitrarily against the
// trader — previously no order set slippagePercentage at all, leaving execution
// at the server default with no client guardrail. Override per-env or per-call.
const DEFAULT_SLIPPAGE_PCT = (() => {
  const raw = Number(process.env.MAGIC_SLIPPAGE_PERCENT);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 50) : 0.5;
})();
function slippageStr(params: Record<string, unknown>): string {
  const s = Number((params as { slippage?: unknown }).slippage);
  const pct = Number.isFinite(s) && s > 0 ? Math.min(s, 50) : DEFAULT_SLIPPAGE_PCT;
  return uiAmount(pct);
}

async function signV2(
  context: ToolContext,
  name: FlashV2BuilderName,
  body: Record<string, unknown>,
  extraSigners: Keypair[] = [],
): Promise<FlashV2BuilderResult> {
  const client = buildFlashV2Client(context);
  const owner = ownerKeypair(context);
  return client.signAndSubmit(name, body, [owner, ...extraSigners], {
    refreshOwner: owner.publicKey.toBase58(),
    retryExpiredBlockhash: true,
  });
}

async function readV2BasketState(client: FlashV2BuilderClient, owner: string): Promise<V2BasketState> {
  const snapshot = await client.owner(owner);
  const basketPubkey = typeof snapshot.basketPubkey === 'string' ? snapshot.basketPubkey : '';
  if (!basketPubkey) {
    return { snapshot, basketPubkey: '', basketAccount: null, basketSource: null };
  }
  const raw = await client.rawBasket(basketPubkey);
  const rawRecord = isJsonRecord(raw) ? raw : null;
  const basketAccount = rawRecord && isJsonRecord(rawRecord.account) ? rawRecord.account : null;
  const basketSource = rawRecord ? fieldString(rawRecord, 'source') || null : null;
  return { snapshot, basketPubkey, basketAccount, basketSource };
}

async function readV2BasketTokenBalances(client: FlashV2BuilderClient, owner: string): Promise<Map<string, V2BasketTokenBalance>> {
  const [state, tokens] = await Promise.all([
    readV2BasketState(client, owner),
    client.tokens(),
  ]);
  const tokenRows = Array.isArray(tokens) ? tokens as Record<string, unknown>[] : records(tokens);
  const tokenByMint = new Map<string, Record<string, unknown>>();
  for (const token of tokenRows) {
    const mint = fieldString(token, 'mint');
    if (mint) tokenByMint.set(mint, token);
  }
  const balances = new Map<string, V2BasketTokenBalance>();
  const upsert = (mint: string, key: 'debits' | 'pendingCredits', amountRaw: number) => {
    const token = tokenByMint.get(mint);
    const symbol = fieldString(token ?? {}, 'symbol') || mint.slice(0, 8);
    const decimals = fieldNumber(token ?? {}, 'decimals');
    const scale = decimals >= 0 ? 10 ** decimals : 1;
    const amount = scale > 0 ? amountRaw / scale : 0;
    const existing = balances.get(symbol) ?? {
      symbol,
      mint,
      decimals,
      isStable: !!(token && token.isStable === true),
      debits: 0,
      pendingCredits: 0,
      total: 0,
    };
    existing[key] += amount;
    existing.total = existing.debits + existing.pendingCredits;
    balances.set(symbol, existing);
  };
  for (const entry of records(state.basketAccount?.debits)) {
    const mint = fieldString(entry, 'mint');
    if (mint) upsert(mint, 'debits', fieldNumber(entry, 'amount'));
  }
  for (const entry of records(state.basketAccount?.pendingCredits)) {
    const mint = fieldString(entry, 'mint');
    if (mint) upsert(mint, 'pendingCredits', fieldNumber(entry, 'amount'));
  }
  return balances;
}

interface V2CustodyRef {
  symbol: string;
  pubkey: PublicKey;
}

async function readV2ActivePoolCustodies(context: ToolContext): Promise<V2CustodyRef[]> {
  const sdkClient = buildMagicClient(context);
  const pool = sdkClient.poolConfig.poolAddress.toBase58();
  const raw = await buildFlashV2Client(context).raw('custodies');
  const seen = new Set<string>();
  const refs: V2CustodyRef[] = [];
  for (const item of records(raw)) {
    const pubkey = fieldString(item, 'pubkey');
    const account = isJsonRecord(item.account) ? item.account : item;
    if (fieldString(account, 'pool') !== pool) continue;
    const symbol = fieldString(account, 'symbol').toUpperCase();
    if (!pubkey || !symbol || seen.has(symbol)) continue;
    try {
      refs.push({ symbol, pubkey: new PublicKey(pubkey) });
      seen.add(symbol);
    } catch {
      /* ignore malformed pubkeys from the API */
    }
  }
  if (refs.length > 0) return refs.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return sdkClient.poolConfig.custodies
    .map((cu) => ({ symbol: cu.symbol.toUpperCase(), pubkey: cu.custodyAccount }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}


export const magicDelegation: ToolDefinition = {
  name: 'magicDelegation',
  description: 'Show basket delegation status (whether trades route to ER or L1).',
  async execute(_params, context): Promise<ToolResult> {
    const owner = ownerKeypair(context).publicKey.toBase58();
    const state = await readV2BasketState(buildFlashV2Client(context), owner);
    const delegated = state.basketSource === 'er';
    return {
      success: true,
      message: `basket=${state.basketPubkey || 'none'} delegated=${delegated}`,
      data: { basketDelegated: delegated, basketPda: state.basketPubkey },
    };
  },
};

export const magicPortfolio: ToolDefinition = {
  name: 'magicPortfolio',
  description: 'Fetch user portfolio from the V2 basket snapshot (positions are basket source-of-truth).',
  async execute(_params, context): Promise<ToolResult> {
    const client = buildFlashV2Client(context);
    const owner = ownerKeypair(context).publicKey.toBase58();
    const snapshot = await client.owner(owner);
    const positions = positionsFromMetrics((snapshot.positionMetrics && typeof snapshot.positionMetrics === 'object' && !Array.isArray(snapshot.positionMetrics)
      ? snapshot.positionMetrics
      : {}) as JsonObject);
    const basketPubkey = typeof snapshot.basketPubkey === 'string' ? snapshot.basketPubkey : '';
    const walletShort = `${owner.slice(0, 4)}…${owner.slice(-4)}`;
    const basketShort = basketPubkey ? `${basketPubkey.slice(0, 4)}…${basketPubkey.slice(-4)}` : 'none';
    const totalCollateralUsd = positions.reduce((sum, p) => sum + p.collateralUsd, 0);
    const totalUnrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

    const summaryRows = [
      { label: 'Wallet',      value: `${c.primary(walletShort)}  ${c.muted(owner)}` },
      { label: 'Basket',      value: basketPubkey ? `${c.primary(basketShort)}  ${c.muted(solscanAcct(basketPubkey, context.config.network))}` : c.muted('not initialized') },
      // Wallet-side liquid balance — distinguish clearly from basket
      // Collateral below. Was 'Balance' which read like a basket field.
      { label: 'In wallet',  value: c.muted('run `account` for wallet balances') },
      { label: 'Collateral',  value: c.primary(formatUsd(totalCollateralUsd)) },
      { label: 'Unrealized',  value: totalUnrealizedPnl >= 0
        ? c.long(formatUsd(totalUnrealizedPnl))
        : c.short(formatUsd(totalUnrealizedPnl)) },
      { label: 'Positions',   value: c.primary(String(positions.length)) },
    ];

    const tone = totalUnrealizedPnl >= 0 ? 'info' : 'warn';
    const subtitle = positions.length === 0
      ? c.muted('no open positions')
      : `${DIAMOND}  ${c.muted(`${positions.length} open`)}`;

    let message = renderCard({
      status: 'Portfolio',
      tone,
      subtitle,
      columns: 1,
      rows: summaryRows,
    });

    if (positions.length > 0) {
      const posLines: string[] = [];
      for (const p of positions) {
        const pnlColor = p.unrealizedPnl >= 0 ? c.long : c.short;
        const sideColor = p.side === 'long' ? c.long : c.short;
        posLines.push(
          `  ${c.teal('▌')}  ${c.primary.bold(p.market.padEnd(7))} ${sideColor(p.side.toUpperCase().padEnd(5))} ${c.muted(`${p.leverage.toFixed(1)}x`)}  ` +
          `${c.muted('size')} ${c.primary(formatUsd(p.sizeUsd))}  ` +
          `${c.muted('entry')} ${c.primary(`$${p.entryPrice.toFixed(4)}`)}  ` +
          `${c.muted('mark')} ${c.primary(`$${p.markPrice.toFixed(4)}`)}  ` +
          `${c.muted('pnl')} ${pnlColor(formatUsd(p.unrealizedPnl))}  ` +
          `${c.muted('liq')} ${c.warn(`$${p.liquidationPrice.toFixed(4)}`)}`,
        );
      }
      message += '\n' + posLines.join('\n') + '\n';
      message += `\n  ${c.cyan('→')} ${c.muted(`UI: ${flashUiUrl()} (connect ${walletShort} to see same positions)`)}\n`;
    }

    return {
      success: true,
      message,
      data: { snapshot, positions, basketPda: basketPubkey },
    };
  },
};

export const magicPositions: ToolDefinition = {
  name: 'magicPositions',
  description: 'Show V2 positions for an owner from /positions/owner/{owner}. args: owner?',
  parameters: z.object({ owner: z.string().optional() }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildFlashV2Client(context);
    const owner = (params.owner as string | undefined) ?? ownerKeypair(context).publicKey.toBase58();
    const positions = await v2Positions(client, owner);
    if (positions.length === 0) {
      return {
        success: true,
        message: renderCard({
          status: 'Positions',
          tone: 'info',
          subtitle: c.muted('no open positions'),
          rows: [{ label: 'Owner', value: c.muted(owner) }],
          columns: 1,
        }),
        data: { positions },
      };
    }
    const rows = positions.map((p) => ({
      label: `${c.primary.bold(p.market.padEnd(7))} ${(p.side === 'long' ? c.long : c.short).bold(p.side.toUpperCase())}`,
      value:
        `${c.muted('size')} ${c.primary(formatUsd(p.sizeUsd))}  ` +
        `${c.muted('entry')} ${c.primary(formatPrice(p.entryPrice))}  ` +
        `${c.muted('pnl')} ${(p.unrealizedPnl >= 0 ? c.long : c.short)(formatUsd(p.unrealizedPnl))}`,
    }));
    return {
      success: true,
      message: renderCard({
        status: 'Positions',
        tone: 'info',
        subtitle: `${DIAMOND}  ${c.muted(`${positions.length} open · ${owner.slice(0, 8)}…`)}`,
        rows,
        columns: 1,
      }),
      data: { positions },
    };
  },
};

/**
 * Read the on-chain basket directly and verify it matches what the UI sees.
 * Useful when the user wants to confirm CLI/UI parity.
 */
export const magicVerify: ToolDefinition = {
  name: 'magicVerify',
  description: 'Verify on-chain state matches what the Flash UI sees (basket, positions).',
  async execute(_params, context): Promise<ToolResult> {
    const sdkClient = buildMagicClient(context);
    const v2Client = buildFlashV2Client(context);
    const owner = ownerKeypair(context).publicKey.toBase58();
    const { basketPubkey, basketAccount, basketSource, snapshot } = await readV2BasketState(v2Client, owner);
    const positionCount = positionsFromMetrics((snapshot.positionMetrics && typeof snapshot.positionMetrics === 'object' && !Array.isArray(snapshot.positionMetrics)
      ? snapshot.positionMetrics
      : {}) as JsonObject).length;
    const orderCount = records(snapshot.orderMetrics).length;
    const delegated = basketSource === 'er';

    const lines = [
      `Verification — same accounts the Flash UI reads:`,
      ``,
      `  Network:        ${sdkClient.network}`,
      `  Pool:           ${sdkClient.poolConfig.poolName} (${sdkClient.poolConfig.poolAddress.toBase58()})`,
      `  Program:        ${sdkClient.programId.toBase58()}`,
      `  Wallet:         ${owner}`,
      ``,
      `  Basket PDA:     ${basketPubkey || '(not initialized)'}`,
      `    on-chain:     ${basketAccount ? '✓ exists' : '✗ NOT FOUND — UI will show no positions'}`,
      `    delegated:    ${basketAccount ? (delegated ? '✓ to ER (UI must read flashtrade.magicblock.app)' : '✗ on L1') : 'n/a'}`,
      `    positions:    ${positionCount}`,
      `    orders:       ${orderCount}`,
      `    solscan:      ${basketPubkey ? solscanAcct(basketPubkey, sdkClient.network) : '(no basket account)'}`,
      ``,
      `  Open in UI:     ${flashUiUrl()}    (connect wallet ${owner.slice(0, 8)}…)`,
      ``,
      `Every CLI trade writes to these accounts. Anything you see here is what the UI sees.`,
    ];
    return {
      success: true,
      message: lines.join('\n'),
      data: {
        basketPda: basketPubkey,
        positionCount,
        orderCount,
        delegated,
      },
    };
  },
};

/** Infer category from a custody's pyth ticker (Crypto.SOL/USD, FX.EUR/USD, etc.). */
function categoryOf(pythTicker?: string): 'Crypto' | 'Equity' | 'FX' | 'Metal' | 'Commodity' | 'Other' {
  if (!pythTicker) return 'Other';
  if (pythTicker.startsWith('Crypto.')) return 'Crypto';
  if (pythTicker.startsWith('Equity.')) return 'Equity';
  if (pythTicker.startsWith('FX.')) return 'FX';
  if (pythTicker.startsWith('Metal.')) return 'Metal';
  if (pythTicker.startsWith('Commodities.')) return 'Commodity';
  return 'Other';
}

function categoryOfSymbol(symbol?: string): ReturnType<typeof categoryOf> | null {
  const s = symbol?.toUpperCase();
  if (!s) return null;
  if (['EUR', 'GBP', 'USDJPY', 'USDCNH'].includes(s)) return 'FX';
  if (['XAU', 'XAG', 'XAUT', 'XPD', 'XPT'].includes(s)) return 'Metal';
  if (['CRUDEOIL', 'NATGAS', 'COPPER'].includes(s)) return 'Commodity';
  return null;
}

export const magicMarkets: ToolDefinition = {
  name: 'magicMarkets',
  description: 'List V2 markets grouped by category, with leverage caps.',
  parameters: z.object({ category: z.string().optional(), filter: z.string().optional() }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildFlashV2Client(context);
    const filterCat = (params.category as string | undefined)?.toLowerCase();
    const filterSym = (params.filter as string | undefined)?.toUpperCase();
    const [poolDataRaw, tokensRaw, rawMarkets, rawCustodies] = await Promise.all([
      client.poolData(),
      client.tokens(),
      client.raw('markets'),
      client.raw('custodies'),
    ]);
    const tokenRows = Array.isArray(tokensRaw) ? tokensRaw as Record<string, unknown>[] : records(tokensRaw);
    const tokenBySymbol = new Map<string, Record<string, unknown>>();
    const tokenByMint = new Map<string, Record<string, unknown>>();
    for (const tok of tokenRows) {
      const sym = fieldString(tok, 'symbol').toUpperCase();
      if (sym) tokenBySymbol.set(sym, tok);
      const mint = fieldString(tok, 'mint');
      if (mint) tokenByMint.set(mint, tok);
    }
    const rawMarketByPubkey = new Map<string, Record<string, unknown>>();
    for (const item of records(rawMarkets)) {
      const pubkey = fieldString(item, 'pubkey');
      const account = isJsonRecord(item.account) ? item.account : item;
      if (pubkey) rawMarketByPubkey.set(pubkey, account);
    }
    const custodySymbolByPubkey = new Map<string, string>();
    for (const item of records(rawCustodies)) {
      const pubkey = fieldString(item, 'pubkey');
      const account = isJsonRecord(item.account) ? item.account : item;
      const mint = fieldString(account, 'mint');
      const symbol = fieldString(account, 'symbol') || fieldString(tokenByMint.get(mint) ?? {}, 'symbol');
      if (pubkey && symbol) custodySymbolByPubkey.set(pubkey, symbol.toUpperCase());
    }
    const pools = isPoolData(poolDataRaw);

    // Build per-symbol summary: side(s) available, maxLev, degenMaxLev, lock, category.
    type Row = {
      symbol: string;
      pair: string;
      category: ReturnType<typeof categoryOf>;
      sides: { side: 'long' | 'short'; lockSymbol: string; maxLev: number; degenMaxLev: number; pubkey: string }[];
    };
    const bySym = new Map<string, Row>();
    for (const pool of pools) {
      const custodyStats = records(pool.custodyStats);
      const custodyBySymbol = new Map(custodyStats.map((cu) => [fieldString(cu, 'symbol').toUpperCase(), cu]));
      const poolCategory = categoryOf(fieldString(pool, 'poolName'));
      for (const m of records(pool.marketStats)) {
        const symbol = fieldString(m, 'targetSymbol').toUpperCase();
        if (!symbol) continue;
        if (filterSym && symbol !== filterSym) continue;
        const tok = tokenBySymbol.get(symbol);
        const ticker = fieldString(tok ?? {}, 'pythTicker') || fieldString(tok ?? {}, 'pythSymbol');
        const cat = ticker ? categoryOf(ticker) : categoryOfSymbol(symbol) ?? poolCategory;
        if (filterCat && cat.toLowerCase() !== filterCat) continue;
        const custody = custodyBySymbol.get(symbol);
        let row = bySym.get(symbol);
        if (!row) {
          const pair = (fieldString(tok ?? {}, 'pythTicker') || `${symbol}/USD`).split('.').pop()!.replace(/\/USD$/, '/USD');
          row = { symbol, pair, category: cat, sides: [] };
          bySym.set(symbol, row);
        }
        const sideStr = fieldString(m, 'side').toLowerCase() === 'short' ? 'short' : 'long';
        const rawMarket = rawMarketByPubkey.get(fieldString(m, 'marketAccount'));
        const lockSymbol = rawMarket
          ? custodySymbolByPubkey.get(fieldString(rawMarket, 'collateralCustody')) ?? ''
          : '';
        row.sides.push({
          side: sideStr,
          lockSymbol: lockSymbol || fieldString(custody ?? {}, 'symbol') || 'USDC',
          maxLev: fieldNumber(custody ?? {}, 'maxLeverage') || 0,
          degenMaxLev: fieldNumber(custody ?? {}, 'maxDegenLeverage') || 0,
          pubkey: fieldString(m, 'marketAccount'),
        });
      }
    }

    // Group by category, render as a single tight table.
    const CATS: ReturnType<typeof categoryOf>[] = ['Crypto', 'Equity', 'FX', 'Metal', 'Commodity', 'Other'];
    const out: string[] = [
      '',
      `  ${chalk.cyan.bold(`MARKETS`)}  ${chalk.dim(`${bySym.size} symbols · ${Array.from(bySym.values()).reduce((n, r) => n + r.sides.length, 0)} markets · V2`)}`,
      `  ${chalk.dim('─'.repeat(74))}`,
    ];
    for (const cat of CATS) {
      const rows = Array.from(bySym.values()).filter((r) => r.category === cat);
      if (rows.length === 0) continue;
      // Per-category dynamic widths so any symbol / pair gets at least a
      // 2-space separator after it. Without this, an 8-char symbol like
      // `CRUDEOIL` collides with the next column. Header labels are also
      // included in the width calc so they never wrap below their data.
      const symW = Math.max(6, ...rows.map((r) => r.symbol.length)) + 2;
      const pairW = Math.max(4, ...rows.map((r) => r.pair.length)) + 2;
      const longLockW = Math.max(6, ...rows.map((r) => (r.sides.find((s) => s.side === 'long')?.lockSymbol ?? '-').length)) + 2;
      const shortLockW = Math.max(6, ...rows.map((r) => (r.sides.find((s) => s.side === 'short')?.lockSymbol ?? '-').length)) + 2;
      out.push('');
      out.push(`  ${chalk.cyan(cat.toUpperCase())}  ${chalk.dim(`(${rows.length})`)}`);
      out.push(
        '    ' +
          chalk.dim('Symbol'.padEnd(symW)) +
          chalk.dim('Pair'.padEnd(pairW)) +
          chalk.dim('L lock'.padEnd(longLockW)) +
          chalk.dim('S lock'.padEnd(shortLockW)) +
          chalk.dim('Max Leverage'),
      );
      for (const r of rows.sort((a, b) => a.symbol.localeCompare(b.symbol))) {
        const longSide = r.sides.find((s) => s.side === 'long');
        const shortSide = r.sides.find((s) => s.side === 'short');
        // Cap at 500x — Flash Magic Trade's documented public maximum.
        // The SDK's `degenMaxLev` field exists internally but isn't exposed
        // in the official UI and showing it implied a 1000x cap that doesn't
        // exist for users.
        const rawMaxLev = Math.max(longSide?.maxLev ?? 0, shortSide?.maxLev ?? 0);
        const maxLev = Math.min(500, rawMaxLev);
        out.push(
          '    ' +
            chalk.bold(r.symbol.padEnd(symW)) +
            chalk.dim(r.pair.padEnd(pairW)) +
            (longSide?.lockSymbol ?? '-').padEnd(longLockW) +
            (shortSide?.lockSymbol ?? '-').padEnd(shortLockW) +
            chalk.green(`${maxLev}x`),
        );
      }
    }
    out.push('');
    out.push(chalk.dim('  Filter: `markets crypto`, `markets fx`, `markets sol`'));
    out.push('');
    return {
      success: true,
      message: out.join('\n'),
      data: { count: bySym.size, totalMarkets: Array.from(bySym.values()).reduce((n, r) => n + r.sides.length, 0) },
    };
  },
};

function isPoolData(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const pools = (value as Record<string, unknown>).pools;
  return Array.isArray(pools) ? pools.filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null) : [];
}

/** Preflight — show everything needed to decide "can I trade right now?" */
export const magicStatus: ToolDefinition = {
  name: 'magicStatus',
  description: 'Show wallet + basket + deposit state. Preflight before trading.',
  async execute(_params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const v2Client = buildFlashV2Client(context);
    const stable = stableMintFor(client.network);
    const owner = ownerKeypair(context).publicKey.toBase58();
    const [p, basketState] = await Promise.all([
      client.preflight(new PublicKey(stable)),
      readV2BasketState(v2Client, owner),
    ]);
    const minSol = client.network === 'mainnet-beta' ? 0.005 : 0.01;
    const basketInitialised = basketState.basketPubkey.length > 0 && basketState.basketAccount !== null;
    const basketDelegated = basketState.basketSource === 'er';
    const depositCount = basketState.basketAccount
      ? records(basketState.basketAccount.debits).length + records(basketState.basketAccount.pendingCredits).length
      : 0;
    const faucetHint = client.network === 'mainnet-beta'
      ? c.muted('← top up SOL on mainnet')
      : c.muted('← run `faucet` for devnet SOL');

    const ok = (v: boolean) => (v ? c.long('✔ ready') : c.short('✖ not ready'));
    const walletShort = `${owner.slice(0, 4)}…${owner.slice(-4)}`;
    const solWarn = p.l1SolBalance < minSol ? `  ${faucetHint}` : '';
    const udlWarn = !p.udlInitialised ? `  ${c.muted('← run `setup`')}` : '';
    const basketWarn = !basketInitialised ? `  ${c.muted('← run `setup`')}` : '';
    const delegateWarn = basketInitialised && !basketDelegated ? `  ${c.muted('← run `setup` or `delegate`')}` : '';
    const stableAta = p.stableAtaExists
      ? `${c.primary('exists')}  ${c.muted(`raw=${p.stableAtaBalance ?? '?'}`)}`
      : c.muted('not yet — auto-created on deposit');
    const depositLabel = depositCount > 0
      ? c.primary(String(depositCount))
      : `${c.warn('0')}  ${c.muted('← run `deposit ' + stable + ' <amount>`')}`;

    const allReady = p.udlInitialised && basketInitialised && basketDelegated && depositCount > 0;
    const subtitle = allReady ? c.long('● ready to trade') : c.warn('● setup incomplete');

    const card = renderCard({
      status: 'Status',
      tone: allReady ? 'info' : 'warn',
      subtitle,
      columns: 1,
      rows: [
        { label: 'Network',    value: `${c.primary(p.network)} ${c.muted('·')} ${c.primary(p.poolName)}` },
        { label: 'Wallet',     value: `${c.primary(walletShort)}  ${c.muted(owner)}` },
        { label: 'SOL',        value: `${c.primary(p.l1SolBalance.toFixed(4))} SOL${solWarn}` },
        { label: 'UDL',        value: `${ok(p.udlInitialised)}${udlWarn}` },
        { label: 'Basket',     value: `${ok(basketInitialised)}${basketWarn}` },
        { label: 'Delegation', value: `${ok(basketDelegated)}${delegateWarn}` },
        { label: 'Stable ATA', value: stableAta },
        { label: 'Deposits',   value: depositLabel },
      ],
    });
    return { success: true, message: card, data: { preflight: p, basketPubkey: basketState.basketPubkey, depositCount } };
  },
};

export const magicFaucet: ToolDefinition = {
  name: 'magicFaucet',
  description: 'Show faucet URLs for devnet SOL and Flash Magic Trade test tokens (devnet only).',
  async execute(_params, context): Promise<ToolResult> {
    const network = context.config.network ?? 'mainnet-beta';
    if (network === 'mainnet-beta') {
      return {
        success: true,
        message:
          'Mainnet has no faucet — fund your wallet with real SOL + USDC.\n' +
          'For testing, switch to devnet by setting `MAGIC_NETWORK=devnet` in your .env.',
      };
    }
    const msg = [
      'Devnet SOL:',
      '  https://faucet.solana.com/     (captcha-gated, 1 SOL per request)',
      '  https://faucet.triangleplatform.com/solana/devnet',
      '  solana airdrop 2 --url devnet   (CLI; often rate-limited)',
      '',
      `Devnet stable mint (Magic Trade collateral): ${USDC_MINT_DEVNET}`,
      '  No public faucet — coordinate via Flash team.',
    ].join('\n');
    return { success: true, message: msg };
  },
};

/** One-time per-wallet setup: init UDL, init basket, delegate basket. Idempotent. */
export const magicSetup: ToolDefinition = {
  name: 'magicSetup',
  description: 'One-time V2 setup: initialize deposit ledger, basket, and delegate basket.',
  async execute(_params, context): Promise<ToolResult> {
    const owner = ownerKeypair(context).publicKey.toBase58();
    const steps: string[] = [];

    for (const [label, op] of [
      ['DepositLedger', 'initDepositLedger'],
      ['Basket', 'initBasket'],
      ['Delegate', 'delegateBasket'],
    ] as const) {
      try {
        const result = await signV2(context, op, { owner });
        if ('previewOnly' in result) steps.push(`✓ ${label}: preview only`);
        else steps.push(`✓ ${label}: ${result.signature}`);
      } catch (err) {
        steps.push(`✗ ${label}: ${getErrorMessage(err)}`);
      }
    }

    return {
      success: true,
      message: steps.join('\n'),
      data: { steps },
    };
  },
};

/**
 * Deposit tokens into the UserDepositLedger (vault) on L1.
 * Accepts a symbol (USDC, SOL, etc.) OR a raw mint pubkey, and a human amount.
 * Examples:
 *   magic deposit USDC 50          → $50 USDC into vault
 *   magic deposit SOL 0.1          → 0.1 SOL into vault
 */
export const magicDeposit: ToolDefinition = {
  name: 'magicDeposit',
  description: 'Deposit collateral with the V2 deposit builder. args: token symbol, amount (human units).',
  parameters: z.object({ token: z.string(), amount: z.number().positive() }),
  async execute(params, context): Promise<ToolResult> {
    const tokenArg = String(params.token);
    const amountHuman = params.amount as number;
    const symbol = tokenArg.toUpperCase();
    const result = await signV2(context, 'deposit', {
      owner: ownerKeypair(context).publicKey.toBase58(),
      tokenSymbol: symbol,
      amount: uiAmount(amountHuman),
    });
    if ('previewOnly' in result) {
      return { success: true, message: c.muted('  deposit preview only — no transaction returned'), data: { response: result.response } };
    }
    return {
      success: true,
      message: renderCard({
        status: 'Deposit Submitted',
        tone: 'open',
        subtitle: `${c.long('⇣')}  ${c.muted('wallet → Flash Account')}`,
        columns: 1,
        rows: [
          { label: 'Token',  value: c.primary.bold(symbol) },
          { label: 'Amount', value: c.primary(`${amountHuman} ${symbol}`) },
          { label: 'State',  value: c.muted('submitted — pending on-chain confirmation; re-read basket / stream for final state') },
        ],
        url: solscanTx(result.signature, context.config.network),
      }),
      txSignature: result.signature,
    };
  },
};

export const magicDepositDirect: ToolDefinition = {
  name: 'magicDepositDirect',
  description: 'Deposit by raw mint with the V2 deposit-direct builder. args: token mint, amount, fundingOwner?.',
  parameters: z.object({
    tokenMint: z.string(),
    amount: z.number().positive(),
    fundingOwner: z.string().optional(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const tokenMint = String(params.tokenMint);
    const amountHuman = params.amount as number;
    const result = await signV2(context, 'depositDirect', {
      owner: ownerKeypair(context).publicKey.toBase58(),
      tokenMint,
      amount: uiAmount(amountHuman),
      ...(params.fundingOwner ? { fundingOwner: String(params.fundingOwner) } : {}),
    });
    if ('previewOnly' in result) {
      return { success: true, message: c.muted('  deposit-direct preview only — no transaction returned'), data: { response: result.response } };
    }
    return {
      success: true,
      message: renderCard({
        status: 'Direct Deposit Submitted',
        tone: 'open',
        subtitle: `${c.long('⇣')}  ${c.muted('wallet → Flash Account')}`,
        columns: 1,
        rows: [
          { label: 'Mint', value: c.primary.bold(tokenMint) },
          { label: 'Amount', value: c.primary(String(amountHuman)) },
          { label: 'State', value: c.muted('re-read basket snapshot / stream for final state') },
        ],
        url: solscanTx(result.signature, context.config.network),
      }),
      txSignature: result.signature,
      data: { response: result.response },
    };
  },
};

export const magicInitDepositLedger: ToolDefinition = {
  name: 'magicInitDepositLedger',
  description: 'Initialize the V2 deposit ledger for the loaded wallet.',
  async execute(_params, context): Promise<ToolResult> {
    const owner = ownerKeypair(context).publicKey.toBase58();
    const result = await signV2(context, 'initDepositLedger', { owner });
    if ('previewOnly' in result) {
      return { success: true, message: c.muted('  init-deposit-ledger preview only — no transaction returned'), data: { response: result.response } };
    }
    return {
      success: true,
      message: renderCard({
        status: 'Deposit Ledger Ready',
        tone: 'open',
        subtitle: `${DIAMOND}  ${c.muted(owner)}`,
        columns: 1,
        rows: builderTxRows(result, context.config.network),
        url: solscanTx(result.signature, context.config.network),
      }),
      txSignature: result.signature,
      data: { response: result.response },
    };
  },
};

export const magicInitBasket: ToolDefinition = {
  name: 'magicInitBasket',
  description: 'Initialize the V2 basket for the loaded wallet.',
  async execute(_params, context): Promise<ToolResult> {
    const owner = ownerKeypair(context).publicKey.toBase58();
    const result = await signV2(context, 'initBasket', { owner });
    if ('previewOnly' in result) {
      return { success: true, message: c.muted('  init-basket preview only — no transaction returned'), data: { response: result.response } };
    }
    return {
      success: true,
      message: renderCard({
        status: 'Basket Ready',
        tone: 'open',
        subtitle: `${DIAMOND}  ${c.muted(owner)}`,
        columns: 1,
        rows: builderTxRows(result, context.config.network),
        url: solscanTx(result.signature, context.config.network),
      }),
      txSignature: result.signature,
      data: { response: result.response },
    };
  },
};

export const magicDelegateBasket: ToolDefinition = {
  name: 'magicDelegateBasket',
  description: 'Delegate the V2 basket to the Flash ER for trading.',
  async execute(_params, context): Promise<ToolResult> {
    const owner = ownerKeypair(context).publicKey.toBase58();
    const result = await signV2(context, 'delegateBasket', { owner });
    if ('previewOnly' in result) {
      return { success: true, message: c.muted('  delegate-basket preview only — no transaction returned'), data: { response: result.response } };
    }
    return {
      success: true,
      message: renderCard({
        status: 'Basket Delegated',
        tone: 'open',
        subtitle: `${DIAMOND}  ${c.muted('trading routes to ER')}`,
        columns: 1,
        rows: builderTxRows(result, context.config.network),
        url: solscanTx(result.signature, context.config.network),
      }),
      txSignature: result.signature,
      data: { response: result.response },
    };
  },
};

/**
 * Withdraw tokens from the vault — 2-step process: queue request via the ER,
 * then settle on L1. Bundled into one CLI command.
 */

/** MagicBlock ER delegation program. A custody owned by this program means
 *  it's currently delegated to the rollup and L1 settlement (the second step
 *  of withdraw) cannot run on it — caller will hit Anchor 3007. */
const ER_DELEGATION_PROGRAM_ID = 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh';

/**
 * Pre-flight: report which custodies are currently L1-withdrawable and which
 * are delegated to the ER (and thus blocked from withdraw until the protocol
 * authority commits + undelegates).
 *
 * Reads each custody's account owner via getMultipleAccountsInfo and matches
 * against the Flash program ID (good) or DELeGGv... (delegated, blocked).
 * No signatures, no fees — purely a read.
 */
export const magicWithdrawStatus: ToolDefinition = {
  name: 'magicWithdrawStatus',
  description: 'Per-custody withdraw readiness. Reports which custodies are L1-ready vs delegated to ER.',
  async execute(_params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    // l1Connection + programId live on the WRAPPER (MagicTradeClient), not
    // on the underlying SDK client. They're declared private but exist at
    // runtime — the cast pierces TS's compile-time visibility.
    const wrap = client as unknown as { l1Connection: import('@solana/web3.js').Connection; programId: PublicKey };
    const flashProgramId = wrap.programId.toBase58();

    const custodies = await readV2ActivePoolCustodies(context);
    const keys = custodies.map((cu) => cu.pubkey);
    const infos = await wrap.l1Connection.getMultipleAccountsInfo(keys, 'confirmed');

    let readyCount = 0;
    let delegatedCount = 0;
    let unknownCount = 0;
    const rows: Array<{ label: string; value: string }> = [];

    for (let i = 0; i < custodies.length; i++) {
      const cu = custodies[i];
      const info = infos[i];
      let status: string;
      if (!info) {
        unknownCount++;
        status = c.faint('? unreadable');
      } else if (info.owner.toBase58() === flashProgramId) {
        readyCount++;
        status = c.long('● ready');
      } else if (info.owner.toBase58() === ER_DELEGATION_PROGRAM_ID) {
        delegatedCount++;
        status = c.warn('◐ delegated');
      } else {
        unknownCount++;
        status = c.faint(`? owner ${info.owner.toBase58().slice(0, 8)}…`);
      }
      rows.push({ label: cu.symbol, value: status });
    }

    const summaryParts: string[] = [];
    if (readyCount > 0) summaryParts.push(c.long(`${readyCount} ready`));
    if (delegatedCount > 0) summaryParts.push(c.warn(`${delegatedCount} delegated`));
    if (unknownCount > 0) summaryParts.push(c.faint(`${unknownCount} unknown`));

    rows.push({ label: '', value: '' });
    rows.push({ label: 'Summary', value: summaryParts.join('  ·  ') });
    if (delegatedCount > 0) {
      rows.push({
        label: '',
        value: c.faint('delegated custodies will hit Anchor 3007 on withdraw — usually self-resolves in minutes'),
      });
    }

    return {
      success: true,
      message: renderCard({
        status: 'Withdraw Status',
        tone: 'info',
        subtitle: `${DIAMOND}  ${c.muted(`${custodies.length} custodies · ${client.network}`)}`,
        rows,
        columns: 1,
      }),
      data: { ready: readyCount, delegated: delegatedCount, unknown: unknownCount },
    };
  },
};

/**
 * Background watcher: poll withdraw status until any of the user's interesting
 * custodies (the ones they currently hold a balance in) flips to ready, then
 * notify the REPL. Runs as a fire-and-forget timer; exits on first ready hit
 * or after a hard cap. The CLI command `withdraw watch` is a thin shim that
 * arms this watcher.
 */
export const magicWithdrawWatch: ToolDefinition = {
  name: 'magicWithdrawWatch',
  description: 'Background-poll withdraw readiness; notify when a delegated custody flips ready.',
  async execute(_params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const wrap = client as unknown as { l1Connection: import('@solana/web3.js').Connection; programId: PublicKey };
    const flashProgramId = wrap.programId.toBase58();

    const owner = ownerKeypair(context).publicKey.toBase58();
    const balances = await readV2BasketTokenBalances(buildFlashV2Client(context), owner).catch(() => new Map());
    const heldSymbols = new Set<string>();
    for (const [sym, bal] of balances) {
      if (bal.debits > 0 || bal.pendingCredits > 0) heldSymbols.add(sym);
    }
    if (heldSymbols.size === 0) {
      return { success: true, message: c.muted('  no held balances to watch — withdraw is a no-op') };
    }

    // Start the poll. We poll every 30s, give up after 30 minutes.
    const POLL_MS = 30_000;
    const MAX_POLLS = 60;
    let polls = 0;
    const watchedKeys = (await readV2ActivePoolCustodies(context))
      .filter((cu) => heldSymbols.has(cu.symbol))
      .map((cu) => ({ symbol: cu.symbol, key: cu.pubkey }));

    const tick = async (): Promise<boolean> => {
      polls++;
      try {
        const infos = await wrap.l1Connection.getMultipleAccountsInfo(
          watchedKeys.map((w) => w.key),
          'confirmed',
        );
        const ready = watchedKeys
          .map((w, i) => ({ symbol: w.symbol, ready: infos[i]?.owner.toBase58() === flashProgramId }))
          .filter((r) => r.ready);
        if (ready.length > 0) {
          process.stdout.write(
            `\n  ${c.long('●')} ${c.primary.bold('withdraw watcher:')} ` +
            `${ready.map((r) => r.symbol).join(', ')} ${c.long('ready')} — try ` +
            `${c.cyan(`withdraw ${ready[0].symbol.toLowerCase()} max`)}\n`,
          );
          return true;
        }
      } catch { /* skip */ }
      return false;
    };

    const arm = (): void => {
      const t = setInterval(async () => {
        if (await tick()) {
          clearInterval(t);
          return;
        }
        if (polls >= MAX_POLLS) {
          clearInterval(t);
          process.stdout.write(`\n  ${c.faint('withdraw watcher: stopped after 30 min — re-arm with `withdraw watch`')}\n`);
        }
      }, POLL_MS);
      t.unref?.();
    };
    arm();

    return {
      success: true,
      message: renderCard({
        status: 'Withdraw Watcher',
        tone: 'info',
        subtitle: `${DIAMOND}  ${c.muted(`watching ${heldSymbols.size} custodies · 30s poll · 30 min cap`)}`,
        columns: 1,
        rows: [...heldSymbols].map((s) => ({ label: s, value: c.faint('polling…') })),
      }),
    };
  },
};

export const magicWithdraw: ToolDefinition = {
  name: 'magicWithdraw',
  description: 'Withdraw from the vault with the V2 withdrawal builder. args: token symbol, amount (human units OR "max").',
  parameters: z.object({
    token: z.string(),
    // Accept either a positive number (human units) or the literal "max" to
    // pull the full available basket balance.
    amount: z.union([z.number().positive(), z.literal('max')]),
  }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildFlashV2Client(context);
    const owner = ownerKeypair(context);
    const tokenArg = String(params.token);
    const symbol = tokenArg.toUpperCase();

    // Resolve "max" → live available balance. We round DOWN to the dust
    // boundary at the token's native decimals so the on-chain raw amount is
    // safely ≤ available; otherwise a tiny rounding-up could push the
    // withdraw past the basket's free balance and trip InsufficientAvailable.
    let amountHuman: number;
    if (params.amount === 'max') {
      const { basketAccount } = await readV2BasketState(client, owner.publicKey.toBase58());
      const tokens = await client.tokens();
      const tokenRows = Array.isArray(tokens) ? tokens as Record<string, unknown>[] : records(tokens);
      const token = tokenRows.find((t) => fieldString(t, 'symbol').toUpperCase() === symbol);
      const mint = token ? fieldString(token, 'mint') : '';
      const decimals = token ? fieldNumber(token, 'decimals') : 0;
      const entry = records(basketAccount?.debits).find((d) => fieldString(d, 'mint') === mint);
      const rawAmount = entry ? fieldNumber(entry, 'amount') : 0;
      const scale = decimals >= 0 ? 10 ** decimals : 1;
      const avail = entry ? fieldNumber(entry, 'amountUi') || fieldNumber(entry, 'availableUi') || (scale > 0 ? rawAmount / scale : 0) : 0;
      if (!Number.isFinite(avail) || avail <= 0) {
        return { success: false, message: `No ${symbol} available to withdraw (balance is 0).` };
      }
      // Round down at token-decimal granularity to dodge float drift.
      const tickSize = decimals > 0 ? 10 ** -decimals : 1;
      amountHuman = Math.floor(avail / tickSize) * tickSize;
      if (amountHuman <= 0) {
        return { success: false, message: `Available ${symbol} (${avail}) is below the minimum withdrawable unit.` };
      }
    } else {
      amountHuman = params.amount as number;
    }

    const feePayer = withdrawFeePayer(context, owner.publicKey);
    const body: Record<string, unknown> = {
      owner: owner.publicKey.toBase58(),
      tokenSymbol: symbol,
      amount: uiAmount(amountHuman),
      feePayer: feePayer.publicKey.toBase58(),
      ...(context.config.withdrawFeePayerTopUpLamports && context.config.withdrawFeePayerTopUpLamports > 0
        ? { feePayerTopUpLamports: context.config.withdrawFeePayerTopUpLamports }
        : {}),
    };
    const result = await client.signAndSubmit('withdraw', body, [owner, feePayer], {
      refreshOwner: owner.publicKey.toBase58(),
      retryExpiredBlockhash: true,
    });
    if ('previewOnly' in result) {
      return { success: true, message: c.muted('  withdrawal preview only — no transaction returned'), data: { response: result.response } };
    }
    const custodySettlementRequired =
      typeof result.response.custodySettlementRequired === 'boolean'
        ? result.response.custodySettlementRequired
        : false;

    // Format the amount cleanly — strip float drift like
    // `9.985586999999999` → `9.985587`. Six decimals max (matches USDC).
    const amountFmt = Number.isInteger(amountHuman)
      ? amountHuman.toString()
      : Number(amountHuman.toFixed(6)).toString();

    const rows: Array<{ label: string; value: string }> = [
      { label: 'Token',  value: c.primary.bold(symbol) },
      { label: 'Amount', value: c.primary(`${amountFmt} ${symbol}`) },
      { label: 'Fee payer', value: c.muted(`${feePayer.publicKey.toBase58().slice(0, 8)}…${feePayer.publicKey.toBase58().slice(-4)}`) },
      { label: 'Tx', value: c.muted(solscanTx(result.signature, context.config.network)) },
      { label: 'State', value: c.muted('re-read basket snapshot / stream for final state') },
    ];
    if (custodySettlementRequired) {
      rows.push({ label: 'Recovery', value: c.warn('run `custody-settlement ' + symbol + '` then retry withdraw') });
    }
    if (typeof result.response.receipt === 'string') {
      rows.push({ label: 'Receipt', value: c.muted(result.response.receipt) });
    }

    const card = renderCard({
      status: 'Withdrawal Submitted',
      tone: 'close',
      subtitle: `${DIAMOND}  ${c.muted('Flash Account → wallet · pending confirmation')}`,
      columns: 1,
      rows,
    });

    return {
      success: true,
      message: card,
      txSignature: result.signature,
      data: {
        amount: amountHuman,
        symbol,
        custodySettlementRequired,
        response: result.response,
      },
    };
  },
};

export const magicRequestWithdrawal: ToolDefinition = {
  name: 'magicRequestWithdrawal',
  description: 'Queue a V2 withdrawal request by raw mint. args: token mint, amount.',
  parameters: z.object({
    tokenMint: z.string(),
    amount: z.number().positive(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const owner = ownerKeypair(context);
    const feePayer = withdrawFeePayer(context, owner.publicKey);
    const tokenMint = String(params.tokenMint);
    const amountHuman = params.amount as number;
    const result = await buildFlashV2Client(context).signAndSubmit('requestWithdrawal', {
      owner: owner.publicKey.toBase58(),
      tokenMint,
      amount: uiAmount(amountHuman),
      feePayer: feePayer.publicKey.toBase58(),
    }, [owner, feePayer], {
      refreshOwner: owner.publicKey.toBase58(),
      retryExpiredBlockhash: true,
    });
    if ('previewOnly' in result) {
      return { success: true, message: c.muted('  request-withdrawal preview only — no transaction returned'), data: { response: result.response } };
    }
    return {
      success: true,
      message: renderCard({
        status: 'Withdrawal Requested',
        tone: 'warn',
        subtitle: `${DIAMOND}  ${c.muted('pending settlement may still be required')}`,
        columns: 1,
        rows: [
          { label: 'Mint', value: c.primary.bold(tokenMint) },
          { label: 'Amount', value: c.primary(String(amountHuman)) },
          { label: 'Fee payer', value: c.muted(`${feePayer.publicKey.toBase58().slice(0, 8)}…${feePayer.publicKey.toBase58().slice(-4)}`) },
          ...builderTxRows(result, context.config.network),
        ],
        url: solscanTx(result.signature, context.config.network),
      }),
      txSignature: result.signature,
      data: { response: result.response },
    };
  },
};

export const magicWithdrawalSettle: ToolDefinition = {
  name: 'magicWithdrawalSettle',
  description: 'Resume a pending V2 withdrawal by raw mint. args: token mint.',
  parameters: z.object({ tokenMint: z.string() }),
  async execute(params, context): Promise<ToolResult> {
    const tokenMint = String(params.tokenMint);
    const result = await signV2(context, 'withdrawalSettle', {
      owner: ownerKeypair(context).publicKey.toBase58(),
      tokenMint,
    });
    if ('previewOnly' in result) {
      return { success: true, message: c.muted('  withdrawal-settle preview only — no transaction returned'), data: { response: result.response } };
    }
    return {
      success: true,
      message: renderCard({
        status: 'Withdrawal Settled',
        tone: 'close',
        subtitle: `${DIAMOND}  ${c.muted('pending withdrawal resumed')}`,
        columns: 1,
        rows: [
          { label: 'Mint', value: c.primary.bold(tokenMint) },
          ...builderTxRows(result, context.config.network),
        ],
        url: solscanTx(result.signature, context.config.network),
      }),
      txSignature: result.signature,
      data: { response: result.response },
    };
  },
};

/**
 * Open a position — symbol-driven via the SDK.
 * Args:
 *   - market: target asset symbol (e.g. "SOL")
 *   - side: "long" or "short"
 *   - collateral: USDC amount in human units (e.g. 100 = $100 USDC)
 *   - leverage: integer multiplier (e.g. 5 = 5x)
 *   - collateralToken (optional): default "USDC"
 */
export const magicOpen: ToolDefinition = {
  name: 'magicOpen',
  description: 'Open a position by symbol. args: market, side, collateral, leverage, [tp?, sl?, collateralToken?].',
  parameters: z.object({
    market: z.string(),
    side: z.enum(['long', 'short']),
    collateral: z.number().positive(),
    leverage: z.number().positive(),
    tp: z.number().positive().optional(),
    sl: z.number().positive().optional(),
    collateralToken: z.string().optional(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildFlashV2Client(context);
    const owner = ownerKeypair(context).publicKey.toBase58();
    const targetMarket = String(params.market).toUpperCase();
    const targetSide = v2UiSide(String(params.side));
    const collateral = params.collateral as number;
    const leverage = params.leverage as number;
    const sizeUsd = collateral * leverage;

    // If the user already has an open position on this (market, side), the
    // program rejects a second `open`. Re-route to `increase` so they can
    // grow the existing position instead of getting a confusing error.
    let existing: PositionLike | undefined;
    try {
      const positions = await v2Positions(client, owner);
      existing = positions.find(
        (p) => p.market.toUpperCase() === targetMarket && String(p.side).toLowerCase() === targetSide,
      );
    } catch {
      /* fail open — fall through to normal open path */
    }

    if (existing) {
      const r = await signV2(context, 'increasePosition', {
        owner,
        marketSymbol: targetMarket,
        side: v2Side(targetSide),
        sizeAmountUi: await sizeUsdToTokenAmount(client, targetMarket, sizeUsd),
        collateralAmountUi: uiAmount(collateral),
        collateralTokenSymbol: (params.collateralToken as string | undefined)?.toUpperCase() ?? 'USDC',
        slippagePercentage: slippageStr(params),
      });
      if ('previewOnly' in r) {
        return { success: true, message: c.muted('  increase preview only — no transaction returned'), data: { response: r.response } };
      }
      const newSize = existing.sizeUsd + sizeUsd;
      const newColl = existing.collateralUsd + collateral;
      const newLev = newColl > 0 ? newSize / newColl : 0;

      // The increasePosition builder CANNOT carry TP/SL. If the user asked for
      // them, attach them explicitly to the now-larger position via placeTpSl,
      // re-reading the position for its exact new size. Previously the card
      // rendered "Stop Loss $X" unconditionally from params — so a trader who
      // set a protective stop walked away with NO stop actually placed.
      let triggersAttached = false;
      let triggerError = '';
      if (params.tp !== undefined || params.sl !== undefined) {
        try {
          const updated = (await v2Positions(client, owner)).find(
            (p) => p.market.toUpperCase() === targetMarket && String(p.side).toLowerCase() === targetSide,
          );
          if (!updated) throw new Error('position not found after increase');
          const tpsl = await signV2(context, 'placeTpSl', {
            owner,
            marketSymbol: targetMarket,
            side: v2Side(targetSide),
            sizeAmountUi: uiAmount(updated.sizeAmountUi),
            ...(params.tp !== undefined ? { takeProfitUi: uiAmount(params.tp as number) } : {}),
            ...(params.sl !== undefined ? { stopLossUi: uiAmount(params.sl as number) } : {}),
          });
          triggersAttached = !('previewOnly' in tpsl);
        } catch (err) {
          triggerError = getErrorMessage(err);
        }
      }

      const rows = [
        // formatUsdExact for user-visible precise values — matches the
        // pre-trade confirm preview rather than collapsing to K/M.
        { label: 'Existing',   value: c.muted(`${formatUsdExact(existing.sizeUsd)} @ ${existing.leverage.toFixed(2)}x`) },
        { label: 'Added size', value: c.long(`+${formatUsdExact(sizeUsd)}`) },
        { label: 'Added coll', value: c.long(`+${formatUsdExact(collateral)}`) },
        { label: 'New size',   value: c.primary.bold(formatUsdExact(newSize)) },
        { label: 'New coll',   value: c.primary.bold(formatUsdExact(newColl)) },
        { label: 'New lev',    value: c.primary(`${newLev.toFixed(2)}x`) },
      ];
      if (params.tp !== undefined || params.sl !== undefined) {
        if (triggersAttached) {
          if (params.tp !== undefined) rows.push({ label: 'Take Profit', value: c.long(formatPrice(params.tp as number)) });
          if (params.sl !== undefined) rows.push({ label: 'Stop Loss',   value: c.short(formatPrice(params.sl as number)) });
        } else {
          // Never imply a trigger that isn't on-chain. Warn + give the exact
          // command to set it manually.
          const which = [params.tp !== undefined ? 'TP' : '', params.sl !== undefined ? 'SL' : ''].filter(Boolean).join('/');
          const setHint = `set ${targetMarket} ${targetSide}${params.tp !== undefined ? ` tp ${params.tp}` : ''}${params.sl !== undefined ? ` sl ${params.sl}` : ''}`;
          rows.push({ label: c.warn.bold('⚠ Triggers'), value: c.warn(`${which} NOT attached${triggerError ? ` (${triggerError})` : ''} — run \`${setHint}\``) });
        }
      }
      rows.push(...builderTxRows(r, context.config.network));

      // Standardised subtitle — same shape as open/close/reverse cards
      // (`SOL · LONG · 2x`) with a "merged" footer dot. All trade cards
      // share the same theme so the user reads them at the same speed.
      const card = renderCard({
        status: 'Position Increased',
        tone: 'open',
        subtitle: `${marketHeader(targetMarket, targetSide, newLev)}  ${DOT}  ${c.muted('merged')}`,
        columns: 1,
        rows,
        url: solscanTx(r.signature, context.config.network),
      });
      return { success: true, message: card, txSignature: r.signature, data: { merged: true, existing, added: { sizeUsd, collateral }, triggersRequested: params.tp !== undefined || params.sl !== undefined, triggersAttached, response: r.response } };
    }

    // No existing position — normal atomic open + (optional) inline TP/SL.
    const result = await signV2(context, 'openPosition', {
      owner,
      inputTokenSymbol: (params.collateralToken as string | undefined)?.toUpperCase() ?? 'USDC',
      outputTokenSymbol: targetMarket,
      inputAmountUi: uiAmount(collateral),
      leverage,
      tradeType: v2Side(targetSide),
      orderType: 'MARKET',
      slippagePercentage: slippageStr(params),
      ...(params.tp ? { takeProfit: uiAmount(params.tp as number) } : {}),
      ...(params.sl ? { stopLoss: uiAmount(params.sl as number) } : {}),
    });
    if ('previewOnly' in result) {
      return { success: true, message: c.muted('  open preview only — no transaction returned'), data: { response: result.response } };
    }

    const entryPrice = fieldNumber(result.response, 'newEntryPrice');
    const liquidationPrice = fieldNumber(result.response, 'newLiquidationPrice');
    const returnedSizeUsd = fieldNumber(result.response, 'youRecieveUsdUi') || sizeUsd;
    const feeUsd = fieldNumber(result.response, 'entryFee');
    const liqStr = liquidationPrice && liquidationPrice > 0 ? chalk.yellow(formatPrice(liquidationPrice)) : chalk.dim('N/A');
    // Distance-to-liq as % of entry. Mirrors the official UI's risk pill.
    let distancePct = 0;
    if (
      Number.isFinite(entryPrice) && entryPrice > 0 &&
      Number.isFinite(liquidationPrice) && liquidationPrice > 0
    ) {
      const sideStr = String(params.side).toLowerCase();
      const raw = sideStr === 'long'
        ? (entryPrice - liquidationPrice) / entryPrice
        : (liquidationPrice - entryPrice) / entryPrice;
      distancePct = Math.max(0, raw) * 100;
    }
    const distanceColor = distancePct >= 30 ? c.long : distancePct >= 15 ? c.warn : c.short;
    const rows: Array<{ label: string; value: string }> = [
      { label: 'Entry', value: chalk.bold(formatPrice(entryPrice)) },
      { label: 'Liquidation', value: liqStr },
    ];
    if (distancePct > 0) {
      rows.push({ label: 'Dist to Liq', value: distanceColor(`${distancePct.toFixed(2)}%`) });
    }
    rows.push(
      // formatUsdExact (no K/M/B collapse) so the post-trade card matches the
      // pre-trade confirm preview — a user opening $5,432 collateral sees the
      // same $5,432.00 in both places, never $5.43K.
      { label: 'Size', value: chalk.bold(formatUsdExact(returnedSizeUsd)) },
      { label: 'Collateral', value: formatUsdExact(collateral) },
    );
    if (feeUsd > 0) {
      rows.push({ label: 'Open Fee', value: c.muted(formatUsdExact(feeUsd)) });
    }
    // Swap row historically exposed Flash's lock-asset mechanic (e.g.
    // SUI long locks in BTC). It read as "your USDC became BTC", which
    // is wrong — the position is on SUI, BTC is just the program's
    // bookkeeping token. The line was confusing more than informing,
    // so we omit it on both confirm and success cards. Power users who
    // care about the lock structure can run `markets <symbol>`.
    if (params.tp) rows.push({ label: 'Take Profit', value: c.long(formatPrice(params.tp as number)) });
    if (params.sl) rows.push({ label: 'Stop Loss',   value: c.short(formatPrice(params.sl as number)) });
    rows.push(...builderTxRows(result, context.config.network));

    return {
      success: true,
      message: renderCard({
        status: 'Position Opened',
        tone: 'open',
        subtitle: marketHeader(targetMarket, String(params.side), leverage),
        rows,
        url: solscanTx(result.signature, context.config.network),
      }),
      txSignature: result.signature,
      data: { result },
    };
  },
};

export const magicClose: ToolDefinition = {
  name: 'magicClose',
  description: 'Close a position by symbol. args: market, side, receiveToken?.',
  parameters: z.object({
    market: z.string(),
    side: z.enum(['long', 'short']),
    receiveToken: z.string().optional(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildFlashV2Client(context);
    const owner = ownerKeypair(context).publicKey.toBase58();
    const market = String(params.market).toUpperCase();
    const side = v2UiSide(String(params.side));
    const positions = await v2Positions(client, owner);
    const existing = positions.find((p) => p.market === market && p.side === side);
    if (!existing) {
      return { success: false, message: `No open ${side} position on ${market}.` };
    }
    const result = await signV2(context, 'closePosition', {
      owner,
      marketSymbol: market,
      side: v2Side(side),
      inputUsdUi: uiAmount(existing.sizeUsd),
      withdrawTokenSymbol: (params.receiveToken as string | undefined)?.toUpperCase() ?? 'USDC',
      slippagePercentage: slippageStr(params),
      closeAll: true,
    });
    if ('previewOnly' in result) {
      return { success: true, message: c.muted('  close preview only — no transaction returned'), data: { response: result.response } };
    }
    const pnl = fieldNumber(existing.raw, 'pnlWithFeeUsdUi');
    const pnlColor = pnl >= 0 ? chalk.green : chalk.red;
    const card = renderCard({
      status: 'Position Closed',
      tone: 'close',
      subtitle: marketHeader(market, side),
      rows: [
        { label: 'PnL', value: chalk.bold(pnlColor(formatUsd(pnl))) },
        ...builderTxRows(result, context.config.network),
      ],
      url: solscanTx(result.signature, context.config.network),
    });
    return {
      success: true,
      message: card,
      txSignature: result.signature,
      data: { result },
    };
  },
};

export const magicAddCollateral: ToolDefinition = {
  name: 'magicAddCollateral',
  description: 'Add collateral to an open position. args: market, side, amount, token? (defaults USDC; SOL/BTC/etc. supported).',
  parameters: z.object({
    market: z.string(),
    side: z.enum(['long', 'short']),
    amount: z.number().positive(),
    token: z.string().optional(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const owner = ownerKeypair(context).publicKey.toBase58();
    const tokenSymbol = (params.token as string | undefined)?.toUpperCase();
    const sym = String(params.market).toUpperCase();
    const sideStr = String(params.side);
    const result = await signV2(context, 'addCollateral', {
      owner,
      marketSymbol: sym,
      side: v2Side(sideStr),
      depositAmountUi: uiAmount(params.amount as number),
      depositTokenSymbol: tokenSymbol ?? 'USDC',
    });
    if ('previewOnly' in result) {
      return { success: true, message: c.muted('  add-collateral preview only — no transaction returned'), data: { response: result.response } };
    }
    // Format the amount in token-native units when not USDC, else USD.
    const amountLabel = tokenSymbol && tokenSymbol !== 'USDC'
      ? c.long(`+${(params.amount as number).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${tokenSymbol}`)
      : c.long(`+${formatUsd(params.amount as number)}`);
    return {
      success: true,
      message: renderCard({
        status: 'Collateral Added',
        tone: 'open',
        subtitle: marketHeader(sym, sideStr),
        columns: 1,
        rows: [
          { label: 'Amount', value: amountLabel },
          { label: 'Asset',  value: c.primary(tokenSymbol ?? 'USDC') },
          ...builderTxRows(result, context.config.network),
        ],
        url: solscanTx(result.signature, context.config.network),
      }),
      txSignature: result.signature,
    };
  },
};

export const magicRemoveCollateral: ToolDefinition = {
  name: 'magicRemoveCollateral',
  description: 'Remove USD collateral from an open position. args: market, side, amount (USD), token? (payout asset, defaults USDC).',
  parameters: z.object({
    market: z.string(),
    side: z.enum(['long', 'short']),
    amount: z.number().positive(),
    token: z.string().optional(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const owner = ownerKeypair(context).publicKey.toBase58();
    const tokenSymbol = (params.token as string | undefined)?.toUpperCase();
    const sym = String(params.market).toUpperCase();
    const sideStr = String(params.side);
    const result = await signV2(context, 'removeCollateral', {
      owner,
      marketSymbol: sym,
      side: v2Side(sideStr),
      withdrawAmountUsdUi: uiAmount(params.amount as number),
      withdrawTokenSymbol: tokenSymbol ?? 'USDC',
    });
    if ('previewOnly' in result) {
      return { success: true, message: c.muted('  remove-collateral preview only — no transaction returned'), data: { response: result.response } };
    }
    return {
      success: true,
      message: renderCard({
        status: 'Collateral Removed',
        tone: 'close',
        subtitle: marketHeader(sym, sideStr),
        columns: 1,
        rows: [
          { label: 'Amount', value: c.short(`-${formatUsd(params.amount as number)}`) },
          ...builderTxRows(result, context.config.network),
        ],
        url: solscanTx(result.signature, context.config.network),
      }),
      txSignature: result.signature,
    };
  },
};

/**
 * Report the spot price for a market via the on-chain oracle, plus the oracle
 * account pubkey so the user can cross-check on Solscan/Pyth/etc.
 */
export const magicPrice: ToolDefinition = {
  name: 'magicPrice',
  description: 'Query Flash V2 price data for a market.',
  parameters: z.object({ market: z.string() }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildFlashV2Client(context);
    const sym = String(params.market).toUpperCase();
    const priceRaw = await client.prices(sym).catch((err) => {
      throw new Error(`V2 price read failed: ${getErrorMessage(err)}`);
    });
    if (!priceRaw || typeof priceRaw !== 'object' || Array.isArray(priceRaw)) {
      return { success: false, message: `Unknown market '${sym}'. Run \`markets\` to see available symbols.` };
    }
    const priceObj = priceRaw as Record<string, unknown>;
    const price = fieldNumber(priceObj, 'priceUi');
    const confidence = fieldNumber(priceObj, 'confidence');
    const exponent = fieldNumber(priceObj, 'exponent');
    const marketSession = fieldString(priceObj, 'marketSession') || '—';
    const timestampUs = fieldNumber(priceObj, 'timestampUs');
    const stamp = timestampUs > 0 ? new Date(Math.floor(timestampUs / 1000)).toLocaleString() : '—';
    // Confidence lands from the oracle in raw units; scale by the exponent so
    // it reads in the same units as the price (± dollars), not raw integers.
    const confUi = Number.isFinite(confidence) && Number.isFinite(exponent)
      ? confidence * Math.pow(10, exponent)
      : NaN;
    const sess = marketSession.toLowerCase();
    const sessColored =
      sess === 'closed' ? c.short(marketSession)
        : sess === 'break' ? c.warn(marketSession)
        : sess === 'pre' || sess === 'post' ? c.cyan(marketSession)
        : sess === 'regular' || sess === 'open' ? c.long(marketSession)
        : c.muted(marketSession);
    const message = renderCard({
      status: sym,
      tone: 'info',
      subtitle: `${DIAMOND}  ${c.muted('Flash V2 oracle')}`,
      rows: [
        { label: 'Price', value: c.primary.bold(formatPrice(price)) },
        { label: 'Session', value: sessColored },
        { label: 'Confidence', value: Number.isFinite(confUi) ? c.muted(`± ${formatPrice(confUi)}`) : c.faint('—') },
        { label: 'Updated', value: c.muted(stamp) },
      ],
      columns: 1,
    });
    return { success: true, message, data: { symbol: sym, price, raw: priceObj } };
  },
};

export const magicApiHealth: ToolDefinition = {
  name: 'magicApiHealth',
  description: 'Show Flash Trade V2 API health.',
  async execute(_params, context): Promise<ToolResult> {
    const health = await buildFlashV2Client(context).health();
    return {
      success: true,
      message: renderCard({
        status: 'API Health',
        tone: 'info',
        subtitle: `${DIAMOND}  ${c.muted('Flash Trade V2')}`,
        rows: jsonRows(health),
        columns: 1,
      }),
      data: { health: health as JsonObject },
    };
  },
};

export const magicTokens: ToolDefinition = {
  name: 'magicTokens',
  description: 'List supported Flash Trade V2 tokens.',
  async execute(_params, context): Promise<ToolResult> {
    const tokens = await buildFlashV2Client(context).tokens();
    const list = Array.isArray(tokens) ? tokens as Record<string, unknown>[] : records(tokens);
    const rows = list.slice(0, 80).map((t) => ({
      label: fieldString(t, 'symbol').toUpperCase(),
      value: c.muted(fieldString(t, 'name') || fieldString(t, 'pythTicker') || fieldString(t, 'mint') || 'supported'),
    }));
    return {
      success: true,
      message: renderCard({
        status: 'Tokens',
        tone: 'info',
        subtitle: `${DIAMOND}  ${c.muted(`${list.length} supported`)}`,
        rows: rows.length > 0 ? rows : [{ label: '', value: c.muted('No tokens returned') }],
        columns: 1,
      }),
      data: { tokens: tokens as JsonObject },
    };
  },
};

export const magicPrices: ToolDefinition = {
  name: 'magicPrices',
  description: 'Read Flash Trade V2 prices. args: symbol?',
  parameters: z.object({ symbol: z.string().optional() }),
  async execute(params, context): Promise<ToolResult> {
    const symbol = (params.symbol as string | undefined)?.toUpperCase();
    const prices = await buildFlashV2Client(context).prices(symbol);
    if (symbol) {
      const obj = isJsonRecord(prices) ? prices : {};
      return {
        success: true,
        message: renderCard({
          status: 'Price',
          tone: 'info',
          subtitle: c.primary.bold(symbol),
          rows: jsonRows(obj),
          columns: 1,
        }),
        data: { prices: obj },
      };
    }
    const rows = isJsonRecord(prices)
      ? Object.entries(prices).slice(0, 80).flatMap(([key, raw]) => {
        if (!isJsonRecord(raw)) return [];
        const label = (fieldString(raw, 'symbol') || key).toUpperCase();
        return [{ label, value: c.primary(formatPrice(fieldNumber(raw, 'priceUi'))) }];
      })
      : records(prices).slice(0, 80).map((p) => ({
        label: fieldString(p, 'symbol').toUpperCase(),
        value: c.primary(formatPrice(fieldNumber(p, 'priceUi'))),
      }));
    return {
      success: true,
      message: renderCard({
        status: 'Prices',
        tone: 'info',
        subtitle: `${DIAMOND}  ${c.muted(`${rows.length} shown`)}`,
        rows: rows.length > 0 ? rows : [{ label: '', value: compactJson(prices, 1200) }],
        columns: 1,
      }),
      data: { prices: prices as JsonObject },
    };
  },
};

export const magicPoolData: ToolDefinition = {
  name: 'magicPoolData',
  description: 'Read Flash Trade V2 pool data. args: pubkey?',
  parameters: z.object({ pubkey: z.string().optional() }),
  async execute(params, context): Promise<ToolResult> {
    const pubkey = params.pubkey as string | undefined;
    const data = await buildFlashV2Client(context).poolData(pubkey);
    const pools = isPoolData(data);
    return {
      success: true,
      message: renderCard({
        status: 'Pool Data',
        tone: 'info',
        subtitle: pubkey ? c.muted(pubkey) : `${DIAMOND}  ${c.muted(`${pools.length} pools`)}`,
        rows: pubkey ? jsonRows(data) : pools.map((p) => ({
          label: fieldString(p, 'poolName') || fieldString(p, 'poolAddress').slice(0, 8),
          value: `${c.primary(`${records(p.custodyStats).length} custodies`)}  ${c.muted(`${records(p.marketStats).length} markets`)}`,
        })),
        columns: 1,
      }),
      data: { poolData: data as JsonObject },
    };
  },
};

export const magicRaw: ToolDefinition = {
  name: 'magicRaw',
  description: 'Read documented raw V2 accounts. args: pools|custodies|markets|perpetuals|basket [pubkey].',
  parameters: z.object({
    kind: z.enum(['pools', 'custodies', 'markets', 'perpetuals', 'basket']),
    pubkey: z.string().optional(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildFlashV2Client(context);
    const kind = params.kind as 'pools' | 'custodies' | 'markets' | 'perpetuals' | 'basket';
    const pubkey = params.pubkey as string | undefined;
    if (kind === 'basket' && !pubkey) {
      return { success: false, message: 'raw basket requires a basket pubkey: `raw basket <pubkey>`' };
    }
    const data = kind === 'basket'
      ? await client.rawBasket(pubkey!)
      : await client.raw(kind, pubkey);
    return {
      success: true,
      message: renderCard({
        status: 'Raw',
        tone: 'info',
        subtitle: `${c.primary.bold(kind)}${pubkey ? `  ${c.muted(pubkey)}` : ''}`,
        rows: [{ label: '', value: compactJson(data) }],
        columns: 1,
      }),
      data: { raw: data as JsonObject },
    };
  },
};

export const magicSnapshot: ToolDefinition = {
  name: 'magicSnapshot',
  description: 'Fetch the V2 basket snapshot for an owner. args: owner?',
  parameters: z.object({ owner: z.string().optional() }),
  async execute(params, context): Promise<ToolResult> {
    const owner = (params.owner as string | undefined) ?? ownerKeypair(context).publicKey.toBase58();
    const snapshot = await buildFlashV2Client(context).owner(owner);
    const positions = positionsFromMetrics((snapshot.positionMetrics && typeof snapshot.positionMetrics === 'object' && !Array.isArray(snapshot.positionMetrics)
      ? snapshot.positionMetrics
      : {}) as JsonObject);
    const orders = records(snapshot.orderMetrics);
    return {
      success: true,
      message: renderCard({
        status: 'Snapshot',
        tone: 'info',
        subtitle: `${DIAMOND}  ${c.muted(owner)}`,
        rows: [
          { label: 'Basket', value: typeof snapshot.basketPubkey === 'string' ? c.primary(snapshot.basketPubkey) : c.muted('not initialized') },
          { label: 'Positions', value: c.primary(String(positions.length)) },
          { label: 'Order groups', value: c.primary(String(orders.length)) },
          { label: 'Rule', value: c.muted('basket snapshot is source of truth') },
        ],
        columns: 1,
      }),
      data: { snapshot },
    };
  },
};

export const magicPreview: ToolDefinition = {
  name: 'magicPreview',
  description: 'Call a documented V2 preview endpoint. args: name json-body.',
  parameters: z.object({ name: z.string(), body: z.string() }),
  async execute(params, context): Promise<ToolResult> {
    const rawName = String(params.name);
    const name = rawName.replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase()) as keyof typeof FLASH_V2_PREVIEWS;
    if (!(name in FLASH_V2_PREVIEWS)) {
      return { success: false, message: `Unknown preview '${rawName}'. Available: ${Object.keys(FLASH_V2_PREVIEWS).join(', ')}` };
    }
    const body = parseJsonRecordBody(params.body);
    const result = await buildFlashV2Client(context).preview(name, body);
    return {
      success: true,
      message: renderCard({
        status: 'Preview',
        tone: 'info',
        subtitle: c.primary.bold(rawName),
        rows: [{ label: '', value: compactJson(result) }],
        columns: 1,
      }),
      data: { preview: result },
    };
  },
};

export const magicBuilder: ToolDefinition = {
  name: 'magicBuilder',
  description: 'Call any documented V2 builder by operation name with a JSON body.',
  parameters: z.object({ operation: z.string(), body: z.string(), sign: z.boolean().optional() }),
  async execute(params, context): Promise<ToolResult> {
    const raw = String(params.operation);
    const operation = raw.replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase()) as FlashV2BuilderName;
    if (!(operation in FLASH_V2_BUILDERS)) {
      return { success: false, message: `Unknown builder '${raw}'. Available: ${Object.keys(FLASH_V2_BUILDERS).join(', ')}` };
    }
    const body = parseJsonRecordBody(params.body);
    const client = buildFlashV2Client(context);
    if (params.sign) {
      const owner = ownerKeypair(context);
      const ownerBase58 = owner.publicKey.toBase58();
      if (typeof body.owner === 'string' && body.owner !== ownerBase58) {
        return {
          success: false,
          message: 'builder sign requires body.owner to match the loaded wallet public key.',
        };
      }
      if (operation === 'openPosition' && typeof body.owner !== 'string') {
        return {
          success: false,
          message: 'builder sign open-position requires `owner` in the JSON body. Omitting `owner` is preview-only mode.',
        };
      }
      const extra: Keypair[] = [];
      if (operation === 'withdraw' || operation === 'requestWithdrawal') {
        const fee = withdrawFeePayer(context, owner.publicKey);
        if (typeof body.feePayer === 'string' && fee.publicKey.toBase58() !== body.feePayer) {
          return { success: false, message: 'builder sign for withdraw requires body.feePayer to match MAGIC_WITHDRAW_FEE_PAYER_PATH or the generated local signer.' };
        }
        body.feePayer = fee.publicKey.toBase58();
        extra.push(fee);
      }
      const result = await client.signAndSubmit(operation, body, [owner, ...extra], {
        refreshOwner: owner.publicKey.toBase58(),
        retryExpiredBlockhash: true,
      });
      return {
        success: true,
        message: renderCard({
          status: 'Builder',
          tone: 'open',
          subtitle: c.primary.bold(raw),
          rows: 'previewOnly' in result ? jsonRows(result.response) : builderTxRows(result, context.config.network),
          columns: 1,
        }),
        txSignature: 'previewOnly' in result ? undefined : result.signature,
        data: { result },
      };
    }
    const result = await client.build(operation, body);
    return {
      success: true,
      message: renderCard({
        status: 'Builder',
        tone: 'info',
        subtitle: `${c.primary.bold(raw)}  ${c.muted('unsigned')}`,
        rows: [{ label: '', value: compactJson(result) }],
        columns: 1,
      }),
      data: { result },
    };
  },
};

export const magicBasketStream: ToolDefinition = {
  name: 'magicBasketStream',
  description: 'Read a bounded V2 WebSocket basket stream. args: owner? updateIntervalMs? maxMessages?',
  parameters: z.object({
    owner: z.string().optional(),
    updateIntervalMs: z.number().int().positive().optional(),
    maxMessages: z.number().int().positive().max(20).optional(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const WebSocketCtor = globalThis.WebSocket;
    if (!WebSocketCtor) return { success: false, message: 'WebSocket is not available in this Node runtime.' };
    const owner = (params.owner as string | undefined) ?? ownerKeypair(context).publicKey.toBase58();
    const updateIntervalMs = (params.updateIntervalMs as number | undefined) ?? 1000;
    const maxMessages = (params.maxMessages as number | undefined) ?? 3;
    const base = (context.config.flashApiUrl ?? 'https://flashapi.trade').replace(/^http/i, 'ws').replace(/\/+$/, '');
    const url = `${base}/owner/${encodeURIComponent(owner)}/ws?updateIntervalMs=${encodeURIComponent(String(updateIntervalMs))}`;
    const received: JsonObject[] = [];
    let firstFrameType: string | null = null;
    let basketFrames = 0;
    let metricsFrames = 0;
    let closeCode: number | null = null;
    let closeReason = '';
    await new Promise<void>((resolveStream, rejectStream) => {
      const ws = new WebSocketCtor(url);
      const timeout = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        resolveStream();
      }, Math.max(5_000, updateIntervalMs * (maxMessages + 2)));
      timeout.unref?.();
      ws.onerror = () => {
        clearTimeout(timeout);
        rejectStream(new Error('V2 WebSocket stream failed'));
      };
      ws.onmessage = (event: MessageEvent) => {
        try {
          const parsed = JSON.parse(String(event.data)) as unknown;
          if (isJsonRecord(parsed)) {
            received.push(parsed);
            const type = fieldString(parsed, 'type');
            if (!firstFrameType && type) firstFrameType = type;
            if (type === 'basket') basketFrames++;
            else if (type === 'metrics') metricsFrames++;
          }
        } catch { /* ignore malformed stream frame */ }
        if (received.length >= maxMessages) {
          clearTimeout(timeout);
          try { ws.close(); } catch { /* ignore */ }
          resolveStream();
        }
      };
      ws.onclose = (event: CloseEvent) => {
        clearTimeout(timeout);
        closeCode = typeof event.code === 'number' ? event.code : null;
        closeReason = typeof event.reason === 'string' ? event.reason : '';
        resolveStream();
      };
    });
    const protocolOk = received.length === 0 || firstFrameType === 'basket';
    return {
      success: protocolOk,
      message: renderCard({
        status: 'Basket Stream',
        tone: protocolOk ? 'info' : 'warn',
        subtitle: `${DIAMOND}  ${c.muted(`${received.length} frame${received.length === 1 ? '' : 's'} · ${updateIntervalMs}ms`)}`,
        rows: [
          { label: 'Owner', value: c.muted(owner) },
          { label: 'Source', value: c.muted(`wss://flashapi.trade/owner/{owner}/ws?updateIntervalMs=${updateIntervalMs}`) },
          { label: 'First', value: firstFrameType ? c.primary(firstFrameType) : c.muted('none before timeout') },
          { label: 'Frames', value: c.muted(`${basketFrames} basket · ${metricsFrames} metrics`) },
          ...(closeCode !== null || closeReason
            ? [{ label: 'Close', value: c.muted(`${closeCode ?? '—'}${closeReason ? ` · ${closeReason}` : ''}`) }]
            : []),
          { label: 'Latest', value: received.length > 0 ? compactJson(received[received.length - 1], 900) : c.muted('no frames before timeout') },
        ],
        columns: 1,
      }),
      data: { frames: received, firstFrameType, basketFrames, metricsFrames, closeCode, closeReason },
    };
  },
};

/**
 * Show the user's vault state per token: gross deposit, locked in positions,
 * and what's actually available for new trades. Faster + more focused than
 * `magic verify` which is the full audit view.
 */
export const magicVault: ToolDefinition = {
  name: 'magicVault',
  description: 'Show vault balance per token (deposits, locked, available).',
  async execute(_params, context): Promise<ToolResult> {
    const owner = ownerKeypair(context).publicKey.toBase58();
    const balances = await readV2BasketTokenBalances(buildFlashV2Client(context), owner);
    const visibleBalances = [...balances.values()].filter((b) => b.debits > 0 || b.pendingCredits > 0);

    if (visibleBalances.length === 0) {
      return {
        success: true,
        message: renderCard({
          status: 'Vault',
          tone: 'info',
          subtitle: `${DIAMOND}  ${c.muted(context.config.network)}`,
          rows: [{ label: 'Balance', value: c.faint('empty — run `deposit USDC <amount>` to fund') }],
          columns: 1,
        }),
      };
    }

    // Vault — single Available column per token. The full UDL / debits /
    // pending breakdown is intentionally hidden from this view; it's noisy
    // and confusing for the common case. Use `account` for the V2-mirror
    // side-by-side or read the on-chain basket directly if you need the
    // breakdown.
    let totalAvailUsd = 0;
    const rows: Array<{ label: string; value: string }> = [];
    for (const bal of visibleBalances.sort((a, b) => Number(b.isStable) - Number(a.isStable) || a.symbol.localeCompare(b.symbol))) {
      const sym = bal.symbol;
      const dec = bal.decimals;
      const fmt = (n: number) => (dec === 6 ? n.toFixed(2) : n.toFixed(6));
      if (bal.isStable) totalAvailUsd += bal.debits;
      const base = bal.debits > 0.0001
        ? c.primary.bold(bal.isStable ? `$${fmt(bal.debits)}` : fmt(bal.debits))
        : c.faint(bal.isStable ? '$0.00' : '0.0000');
      const pending = bal.pendingCredits > 0.0000001
        ? `  ${c.muted(`+${formatPendingAmount(bal.pendingCredits, dec)} pending`)}`
        : '';
      const value = `${base}${pending}`;
      rows.push({ label: sym, value });
    }
    rows.push({ label: '', value: '' });
    rows.push({
      label: 'Stable USD',
      value: `${c.primary.bold(formatUsd(totalAvailUsd))} ${c.muted('available')}`,
    });
    return {
      success: true,
      message: renderCard({
        status: 'Vault',
        tone: 'info',
        subtitle: `${DIAMOND}  ${c.muted(`${visibleBalances.length} tokens · ${context.config.network}`)}`,
        rows,
        columns: 1,
      }),
      data: { balances: Object.fromEntries([...balances.entries()].map(([k, v]) => [k, v])) },
    };
  },
};

/**
 * Account view — Flash Account (basket) balances side-by-side with wallet
 * balances, the CLI mirror of the V2 UI's Account tab. The "actions" are the
 * existing `deposit` / `withdraw` verbs you already type.
 */
export const magicAccount: ToolDefinition = {
  name: 'magicAccount',
  description: 'Show Flash Account (basket) and wallet balances side-by-side per token.',
  async execute(_params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const v2Client = buildFlashV2Client(context);
    const owner = ownerKeypair(context).publicKey.toBase58();

    // Determine which tokens we actually need to render before we fan out
    // oracle reads — keeps cold cost to one fetch per non-stable lock symbol
    // even on a fresh process. Lock custodies = the only depositable tokens.
    const lockCustodies = new Set<string>();
    for (const m of client.poolConfig.markets) {
      const lockCu = client.poolConfig.custodies.find((cu) => cu.custodyAccount.equals(m.collateralCustody));
      if (lockCu) lockCustodies.add(lockCu.symbol);
    }
    const poolSymbols = [...lockCustodies];
    const stableSet = new Set(
      client.poolConfig.custodies.filter((cu) => cu.isStable).map((cu) => cu.symbol),
    );
    const sorted = poolSymbols.sort((a, b) => {
      const aS = stableSet.has(a) ? 0 : 1;
      const bS = stableSet.has(b) ? 0 : 1;
      return aS - bS || a.localeCompare(b);
    });

    // Two-phase fetch: balances first (cheap), then oracle quotes ONLY for
    // tokens with a non-zero balance. The public mainnet RPC chokes (429s)
    // when a single command issues 7+ simulate-based oracle reads in
    // parallel; most of those reads are for tokens the user holds zero of
    // anyway, so they're pure waste. Skipping zero-balance oracle calls cuts
    // the typical case from N reads to 1-2.
    const [basket, walletBalances] = await Promise.all([
      readV2BasketTokenBalances(v2Client, owner),
      context.walletManager.getTokenBalances().catch(() => ({ sol: 0, tokens: [] })),
    ]);

    // Index wallet by symbol HERE (early) so the held-token check below
    // can read it.
    const walletBySymbol = new Map<string, number>();
    walletBySymbol.set('SOL', walletBalances.sol);
    if (walletBalances.tokens) {
      for (const t of walletBalances.tokens) {
        const sym = t.symbol === 'WSOL' ? 'SOL' : t.symbol;
        walletBySymbol.set(sym, (walletBySymbol.get(sym) ?? 0) + t.amount);
      }
    }

    const nonStable = sorted.filter((s) => !stableSet.has(s));
    const heldNonStable = nonStable.filter((s) => {
      const flash = basket.get(s)?.debits ?? 0;
      const wal = walletBySymbol.get(s) ?? 0;
      return flash > 0 || wal > 0;
    });
    // fetchOraclePrice's cache de-dupes anything we DID query during this
    // process so back-to-back `account` calls cost zero extra RPC.
    const oraclePrices = await Promise.all(
      heldNonStable.map((s) => v2Client.prices(s).then((p) => isJsonRecord(p) ? fieldNumber(p, 'priceUi') : 0).catch(() => 0)),
    );
    const priceBySymbol = new Map<string, number>();
    heldNonStable.forEach((s, i) => priceBySymbol.set(s, oraclePrices[i] ?? 0));

    // Per-token brand colors — picks up the V2 UI's vibe (USDC teal, SOL purple,
    // BTC orange, etc.). Falls back to primary white for unknown symbols.
    const TOKEN_COLOR: Record<string, (s: string) => string> = {
      USDC: c.cyan, USDT: c.cyan,
      SOL:  c.purple, ETH: c.blue, BTC: c.warn,
      HYPE: c.lime,
      SPY:  c.short, AAPL: c.short, AMZN: c.short, NVDA: c.short, TSLA: c.short,
      ZEC:  c.yellow, BNB: c.yellow,
      XAU:  c.yellow, XAG: c.muted,
    };
    const colorFor = (sym: string): ((s: string) => string) => TOKEN_COLOR[sym] ?? c.primary;

    // Sub-cent amounts ($0.005 floor) are dust. Showing 6-decimal values for
    // 0.000032 SOL is confusing — it implies meaningful state when the amount
    // is worthless. Hide as a single dim em dash; the raw value is still in
    // the structured `data` payload for any caller that wants the precise
    // number.
    const DUST_USD = 0.005;
    const fmtCell = (
      tokenAmount: number,
      symbol: string,
      decimals: number,
      isStable: boolean,
    ): string => {
      if (!Number.isFinite(tokenAmount) || tokenAmount === 0) {
        return c.faint('—');
      }
      // Stable: token amount IS the USD value.
      if (isStable) {
        if (tokenAmount < DUST_USD) return c.faint('—');
        return c.primary.bold(`$${tokenAmount.toFixed(2)}`);
      }
      // Non-stable: show raw token amount + USD in muted parens.
      const px = priceBySymbol.get(symbol) ?? 0;
      const usd = tokenAmount * px;
      if (usd > 0 && usd < DUST_USD) return c.faint('—');
      const tokenDecimals = decimals === 6 ? 4 : 6;
      const tokenStr = tokenAmount.toFixed(tokenDecimals);
      const usdStr = px > 0 ? `  ${c.muted(`$${usd.toFixed(2)}`)}` : '';
      return c.primary.bold(tokenStr) + usdStr;
    };

    // Column widths: vlen-aware via `pad` so ANSI codes don't break alignment.
    const COL_TOKEN = 12;
    const COL_FLASH = 28;
    const COL_WALLET = 28;

    let totalFlashUsd = 0;
    let totalWalletUsd = 0;

    const tableLines: string[] = [];
    tableLines.push(
      pad(c.muted('Token'), COL_TOKEN) +
      pad(c.muted('Flash Account'), COL_FLASH) +
      c.muted('Wallet'),
    );
    tableLines.push(c.faint('─'.repeat(COL_TOKEN + COL_FLASH + COL_WALLET)));
    for (const sym of sorted) {
      const cust = client.poolConfig.custodies.find((cu) => cu.symbol === sym)!;
      const isStable = !!cust.isStable;
      const decimals = cust.decimals;
      const bal = basket.get(sym);
      const flashAvail = bal?.debits ?? 0;
      const flashPending = bal?.pendingCredits ?? 0;
      const wallet = walletBySymbol.get(sym) ?? 0;

      // USD aggregation for the totals line (skip dust).
      if (Number.isFinite(flashAvail) && flashAvail > 0) {
        const usd = isStable ? flashAvail : flashAvail * (priceBySymbol.get(sym) ?? 0);
        if (usd >= DUST_USD) totalFlashUsd += usd;
      }
      if (Number.isFinite(wallet) && wallet > 0) {
        const usd = isStable ? wallet : wallet * (priceBySymbol.get(sym) ?? 0);
        if (usd >= DUST_USD) totalWalletUsd += usd;
      }

      const dot = colorFor(sym)('●');
      const flashCell = fmtCell(flashAvail, sym, decimals, isStable);
      const flashWithPending = flashPending > 0.0000001
        ? `${flashCell}  ${c.muted(`+${formatPendingAmount(flashPending, decimals)} pending`)}`
        : flashCell;
      tableLines.push(
        pad(`${dot}  ${colorFor(sym).bind(null)(sym)}`, COL_TOKEN) +
        pad(flashWithPending, COL_FLASH) +
        fmtCell(wallet, sym, decimals, isStable),
      );
    }

    void totalFlashUsd; void totalWalletUsd; // retained for potential future use

    // Accent-bar panel — table lines sit directly after the bar (no 14-char
    // label gutter that renderCard forces on empty-label rows), matching the
    // dashboard / history panels.
    const lines = panelHeader('Account', `${DIAMOND}  ${c.muted(`V2 mode · ${client.poolConfig.poolName}`)}`);
    for (const t of tableLines) lines.push(panelRow(t));
    lines.push(`  ${panelBar()}`);
    lines.push(panelRow(`${c.long('⇣')}  ${c.long('deposit')}  ${c.muted('<token> <amount>')}     ${c.faint('wallet → Flash Account')}`));
    lines.push(panelRow(`${c.short('⇡')}  ${c.short('withdraw')} ${c.muted('<token> <amount>')}     ${c.faint('Flash Account → wallet')}`));
    lines.push('');

    return {
      success: true,
      message: lines.join('\n'),
      data: {
        flashAccount: Object.fromEntries(basket),
        wallet: Object.fromEntries(walletBySymbol),
        prices: Object.fromEntries(priceBySymbol),
        totalFlashUsd,
        totalWalletUsd,
      },
    };
  },
};

export const magicReverse: ToolDefinition = {
  name: 'magicReverse',
  description: 'Close current position and open opposite side. args: market, side; leverage defaults to the existing position. Collateral carries over automatically (the API has no collateral input for reverse).',
  parameters: z.object({
    market: z.string(),
    side: z.enum(['long', 'short']),
    leverage: z.number().positive().optional(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildFlashV2Client(context);
    const owner = ownerKeypair(context).publicKey.toBase58();

    let leverage = params.leverage as number | undefined;
    const target = String(params.market).toUpperCase();
    const targetSide = v2UiSide(String(params.side));

    // Always read the existing position: reverse REQUIRES one, we need it to
    // derive leverage when omitted, and to show the collateral that actually
    // carries over. The reversePosition builder reuses the freed collateral —
    // there is no collateral input to the API — so we never accept or invent one.
    let positions = await v2Positions(client, owner);
    let existing = positions.find((p) => p.market === target && p.side === targetSide);
    // Only retry when the basket was empty — that's the ER-replication race.
    if (!existing && positions.length === 0) {
      await new Promise((r) => setTimeout(r, 500));
      positions = await v2Positions(client, owner);
      existing = positions.find((p) => p.market === target && p.side === targetSide);
    }
    if (!existing) {
      const summary = positions.length === 0
        ? 'basket appears empty (ER may be lagging — try again in a moment)'
        : `basket has ${positions.length}: ${positions.map((p) => `${p.market}/${p.side}`).join(', ')}`;
      return {
        success: false,
        message: `No open ${params.side} position on ${target} to reverse. ${summary}.`,
      };
    }
    // Guard against div-by-zero. A position with collateralUsd=0 means the
    // on-chain state is corrupt or already fully liquidated.
    if (leverage === undefined) {
      if (!Number.isFinite(existing.collateralUsd) || existing.collateralUsd <= 0) {
        return {
          success: false,
          message: `Cannot infer leverage for ${target} ${params.side}: existing position has zero or invalid collateral. Pass leverage explicitly.`,
        };
      }
      leverage = existing.sizeUsd / existing.collateralUsd;
    }
    const inheritedCollateral = existing.collateralUsd;

    const result = await signV2(context, 'reversePosition', {
      owner,
      marketSymbol: String(params.market).toUpperCase(),
      side: v2Side(String(params.side)),
      leverage,
      slippagePercentage: slippageStr(params),
    });
    if ('previewOnly' in result) {
      return { success: true, message: c.muted('  reverse preview only — no transaction returned'), data: { response: result.response } };
    }

    const market = String(params.market).toUpperCase();
    const entry = fieldNumber(result.response, 'newEntryPrice');
    const liqPx = fieldNumber(result.response, 'newLiquidationPrice');
    const liq = liqPx > 0 ? c.warn(`$${liqPx.toFixed(4)}`) : c.muted('—');

    return {
      success: true,
      message: renderCard({
        status: 'Position Reversed',
        tone: 'info',
        // Same shape as open/close cards — `SOL · SHORT · 2x` — so the
        // three trade-card variants visually match. The previous
        // `LONG → SHORT` variant tried to encode the flip in the
        // subtitle but the status line ("Position Reversed") already
        // carries that meaning.
        subtitle: marketHeader(market, String(params.side), leverage),
        columns: 1,
        rows: [
          { label: 'Entry',       value: entry > 0 ? c.primary(`$${entry.toFixed(4)}`) : c.muted('—') },
          { label: 'Liquidation', value: liq },
          { label: 'Size',        value: c.primary(formatUsdExact(fieldNumber(result.response, 'youRecieveUsdUi') || (inheritedCollateral * (leverage ?? 0)))) },
          { label: 'Collateral',  value: `${c.primary(formatUsdExact(inheritedCollateral))} ${c.muted('(carried over)')}` },
          ...builderTxRows(result, context.config.network),
        ],
        url: solscanTx(result.signature, context.config.network),
      }),
      txSignature: result.signature,
    };
  },
};

export const magicPartialClose: ToolDefinition = {
  name: 'magicPartialClose',
  description: 'Close part of a position. args: market, side, sizeUsd OR sizePercent.',
  parameters: z.object({
    market: z.string(),
    side: z.enum(['long', 'short']),
    sizeUsd: z.number().positive().optional(),
    sizePercent: z.number().positive().max(100).optional(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildFlashV2Client(context);
    const owner = ownerKeypair(context).publicKey.toBase58();
    const market = String(params.market).toUpperCase();
    const side = v2UiSide(String(params.side));

    // Resolve size — explicit USD wins; otherwise compute from percent of
    // the existing position's current size.
    let sizeUsd = params.sizeUsd as number | undefined;
    // For the percent path we scale the KNOWN token size directly rather than
    // round-tripping USD→token through the current mark price. `sizeUsdUi` may
    // be entry-notional; a mark-price round-trip would then close the wrong
    // quantity (e.g. 50% of a 1 BTC position closing 0.4545 BTC after a move).
    let tokenSizeUi: string | undefined;
    if (sizeUsd === undefined) {
      const pct = params.sizePercent as number | undefined;
      if (pct === undefined) {
        return { success: false, message: 'Specify either `sizeUsd` or `sizePercent`. e.g. `partial SOL long 5` or `close 50% of SOL long`.' };
      }
      const positions = await v2Positions(client, owner);
      const existing = positions.find(
        (p) => p.market.toUpperCase() === market.toUpperCase() && String(p.side).toLowerCase() === side,
      );
      if (!existing) {
        return { success: false, message: `No open ${side} position on ${market.toUpperCase()} to partial-close.` };
      }
      const tokenSize = (existing.sizeAmountUi * pct) / 100;
      if (!(tokenSize > 0)) return { success: false, message: `Computed close size is zero (position size $${existing.sizeUsd.toFixed(2)}, ${pct}%).` };
      tokenSizeUi = uiAmount(tokenSize);
      sizeUsd = (existing.sizeUsd * pct) / 100; // for the card display only
    }

    const r = await signV2(context, 'decreasePosition', {
      owner,
      marketSymbol: market,
      side: v2Side(side),
      sizeAmountUi: tokenSizeUi ?? await sizeUsdToTokenAmount(client, market, sizeUsd),
      withdrawTokenSymbol: 'USDC',
      slippagePercentage: slippageStr(params),
    });
    if ('previewOnly' in r) {
      return { success: true, message: c.muted('  decrease preview only — no transaction returned'), data: { response: r.response } };
    }
    const sym = market.toUpperCase();
    return {
      success: true,
      message: renderCard({
        status: 'Partial Close',
        tone: 'close',
        // Same subtitle shape as the other trade cards.
        subtitle: marketHeader(sym, side),
        columns: 1,
        rows: [
          { label: 'Closed', value: c.short(`-${formatUsd(sizeUsd)}`) },
          ...builderTxRows(r, context.config.network),
        ],
        url: solscanTx(r.signature, context.config.network),
      }),
      txSignature: r.signature,
    };
  },
};

export const magicCloseAll: ToolDefinition = {
  name: 'magicCloseAll',
  description: 'Close every open position at market.',
  async execute(_params, context): Promise<ToolResult> {
    const client = buildFlashV2Client(context);
    const owner = ownerKeypair(context).publicKey.toBase58();
    const positions = await v2Positions(client, owner);
    if (positions.length === 0) {
      return {
        success: true,
        message: renderCard({
          status: 'Close All',
          tone: 'info',
          subtitle: c.muted('no open positions'),
          columns: 1,
          rows: [{ label: '', value: c.muted('Nothing to close.') }],
        }),
      };
    }
    const results: { market: string; side: string; ok: boolean; sig?: string; reason?: string }[] = [];
    for (const p of positions) {
      try {
        const r = await signV2(context, 'closePosition', {
          owner,
          marketSymbol: p.market,
          side: v2Side(p.side),
          inputUsdUi: uiAmount(p.sizeUsd),
          withdrawTokenSymbol: 'USDC',
          slippagePercentage: slippageStr({}), // close-all takes no per-call slippage; use default
          closeAll: true,
        });
        results.push({ market: p.market, side: p.side, ok: !('previewOnly' in r), sig: 'previewOnly' in r ? undefined : r.signature });
      } catch (err) {
        results.push({ market: p.market, side: p.side, ok: false, reason: getErrorMessage(err) });
      }
    }
    const ok = results.filter((r) => r.ok).length;
    const failed = results.length - ok;
    const rows = results.map((r) => {
      const sideColor = r.side === 'long' ? c.long : c.short;
      const status = r.ok ? c.long('✔ closed') : c.short(`✖ ${r.reason ?? 'failed'}`);
      return {
        label: `${c.primary.bold(r.market.padEnd(7))} ${sideColor.bold(r.side.toUpperCase())}`,
        value: status,
      };
    });
    return {
      success: failed === 0,
      message: renderCard({
        status: failed === 0 ? 'All Closed' : 'Close All Partial',
        tone: failed === 0 ? 'close' : 'warn',
        subtitle: `${DIAMOND}  ${c.muted(`${ok}/${results.length} closed${failed ? ` · ${failed} failed` : ''}`)}`,
        columns: 1,
        rows,
      }),
      data: { results },
    };
  },
};

export const magicIncrease: ToolDefinition = {
  name: 'magicIncrease',
  description: 'Add to position size. args: market, side, sizeUsd, addCollateralUsd?.',
  parameters: z.object({
    market: z.string(),
    side: z.enum(['long', 'short']),
    sizeUsd: z.number().positive(),
    addCollateralUsd: z.number().nonnegative().optional(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildFlashV2Client(context);
    const owner = ownerKeypair(context).publicKey.toBase58();
    const sym = String(params.market).toUpperCase();
    const sideStr = v2UiSide(String(params.side));
    const addSize = params.sizeUsd as number;
    const addColl = (params.addCollateralUsd as number | undefined) ?? 0;

    // Pull existing position so we can show the full Existing / Added / New
    // breakdown — same shape the open→increase auto-redirect produces. Bare
    // `increase` used to show only one line which made it hard to verify the
    // resulting size/leverage.
    let existing: PositionLike | undefined;
    try {
      const positions = await v2Positions(client, owner);
      existing = positions.find(
        (p) => p.market.toUpperCase() === sym && String(p.side).toLowerCase() === sideStr,
      );
    } catch { /* fall through — render whatever we have */ }

    const r = await signV2(context, 'increasePosition', {
      owner,
      marketSymbol: sym,
      side: v2Side(sideStr),
      sizeAmountUi: await sizeUsdToTokenAmount(client, sym, addSize),
      collateralAmountUi: uiAmount(addColl),
      collateralTokenSymbol: 'USDC',
      slippagePercentage: slippageStr(params),
    });
    if ('previewOnly' in r) {
      return { success: true, message: c.muted('  increase preview only — no transaction returned'), data: { response: r.response } };
    }

    const rows: Array<{ label: string; value: string }> = [];
    if (existing) {
      rows.push({ label: 'Existing',   value: c.muted(`${formatUsd(existing.sizeUsd)} @ ${existing.leverage.toFixed(2)}x`) });
    }
    rows.push({ label: 'Added size', value: c.long(`+${formatUsd(addSize)}`) });
    if (addColl > 0) {
      rows.push({ label: 'Added coll', value: c.long(`+${formatUsd(addColl)}`) });
    }
    if (existing) {
      const newSize = existing.sizeUsd + addSize;
      const newColl = existing.collateralUsd + addColl;
      const newLev = newColl > 0 ? newSize / newColl : 0;
      rows.push({ label: 'New size',   value: c.primary.bold(formatUsd(newSize)) });
      if (addColl > 0) rows.push({ label: 'New coll',   value: c.primary.bold(formatUsd(newColl)) });
      rows.push({ label: 'New lev',    value: c.primary.bold(`${newLev.toFixed(2)}x`) });
    }
    rows.push(...builderTxRows(r, context.config.network));

    return {
      success: true,
      message: renderCard({
        status: 'Position Increased',
        tone: 'open',
        subtitle: marketHeader(sym, sideStr),
        columns: 1,
        rows,
        url: solscanTx(r.signature, context.config.network),
      }),
      txSignature: r.signature,
    };
  },
};

export const magicPlaceLimit: ToolDefinition = {
  name: 'magicPlaceLimit',
  description: 'Place a limit order. args: market, side, limitPrice, collateral, leverage, tp?, sl?',
  parameters: z.object({
    market: z.string(),
    side: z.enum(['long', 'short']),
    limitPrice: z.number().positive(),
    collateral: z.number().positive(),
    leverage: z.number().positive(),
    tp: z.number().positive().optional(),
    sl: z.number().positive().optional(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const market = String(params.market).toUpperCase();
    const sideStr = String(params.side);
    const lev = params.leverage as number;
    const r = await signV2(context, 'openPosition', {
      owner: ownerKeypair(context).publicKey.toBase58(),
      inputTokenSymbol: 'USDC',
      outputTokenSymbol: market,
      inputAmountUi: uiAmount(params.collateral as number),
      leverage: lev,
      tradeType: v2Side(sideStr),
      orderType: 'LIMIT',
      limitPrice: uiAmount(params.limitPrice as number),
      ...(params.tp ? { takeProfit: uiAmount(params.tp as number) } : {}),
      ...(params.sl ? { stopLoss: uiAmount(params.sl as number) } : {}),
    });
    if ('previewOnly' in r) {
      return { success: true, message: c.muted('  limit preview only — no transaction returned'), data: { response: r.response } };
    }
    const subtitle = marketHeader(market, sideStr, lev);

    const rows: Array<{ label: string; value: string }> = [
      { label: 'Limit Price',  value: c.primary(formatPrice(params.limitPrice as number)) },
      { label: 'Collateral',   value: c.primary(formatUsd(params.collateral as number)) },
      { label: 'Size',         value: c.primary(formatUsd((params.collateral as number) * lev)) },
    ];
    if (params.tp) rows.push({ label: 'Take Profit',  value: c.long(formatPrice(params.tp as number)) });
    if (params.sl) rows.push({ label: 'Stop Loss',    value: c.short(formatPrice(params.sl as number)) });
    rows.push(...builderTxRows(r, context.config.network));

    return {
      success: true,
      message: renderCard({
        status: 'Limit Order Placed',
        tone: 'open',
        subtitle,
        columns: 1,
        rows,
        url: solscanTx(r.signature, context.config.network),
      }),
      txSignature: r.signature,
    };
  },
};

/**
 * Last `orders` listing — cached so the user can `cancel <N>` by global index
 * without re-typing market/side/orderId. Repopulated every time `orders` runs.
 */
interface CachedOrder {
  market: string;
  side: 'long' | 'short';
  kind: 'LIMIT' | 'TP' | 'SL';
  price: number;
  size: number;
  /** Per-kind order index on the program's basket slot (NOT the display index). */
  orderId: number;
}
let lastListedOrders: CachedOrder[] = [];

export const magicOrders: ToolDefinition = {
  name: 'magicOrders',
  description: 'Show open limit orders + take-profit / stop-loss triggers across all markets.',
  parameters: z.object({ owner: z.string().optional() }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildFlashV2Client(context);
    const owner = (params.owner as string | undefined) ?? ownerKeypair(context).publicKey.toBase58();
    const orderMetrics = await client.orders(owner);
    const items: { market: string; side: 'long' | 'short'; kind: 'LIMIT' | 'TP' | 'SL'; price: number; size: number; orderId: number; tp?: number; sl?: number }[] = [];

    for (const bundle of records(orderMetrics)) {
      const market = fieldString(bundle, 'marketSymbol').toUpperCase();
      const side = v2UiSide(fieldString(bundle, 'sideUi'));
      for (const o of Array.isArray(bundle.limitOrders) ? bundle.limitOrders as Record<string, unknown>[] : []) {
        const price = fieldNumber(o, 'entryPriceUi');
        if (price <= 0) continue;
        items.push({
          market,
          side,
          kind: 'LIMIT',
          price,
          size: fieldNumber(o, 'sizeUsdUi'),
          orderId: fieldNumber(o, 'orderId'),
          tp: fieldNumber(o, 'limitTakeProfitPriceUi') || undefined,
          sl: fieldNumber(o, 'limitStopLossPriceUi') || undefined,
        });
      }
      for (const o of Array.isArray(bundle.takeProfitOrders) ? bundle.takeProfitOrders as Record<string, unknown>[] : []) {
        const price = fieldNumber(o, 'triggerPriceUi');
        if (price <= 0) continue;
        items.push({ market, side, kind: 'TP', price, size: fieldNumber(o, 'sizeUsdUi'), orderId: fieldNumber(o, 'orderId') });
      }
      for (const o of Array.isArray(bundle.stopLossOrders) ? bundle.stopLossOrders as Record<string, unknown>[] : []) {
        const price = fieldNumber(o, 'triggerPriceUi');
        if (price <= 0) continue;
        items.push({ market, side, kind: 'SL', price, size: fieldNumber(o, 'sizeUsdUi'), orderId: fieldNumber(o, 'orderId') });
      }
    }

    if (items.length === 0) {
      lastListedOrders = [];
      return {
        success: true,
        message: renderCard({
          status: 'Orders',
          tone: 'info',
          subtitle: c.muted('no open orders'),
          columns: 1,
          rows: [{ label: '', value: c.muted('Place one with: limit SOL long 80 50 2 set tp 100 sl 70') }],
        }),
      };
    }

    items.sort((a, b) => a.market.localeCompare(b.market) || a.kind.localeCompare(b.kind) || a.orderId - b.orderId);
    // Cache the GLOBAL-display order so `cancel <N>` resolves N to the right item.
    lastListedOrders = items.map((o) => ({ market: o.market, side: o.side, kind: o.kind, price: o.price, size: o.size, orderId: o.orderId }));

    const rows = items.map((o, displayIdx) => {
      const sideColor = o.side === 'long' ? c.long : c.short;
      const kindColor = o.kind === 'LIMIT' ? c.cyan : o.kind === 'TP' ? c.long : c.short;
      const meta = [
        `${c.muted('size')} ${c.primary(formatUsd(o.size))}`,
        ...(o.tp ? [`${c.muted('tp')} ${c.long(`$${o.tp.toFixed(4)}`)}`] : []),
        ...(o.sl ? [`${c.muted('sl')} ${c.short(`$${o.sl.toFixed(4)}`)}`] : []),
      ].join('  ');
      return {
        label: `${c.cyan.bold(String(displayIdx).padStart(2))}  ${o.market}`,
        value: `${kindColor.bold(o.kind.padEnd(5))} ${sideColor.bold(o.side.toUpperCase().padEnd(5))} ${c.muted('@')} ${c.primary(`$${o.price.toFixed(4)}`)}  ${meta}`,
      };
    });

    return {
      success: true,
      message: renderCard({
        status: 'Orders',
        tone: 'info',
        subtitle: `${DIAMOND}  ${c.muted(`${items.length} open`)} ${DOT} ${c.muted('cancel <N> · cancel all')}`,
        columns: 1,
        rows,
      }),
      data: { orders: items },
    };
  },
};

// ─── Cancel by index ────────────────────────────────────────────────────────

/**
 * `cancel <N>` / `cancel all` — removes orders from the basket using the
 * indices shown by the most recent `orders` listing. No need to re-type
 * market / side / orderId. Bundles multiple cancels into a single ER tx.
 */
export const magicCancel: ToolDefinition = {
  name: 'magicCancel',
  description: 'Cancel an order by display index (from `orders`). Use `cancel all` to clear every open order.',
  parameters: z.object({
    target: z.union([z.string(), z.number()]).optional(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const target = params.target;
    if (target === undefined) {
      return {
        success: false,
        message: 'Run `orders` first, then `cancel <N>` (where N is the index shown), or `cancel all`.',
      };
    }
    if (lastListedOrders.length === 0) {
      return { success: false, message: 'No cached order list. Run `orders` first to see indices.' };
    }

    // Resolve target → indices into lastListedOrders
    let indices: number[];
    const tStr = String(target).toLowerCase().trim();
    if (tStr === 'all' || tStr === '*') {
      indices = lastListedOrders.map((_, i) => i);
    } else if (/^\d+$/.test(tStr)) {
      const n = parseInt(tStr, 10);
      if (n < 0 || n >= lastListedOrders.length) {
        return {
          success: false,
          message: `Index ${n} out of range — last \`orders\` showed ${lastListedOrders.length} items (0..${lastListedOrders.length - 1}).`,
        };
      }
      indices = [n];
    } else if (/^\d+\s*(?:\.\.|-|to|,)\s*\d+$/i.test(tStr)) {
      // Range: `0..4`, `0-4`, `0 to 4`, `0,4`
      const [a, b] = tStr.split(/\.\.|-|to|,/i).map((s) => parseInt(s.trim(), 10));
      const lo = Math.min(a, b), hi = Math.max(a, b);
      indices = [];
      for (let i = lo; i <= hi && i < lastListedOrders.length; i++) indices.push(i);
    } else {
      return {
        success: false,
        message: `Couldn't parse \`${target}\`. Use \`cancel <N>\`, \`cancel all\`, or \`cancel 0..4\`.`,
      };
    }

    const owner = ownerKeypair(context).publicKey.toBase58();
    const results: { idx: number; ok: boolean; reason?: string; sig?: string }[] = [];
    for (const i of indices) {
      const o = lastListedOrders[i];
      try {
        let r: FlashV2BuilderResult;
        if (o.kind === 'LIMIT') {
          r = await signV2(context, 'cancelLimitOrder', {
            owner,
            marketSymbol: o.market,
            side: v2Side(o.side),
            orderId: o.orderId,
          });
        } else {
          r = await signV2(context, 'cancelTriggerOrder', {
            owner,
            marketSymbol: o.market,
            side: v2Side(o.side),
            orderId: o.orderId,
            isStopLoss: o.kind === 'SL',
          });
        }
        results.push({ idx: i, ok: !('previewOnly' in r), sig: 'previewOnly' in r ? undefined : r.signature });
      } catch (err) {
        results.push({ idx: i, ok: false, reason: getErrorMessage(err) });
      }
    }

    const ok = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    const rows = results.map((r) => {
      const o = lastListedOrders[r.idx];
      const status = r.ok ? c.long('✔ cancelled') : c.short(`✖ ${r.reason ?? 'failed'}`);
      const desc = `${o.kind.padEnd(5)} ${o.side.toUpperCase().padEnd(5)} ${o.market}  @ $${o.price.toFixed(4)}`;
      return { label: `${c.cyan.bold(String(r.idx).padStart(2))}  ${desc}`, value: status };
    });
    // Invalidate cache so the next cancel needs a fresh `orders` (indices shifted).
    lastListedOrders = [];

    return {
      success: failed.length === 0,
      message: renderCard({
        status: failed.length === 0 ? 'Orders Cancelled' : 'Cancel Partial',
        tone: failed.length === 0 ? 'close' : 'warn',
        subtitle: `${DIAMOND}  ${c.muted(`${ok}/${results.length} cancelled${failed.length ? ` · ${failed.length} failed` : ''}`)}`,
        columns: 1,
        rows,
      }),
      data: { results },
    };
  },
};


export const magicCancelLimit: ToolDefinition = {
  name: 'magicCancelLimit',
  description: 'Cancel a limit order. args: market, side, orderId.',
  parameters: z.object({
    market: z.string(),
    side: z.enum(['long', 'short']),
    orderId: z.number().int().nonnegative(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const r = await signV2(context, 'cancelLimitOrder', {
      owner: ownerKeypair(context).publicKey.toBase58(),
      marketSymbol: String(params.market).toUpperCase(),
      side: v2Side(String(params.side)),
      orderId: params.orderId as number,
    });
    if ('previewOnly' in r) {
      return { success: true, message: c.muted('  cancel-limit preview only — no transaction returned'), data: { response: r.response } };
    }
    const sym = String(params.market).toUpperCase();
    const sideStr = String(params.side).toLowerCase();
    return {
      success: true,
      message: renderCard({
        status: 'Limit Cancelled',
        tone: 'warn',
        // Same header style as the other 6 trade verbs — ensures
        // visual parity across the lifecycle (limit → cancel-limit
        // both share the same first row).
        subtitle: `${marketHeader(sym, sideStr)}  ${c.muted(`#${params.orderId}`)}`,
        columns: 1,
        rows: [
          { label: 'Order #', value: c.primary(String(params.orderId)) },
          ...builderTxRows(r, context.config.network),
        ],
        url: solscanTx(r.signature, context.config.network),
      }),
      txSignature: r.signature,
    };
  },
};

export const magicCancelTrigger: ToolDefinition = {
  name: 'magicCancelTrigger',
  description: 'Cancel a TP or SL trigger order. args: market, isStopLoss, orderId? (auto-resolved from basket if omitted).',
  parameters: z.object({
    market: z.string(),
    // Optional — when omitted, we read the basket and find the first matching trigger.
    orderId: z.number().int().nonnegative().optional(),
    isStopLoss: z.boolean(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildFlashV2Client(context);
    const owner = ownerKeypair(context).publicKey.toBase58();
    const market = String(params.market).toUpperCase();
    let orderId = params.orderId as number | undefined;
    let side: 'long' | 'short' | undefined;

    // Auto-resolve orderId by reading the basket. Picks the first non-empty
    // matching (TP or SL) slot for this market across both sides.
    if (orderId === undefined) {
      const orderMetrics = await client.orders(owner);
      for (const bundle of records(orderMetrics)) {
        if (fieldString(bundle, 'marketSymbol').toUpperCase() !== market) continue;
        const arr = (params.isStopLoss as boolean) ? bundle.stopLossOrders : bundle.takeProfitOrders;
        if (!Array.isArray(arr)) continue;
        const first = arr.find((o): o is Record<string, unknown> => typeof o === 'object' && o !== null && fieldNumber(o as Record<string, unknown>, 'triggerPriceUi') > 0);
        if (first) {
          orderId = fieldNumber(first, 'orderId');
          side = v2UiSide(fieldString(bundle, 'sideUi'));
          break;
        }
      }
      if (orderId === undefined) {
        const label = (params.isStopLoss as boolean) ? 'stop-loss' : 'take-profit';
        return { success: false, message: `No active ${label} trigger on ${market} to cancel.` };
      }
    }
    if (!side) {
      const orderMetrics = await client.orders(owner);
      const bundle = records(orderMetrics).find((o) => fieldString(o, 'marketSymbol').toUpperCase() === market);
      side = bundle ? v2UiSide(fieldString(bundle, 'sideUi')) : 'long';
    }

    const r = await signV2(context, 'cancelTriggerOrder', {
      owner,
      marketSymbol: market,
      side: v2Side(side),
      orderId,
      isStopLoss: params.isStopLoss as boolean,
    });
    if ('previewOnly' in r) {
      return { success: true, message: c.muted('  cancel-trigger preview only — no transaction returned'), data: { response: r.response } };
    }
    const label = params.isStopLoss ? 'Stop Loss' : 'Take Profit';
    return {
      success: true,
      message: renderCard({
        status: `${label} Cancelled`,
        tone: 'warn',
        subtitle: `${c.primary.bold(market)}  ${c.muted(`#${orderId}`)}`,
        columns: 1,
        rows: [
          { label: 'Trigger', value: c.primary(label) },
          { label: 'Order #', value: c.primary(String(orderId)) },
          ...builderTxRows(r, context.config.network),
        ],
        url: solscanTx(r.signature, context.config.network),
      }),
      txSignature: r.signature,
    };
  },
};

export const magicLiquidate: ToolDefinition = {
  name: 'magicLiquidate',
  description: 'Liquidate an underwater position. args: positionOwner (pubkey), market, side.',
  parameters: z.object({
    positionOwner: z.string(),
    market: z.string(),
    side: z.enum(['long', 'short']),
  }),
  async execute(params, context): Promise<ToolResult> {
    void context;
    const sym = String(params.market).toUpperCase();
    const sideStr = String(params.side).toLowerCase();
    const sideStrUpper = String(params.side).toUpperCase();
    const sideColor = params.side === 'long' ? c.long : c.short;
    const owner = String(params.positionOwner);
    return {
      success: false,
      message: renderCard({
        status: 'Liquidation Unsupported',
        tone: 'warn',
        // Same header style as the other 6 trade verbs.
        subtitle: marketHeader(sym, sideStr),
        columns: 1,
        rows: [
          { label: 'Owner',  value: c.primary(`${owner.slice(0, 8)}…${owner.slice(-4)}`) },
          { label: 'Market', value: c.primary(sym) },
          { label: 'Side',   value: sideColor.bold(sideStrUpper) },
          { label: 'Reason', value: c.muted('not exposed by the verified Flash V2 Builder API') },
        ],
      }),
    };
  },
};

export const magicTriggerOrder: ToolDefinition = {
  name: 'magicTriggerOrder',
  description: 'Place TP or SL on a position. args: market, side?, price, isStopLoss, sizeUsd?',
  parameters: z.object({
    market: z.string(),
    // Side optional — auto-detected from open positions if omitted.
    side: z.enum(['long', 'short']).optional(),
    price: z.number().positive(),
    isStopLoss: z.boolean(),
    sizeUsd: z.number().positive().optional(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildFlashV2Client(context);
    const owner = ownerKeypair(context).publicKey.toBase58();
    const market = String(params.market).toUpperCase();
    let side = params.side ? v2UiSide(String(params.side)) : undefined;
    let sizeAmountUi: string | undefined;
    if (!side) {
      const positions = await v2Positions(client, owner);
      const matches = positions.filter((p) => p.market.toUpperCase() === market);
      if (matches.length === 0) {
        return { success: false, message: `No open position on ${market} — specify a side: ${params.isStopLoss ? 'sl' : 'tp'} ${market} long ${params.price} or ${params.isStopLoss ? 'sl' : 'tp'} ${market} short ${params.price}` };
      }
      if (matches.length > 1) {
        return { success: false, message: `Both long AND short open on ${market} — specify which: ${params.isStopLoss ? 'sl' : 'tp'} ${market} long ${params.price} or ${params.isStopLoss ? 'sl' : 'tp'} ${market} short ${params.price}` };
      }
      side = matches[0].side;
      sizeAmountUi = uiAmount(matches[0].sizeAmountUi);
    }
    if (!sizeAmountUi) {
      if (params.sizeUsd) sizeAmountUi = await sizeUsdToTokenAmount(client, market, params.sizeUsd as number);
      else {
        const existing = (await v2Positions(client, owner)).find((p) => p.market === market && p.side === side);
        if (!existing) return { success: false, message: `No open ${side} position on ${market} to size the trigger.` };
        sizeAmountUi = uiAmount(existing.sizeAmountUi);
      }
    }
    const r = await signV2(context, 'placeTriggerOrder', {
      owner,
      marketSymbol: market,
      side: v2Side(side),
      triggerPriceUi: uiAmount(params.price as number),
      sizeAmountUi,
      isStopLoss: params.isStopLoss as boolean,
    });
    if ('previewOnly' in r) {
      return { success: true, message: c.muted('  trigger preview only — no transaction returned'), data: { response: r.response } };
    }
    const label = params.isStopLoss ? 'Stop Loss' : 'Take Profit';
    const sideStr = String(side);
    return {
      success: true,
      message: renderCard({
        status: `${label} Set`,
        // Both TP and SL are SUCCESSFUL placements of a defensive
        // order — same positive tone for both. The earlier asymmetry
        // (TP=open / SL=warn) implied SL placement was a problem,
        // when in fact placing an SL is the safer action of the two.
        tone: 'open',
        subtitle: marketHeader(market, sideStr),
        columns: 1,
        rows: [
          { label: 'Trigger', value: c.primary(formatPrice(params.price as number)) },
          { label: 'Size at trigger', value: params.sizeUsd
            ? c.primary(formatUsd(params.sizeUsd as number))
            : c.muted('full position') },
          ...builderTxRows(r, context.config.network),
        ],
        url: solscanTx(r.signature, context.config.network),
      }),
      txSignature: r.signature,
    };
  },
};

/**
 * Attach BOTH TP and SL to an existing position in one command.
 */
export const magicSetTriggers: ToolDefinition = {
  name: 'magicSetTriggers',
  description: 'Attach take-profit and/or stop-loss to an open position in one command.',
  parameters: z.object({
    market: z.string(),
    side: z.enum(['long', 'short']),
    tp: z.number().positive().optional(),
    sl: z.number().positive().optional(),
  }),
  async execute(params, context): Promise<ToolResult> {
    if (params.tp === undefined && params.sl === undefined) {
      return {
        success: false,
        message: 'Specify at least one of `tp <price>` or `sl <price>`. e.g. `set SOL long tp 100 sl 70`',
      };
    }
    const client = buildFlashV2Client(context);
    const owner = ownerKeypair(context).publicKey.toBase58();
    const market = String(params.market).toUpperCase();
    const side = v2UiSide(String(params.side));
    const existing = (await v2Positions(client, owner)).find((p) => p.market === market && p.side === side);
    if (!existing) {
      return { success: false, message: `No open ${side} position on ${market} to attach TP/SL.` };
    }
    const result = await signV2(context, 'placeTpSl', {
      owner,
      marketSymbol: market,
      side: v2Side(side),
      sizeAmountUi: uiAmount(existing.sizeAmountUi),
      ...(params.tp ? { takeProfitUi: uiAmount(params.tp as number) } : {}),
      ...(params.sl ? { stopLossUi: uiAmount(params.sl as number) } : {}),
    });
    if ('previewOnly' in result) {
      return { success: true, message: c.muted('  TP/SL preview only — no transaction returned'), data: { response: result.response } };
    }

    const sym = market.toUpperCase();
    const sideStr = String(side);
    const subtitle = marketHeader(sym, sideStr);
    const rows: Array<{ label: string; value: string }> = [];
    // Show the price for each trigger first (kept tight & uniform). Tx URLs
    // go in a footer-style row when there's exactly one — otherwise we
    // collapse to a multi-line "links" block so the card stays readable
    // when both TP and SL fire and produce separate signatures.
    if (params.tp !== undefined) rows.push({ label: c.long.bold('TP'), value: c.primary(`$${(params.tp as number).toFixed(4)}`) });
    if (params.sl !== undefined) rows.push({ label: c.short.bold('SL'), value: c.primary(`$${(params.sl as number).toFixed(4)}`) });
    rows.push(...builderTxRows(result, context.config.network));

    return {
      success: true,
      message: renderCard({
        status: 'Triggers Set',
        tone: 'open',
        subtitle,
        columns: 1,
        rows,
      }),
      txSignature: result.signature,
      data: { response: result.response },
    };
  },
};

/**
 * Drain pendingCredits → deposits on the basket. Run this if `magic verify`
 * shows pendingCredits > 0 — those credits don't count as fully usable until
 * they're settled into the deposit pool.
 */
export const magicSettle: ToolDefinition = {
  name: 'magicSettle',
  description: 'Settle custody for withdrawal recovery. args: symbol? (default: attempt every V2 custody).',
  parameters: z.object({ symbol: z.string().optional() }),
  async execute(params, context): Promise<ToolResult> {
    const symbol = (params.symbol as string | undefined)?.toUpperCase();
    if (symbol) {
      const result = await signV2(context, 'custodySettlement', {
        owner: ownerKeypair(context).publicKey.toBase58(),
        tokenSymbol: symbol,
      });
      if ('previewOnly' in result) {
        return { success: true, message: c.muted('  custody-settlement preview only — no transaction returned'), data: { response: result.response } };
      }
      return {
        success: true,
        message: renderCard({
          status: 'Settled',
          tone: 'close',
          subtitle: `${c.primary.bold(symbol)}`,
          columns: 1,
          rows: [
            { label: 'Symbol', value: c.primary(symbol) },
            ...builderTxRows(result, context.config.network),
          ],
          url: solscanTx(result.signature, context.config.network),
        }),
        txSignature: result.signature,
      };
    }
    const client = buildFlashV2Client(context);
    const poolData = await client.poolData();
    const symbols = new Set<string>();
    for (const pool of isPoolData(poolData)) {
      for (const cu of records(pool.custodyStats)) {
        const sym = fieldString(cu, 'symbol').toUpperCase();
        if (sym) symbols.add(sym);
      }
    }
    const results: { symbol: string; sig?: string; err?: string }[] = [];
    for (const sym of symbols) {
      try {
        const r = await signV2(context, 'custodySettlement', {
          owner: ownerKeypair(context).publicKey.toBase58(),
          tokenSymbol: sym,
        });
        results.push({ symbol: sym, sig: 'previewOnly' in r ? undefined : r.signature });
      } catch (err) {
        results.push({ symbol: sym, err: getErrorMessage(err) });
      }
    }
    if (results.length === 0) {
      return { success: true, message: c.muted('  no V2 custodies found') };
    }
    const okCount = results.filter((r) => !!r.sig).length;
    const failCount = results.length - okCount;
    const rows: Array<{ label: string; value: string }> = [];
    for (const r of results) {
      if (r.sig) {
        rows.push({ label: r.symbol, value: c.muted(solscanTx(r.sig, context.config.network)) });
      } else {
        rows.push({ label: c.short.bold(r.symbol), value: c.short(`✖ ${r.err}`) });
      }
    }
    return {
      success: failCount === 0,
      message: renderCard({
        status: failCount === 0 ? 'Settle Complete' : 'Settle Partial',
        tone: failCount === 0 ? 'close' : 'warn',
        subtitle: `${DIAMOND}  ${c.muted(`${okCount}/${results.length} settled${failCount ? ` · ${failCount} failed` : ''}`)}`,
        columns: 1,
        rows,
      }),
      data: { results },
    };
  },
};

// ─── Accent-bar panel primitives ──────────────────────────────────────────────
// Multi-section views (dashboard / history / alerts) can't fit a single
// renderCard, but they share its visual language: a teal accent bar down the
// left, an uppercase title header, and divider() rules between sections. These
// helpers keep every panel identical to the card idiom used everywhere else.
const PANEL_INNER = 70;
const panelBar = (): string => c.teal('▌');
function panelHeader(title: string, subtitle = ''): string[] {
  const left = c.teal.bold(title.toUpperCase());
  const padN = Math.max(PANEL_INNER - vlen(left) - vlen(subtitle), 2);
  return ['', `  ${panelBar()}  ${left}${' '.repeat(padN)}${subtitle}`, `  ${panelBar()}`];
}
const panelRow = (s: string): string => `  ${panelBar()}  ${s}`;

export const magicHistory: ToolDefinition = {
  name: 'magicHistory',
  description: 'Show recent magic-mode trade history (local journal).',
  parameters: z.object({ limit: z.number().int().positive().optional() }),
  async execute(params, context): Promise<ToolResult> {
    const kp = context.walletManager.getKeypair();
    const wallet = kp?.publicKey.toBase58();
    const limit = (params.limit as number | undefined) ?? 20;
    const entries = readMagicHistory(limit, wallet);
    if (entries.length === 0) {
      return { success: true, message: chalk.dim('  no magic trades recorded yet') };
    }
    // ANSI-safe column widths. Naive `padEnd` adds raw spaces but doesn't
    // account for the visible width of styled cells (sd/sym are colored), so
    // a long symbol pushed all later columns out of alignment. Fix it by
    // computing visible width once and padding each column to the widest
    // cell observed across the rendered set.
    const TIME_W = 22;
    const TYPE_W = 16;
    const symW = Math.max(entries.reduce((m, e) => Math.max(m, (e.market ?? '').length), 4), 6);
    const sdW = 6;
    const detailW = 16;
    const lines = panelHeader('History', c.muted(`${entries.length} trade${entries.length === 1 ? '' : 's'}`));
    // Column header row — muted, same accent-bar prefix as the data rows.
    lines.push(panelRow(c.faint(
      `${pad('Time', TIME_W)}${pad('Type', TYPE_W)}${pad('Market', symW + 1)}${pad('Side', sdW + 1)}${pad('Detail', detailW + 2)}Tx`,
    )));
    for (const e of entries) {
      const t = new Date(e.ts).toLocaleString();
      const symRaw = e.market ?? '';
      const sym = c.primary.bold(pad(symRaw, symW));
      const sdRaw = e.side ?? '';
      const sdColored = e.side === 'short' ? c.short(sdRaw) : e.side === 'long' ? c.long(sdRaw) : sdRaw;
      const sd = sdColored + ' '.repeat(Math.max(sdW - sdRaw.length, 0));
      const detail =
        e.collateralUsd !== undefined
          ? `$${e.collateralUsd}${e.leverage ? ` ${e.leverage}x` : ''}`
          : e.sizeUsd !== undefined
            ? `$${e.sizeUsd}`
            : e.triggerPriceUsd !== undefined
              ? `@ $${e.triggerPriceUsd}`
              : '';
      const detailPadded = pad(detail, detailW);
      const sigShort = isRealSignature(e.txSignature)
        ? `${e.txSignature.slice(0, 8)}…`
        : c.faint('(sentinel)');
      lines.push(panelRow(`${c.muted(pad(t, TIME_W))}${pad(e.type, TYPE_W)}${sym} ${sd} ${detailPadded}  ${c.muted(sigShort)}`));
    }
    lines.push('');
    return { success: true, message: lines.join('\n'), data: { entries } };
  },
};

export const magicDashboard: ToolDefinition = {
  name: 'magicDashboard',
  description: 'At-a-glance: vault, positions, ER health, recent trades.',
  async execute(_params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const v2Client = buildFlashV2Client(context);
    const owner = ownerKeypair(context).publicKey.toBase58();
    const er = startErHealthMonitor(client['erEndpoint'] ?? 'https://flashtrade.magicblock.app/');
    void er; // ensure it's running
    const [balances, positions] = await Promise.all([
      readV2BasketTokenBalances(v2Client, owner),
      v2OwnerPositions(v2Client, owner),
    ]);
    const recent = readMagicHistory(5, context.walletManager.getKeypair()?.publicKey.toBase58());
    const health = getErHealthMonitor()?.snapshot();

    // Vault summary
    let stableUsd = 0;
    for (const b of balances.values()) {
      if (b.isStable) stableUsd += b.debits;
    }

    const lines: string[] = panelHeader('Dashboard', c.muted(`${context.config.network}  ${DOT}  ${client.walletAddress.slice(0, 4)}…${client.walletAddress.slice(-4)}`));
    lines.push(panelRow(`${c.muted(pad('Vault', 14))}${c.primary.bold(formatUsd(stableUsd))} ${c.muted('available')}`));
    lines.push(panelRow(`${c.muted(pad('Wallet', 14))}${c.muted(client.walletAddress.slice(0, 8) + '…')}`));

    // Positions section
    lines.push(divider(`Positions (${positions.length})`));
    if (positions.length === 0) {
      lines.push(panelRow(c.faint('no open positions')));
    }
    for (const p of positions) {
      const pnlColor = p.unrealizedPnl >= 0 ? c.long : c.short;
      const side = p.side === 'short' ? c.short(pad(p.side, 5)) : c.long(pad(p.side, 5));
      lines.push(panelRow(
        `${c.primary.bold(pad(p.market, 8))} ${side} ${c.muted(`${p.leverage.toFixed(1)}x`)}  ${c.muted('size')} ${formatUsd(p.sizeUsd)}  ${c.muted('pnl')} ${pnlColor(formatUsd(p.unrealizedPnl))}`,
      ));
    }

    // ER health section
    lines.push(divider('ER Router'));
    if (health) {
      const dot = health.healthy ? c.long('●') : c.short('●');
      const fails = health.consecutiveFailures > 0 ? c.short(`  ${health.consecutiveFailures} consecutive failures`) : '';
      lines.push(panelRow(`${dot} ${health.healthy ? c.long('healthy') : c.short('degraded')}  ${c.muted(`${health.lastRttMs}ms`)}${fails}`));
    } else {
      lines.push(panelRow(c.faint('probe not started yet')));
    }

    // Recent trades section
    if (recent.length > 0) {
      lines.push(divider('Recent'));
      for (const e of recent) {
        const t = new Date(e.ts).toLocaleTimeString();
        lines.push(panelRow(`${c.muted(pad(t, 12))}${pad(e.type, 14)}${c.primary(e.market ?? '')}`));
      }
    }
    lines.push('');
    return { success: true, message: lines.join('\n'), data: { stableUsd, positions, health } };
  },
};

export const magicErHealth: ToolDefinition = {
  name: 'magicErHealth',
  description: 'Show ER router health (latency, last error, consecutive failures).',
  async execute(_params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const mon = startErHealthMonitor(client['erEndpoint'] ?? 'https://flashtrade.magicblock.app/');
    if (mon.snapshot().lastCheckAt === 0) await new Promise((r) => setTimeout(r, 1500));
    const s = mon.snapshot();

    const dot = s.healthy ? c.long('●') : c.short('●');
    const statusLabel = s.healthy ? c.long('healthy') : c.short('degraded');
    const rttColor = s.lastRttMs < 300 ? c.long : s.lastRttMs < 1000 ? c.warn : c.short;
    const endpoint = s.endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const lastCheck = s.lastCheckAt
      ? new Date(s.lastCheckAt).toLocaleTimeString()
      : c.muted('pending');

    const rows: Array<{ label: string; value: string }> = [
      { label: 'Status',     value: `${dot} ${statusLabel}` },
      { label: 'Endpoint',   value: c.primary(endpoint) },
      { label: 'RTT',        value: `${rttColor(`${s.lastRttMs}ms`)}` },
      { label: 'Last block', value: c.primary(String(s.lastBlockHeight)) },
      { label: 'Last check', value: c.muted(lastCheck) },
    ];
    if (s.lastErr) rows.push({ label: 'Last error', value: c.short(s.lastErr) });
    if (s.consecutiveFailures > 0) {
      rows.push({ label: 'Failures', value: `${c.short(String(s.consecutiveFailures))} ${c.muted('consecutive')}` });
    }

    return {
      success: true,
      message: renderCard({
        status: 'ER Health',
        tone: s.healthy ? 'info' : 'error',
        subtitle: `${DIAMOND}  ${c.muted('MagicBlock router')}`,
        columns: 1,
        rows,
      }),
      data: { ...s } as Record<string, unknown>,
    };
  },
};

export const magicAlerts: ToolDefinition = {
  name: 'magicAlerts',
  description: 'Toggle Telegram/Discord liq-risk alerts. args: action (on|off|status).',
  parameters: z.object({ action: z.enum(['on', 'off', 'status']) }),
  async execute(params, context): Promise<ToolResult> {
    const action = params.action as 'on' | 'off' | 'status';
    if (action === 'status') {
      const mon = getMagicAlerts();
      if (!mon) return { success: true, message: chalk.dim('  alerts: off') };
      const snap = mon.snapshot();
      const lines = panelHeader('Alerts', c.muted(`${snap.length} tracked`));
      lines.push(panelRow(`${c.muted(pad('Outbound', 14))}${mon.hasOutbound() ? c.long('configured') : c.warn('no webhooks set')}`));
      if (snap.length > 0) lines.push(divider('Positions'));
      for (const s of snap) {
        const lvl = s.level === 'CRITICAL' ? c.short(s.level) : s.level === 'WARNING' ? c.warn(s.level) : c.long(s.level);
        lines.push(panelRow(`${c.primary.bold(pad(s.key, 14))} ${pad(lvl, 10)} ${c.muted('dist')} ${(s.lastDistance * 100).toFixed(1)}%`));
      }
      lines.push('');
      return { success: true, message: lines.join('\n') };
    }
    if (action === 'off') {
      stopMagicAlerts();
      return { success: true, message: chalk.dim('  alerts stopped') };
    }
    // action === 'on'
    const client = buildMagicClient(context);
    const mon = startMagicAlerts(client);
    if (!mon.hasOutbound()) {
      return {
        success: true,
        message:
          chalk.yellow('  alerts started, but no webhooks are configured.\n') +
          chalk.dim('  Set MAGIC_ALERTS_TG_BOT_TOKEN + MAGIC_ALERTS_TG_CHAT_ID,\n  and/or MAGIC_ALERTS_DISCORD_WEBHOOK in your .env.'),
      };
    }
    return { success: true, message: chalk.green('  alerts started — webhooks configured. Will fire on WARNING / CRITICAL liq distance.') };
  },
};

/**
 * `magic doctor` — comprehensive health probe. Each check runs independently,
 * captures its latency, and reports per-check OK / WARN / FAIL with a remediation
 * hint. Designed so an npm-installed user can paste the output into a bug
 * report and get a definitive answer.
 *
 * Probes:
 *   1. PoolConfig load
 *   2. RPC manager health
 *   3. ER router health (getBlockHeight)
 *   4. Pyth Hermes reachability
 *   5. Wallet integrity
 *   6. SDK + IDL version sanity
 *   7. Audit log writable
 *   8. Disk: log + history + audit dirs
 *   9. Kill switch state
 *  10. Read-cache hit rate (if active)
 */
export const magicDoctor: ToolDefinition = {
  name: 'magicDoctor',
  description: 'Run a full health probe across RPC, ER, oracle, wallet, SDK, disk.',
  async execute(_params, context): Promise<ToolResult> {
    interface Probe { name: string; status: 'OK' | 'WARN' | 'FAIL'; ms: number; detail: string; hint?: string; }
    const probes: Probe[] = [];
    const time = async <T,>(name: string, fn: () => Promise<T>): Promise<{ ok: T | null; err: Error | null; ms: number }> => {
      const t0 = Date.now();
      try {
        const ok = await fn();
        return { ok, err: null, ms: Date.now() - t0 };
      } catch (err) {
        return { ok: null, err: err instanceof Error ? err : new Error(String(err)) , ms: Date.now() - t0 };
      }
    };

    // 1. PoolConfig
    {
      const r = await time('poolconfig', async () => {
        const { getPoolConfig } = await import('../utils/pool-cache.js');
        const cluster = (context.config.network === 'devnet' ? 'devnet' : 'mainnet-beta');
        const pc = getPoolConfig(context.config.poolName, cluster);
        return { custodies: pc.custodies.length, markets: pc.markets.length };
      });
      if (r.err) probes.push({ name: 'poolconfig', status: 'FAIL', ms: r.ms, detail: getErrorMessage(r.err), hint: 'Check MAGIC_NETWORK + MAGIC_POOL_NAME match a published pool.' });
      else probes.push({ name: 'poolconfig', status: 'OK', ms: r.ms, detail: `${r.ok!.custodies} custodies · ${r.ok!.markets} markets` });
    }

    // 2. RPC manager
    {
      const r = await time('rpc', async () => {
        const { getRpcManager } = await import('../network/rpc-manager.js');
        const mgr = getRpcManager();
        if (!mgr) throw new Error('RpcManager not initialised');
        const active = mgr.activeEndpoint;
        const slot = await mgr.connection.getSlot('confirmed');
        return { url: active.url, label: active.label, slot };
      });
      if (r.err) probes.push({ name: 'rpc', status: 'FAIL', ms: r.ms, detail: getErrorMessage(r.err), hint: 'Try `rpc list` then `rpc test`. Set a paid RPC via `rpc set <url>`.' });
      else {
        const isPublic = /api\.(mainnet-beta|devnet)\.solana\.com/i.test(r.ok!.url);
        const status: 'OK' | 'WARN' = isPublic || r.ms > 1000 ? 'WARN' : 'OK';
        const hint = isPublic
          ? 'Public RPC = aggressive rate limits + slow polls → "block height exceeded" on deposit/withdraw. Get a free Helius/QuickNode/Triton key and run `rpc set <https://...>`.'
          : r.ms > 1000 ? 'RPC is sluggish — consider switching with `rpc set <url>` or `rpc add` a backup.' : undefined;
        probes.push({ name: 'rpc', status, ms: r.ms, detail: `${r.ok!.label} · slot ${r.ok!.slot}`, hint });
      }
    }

    // 3. ER router
    {
      const r = await time('er', async () => {
        const { Connection } = await import('@solana/web3.js');
        const conn = new Connection(context.config.erRpcUrl, 'confirmed');
        const h = await conn.getBlockHeight('confirmed');
        return { url: context.config.erRpcUrl, blockHeight: h };
      });
      if (r.err) probes.push({ name: 'er', status: 'FAIL', ms: r.ms, detail: getErrorMessage(r.err), hint: 'ER router unreachable. Check MAGIC_RPC_URL and your network connection.' });
      else probes.push({ name: 'er', status: r.ms > 800 ? 'WARN' : 'OK', ms: r.ms, detail: `block ${r.ok!.blockHeight}` });
    }

    // 4. Pyth Hermes
    {
      const r = await time('pyth', async () => {
        const res = await fetch('https://hermes.pyth.network/v2/price_feeds?asset_type=crypto', {
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const feeds = await res.json() as unknown[];
        return { count: Array.isArray(feeds) ? feeds.length : 0 };
      });
      if (r.err) probes.push({ name: 'pyth', status: 'WARN', ms: r.ms, detail: getErrorMessage(r.err), hint: 'Pyth Hermes unreachable. Trades work, but 24h-change + market-status checks degrade.' });
      else probes.push({ name: 'pyth', status: 'OK', ms: r.ms, detail: `${r.ok!.count} crypto feeds` });
    }

    // 5. Wallet integrity
    {
      const wm = context.walletManager;
      if (!wm.isConnected) {
        probes.push({ name: 'wallet', status: 'WARN', ms: 0, detail: 'no wallet loaded', hint: 'Run `magic` (interactive) to import a wallet.' });
      } else {
        const ok = wm.verifyKeypairIntegrity();
        probes.push({ name: 'wallet', status: ok ? 'OK' : 'FAIL', ms: 0, detail: ok ? `${wm.address?.slice(0, 4)}…${wm.address?.slice(-4)}` : 'keypair zeroed', hint: ok ? undefined : 'Keypair appears corrupted. Re-load via `wallet use <name>`.' });
      }
    }

    // 6. SDK / IDL
    {
      const r = await time('sdk', async () => {
        const idl = await import('@flash_trade/magic-trade-client/dist/idl/magic_trade.json', { with: { type: 'json' } });
        const pkg = await import('@flash_trade/magic-trade-client/package.json', { with: { type: 'json' } });
        return { errors: ((idl.default as { errors?: unknown[] }).errors ?? []).length, version: (pkg.default as { version?: string }).version };
      });
      if (r.err) probes.push({ name: 'sdk', status: 'FAIL', ms: r.ms, detail: getErrorMessage(r.err), hint: '`npm install` may be incomplete. Re-run install.' });
      else probes.push({ name: 'sdk', status: 'OK', ms: r.ms, detail: `magic-trade-client v${r.ok!.version} · ${r.ok!.errors} IDL errors mapped` });
    }

    // 7. Audit log
    {
      const r = await time('audit-log', async () => {
        const { homedir } = await import('os');
        const { existsSync, accessSync, constants } = await import('fs');
        const { join } = await import('path');
        const path = join(homedir(), '.magic', 'signing-audit.log');
        if (!existsSync(path)) return { exists: false, writable: true, path };
        accessSync(path, constants.W_OK);
        return { exists: true, writable: true, path };
      });
      if (r.err) probes.push({ name: 'audit-log', status: 'FAIL', ms: r.ms, detail: getErrorMessage(r.err), hint: 'Audit log not writable. Check ~/.magic/ permissions (chmod 700).' });
      else probes.push({ name: 'audit-log', status: 'OK', ms: r.ms, detail: r.ok!.exists ? r.ok!.path : `${r.ok!.path} (will be created on first sign)` });
    }

    // 8. Kill switch
    {
      const { killSwitchState } = await import('../security/kill-switch.js');
      const state = killSwitchState();
      if (state.active) {
        probes.push({ name: 'kill-switch', status: 'WARN', ms: 0, detail: `ACTIVE${state.reason ? ` — ${state.reason}` : ''}`, hint: 'Run `resume` to re-enable signing.' });
      } else {
        probes.push({ name: 'kill-switch', status: 'OK', ms: 0, detail: 'inactive (signing enabled)' });
      }
    }

    // 9. Read cache (if a client is built)
    try {
      const client = buildMagicClient(context);
      const stats = client.reads.stats();
      const detail = `${stats.size}/${stats.maxEntries} entries · ${stats.hits} hits · ${stats.misses} misses · ${stats.coalesced} coalesced · ${(stats.hitRate * 100).toFixed(0)}% hit rate`;
      probes.push({ name: 'read-cache', status: 'OK', ms: 0, detail });
    } catch {
      probes.push({ name: 'read-cache', status: 'WARN', ms: 0, detail: 'no client built yet (open something first)' });
    }

    // ── Render ──
    const failed = probes.filter((p) => p.status === 'FAIL').length;
    const warned = probes.filter((p) => p.status === 'WARN').length;
    const lines: string[] = [];
    lines.push('');
    lines.push(`  ${c.teal.bold('Doctor')}  ${c.muted('— full system health probe')}`);
    lines.push(c.faint('  ' + '─'.repeat(72)));
    for (const p of probes) {
      const tag = p.status === 'OK' ? c.long('  ✔ ') : p.status === 'WARN' ? c.warn('  ⚠ ') : c.short('  ✖ ');
      const time = p.ms > 0 ? c.faint(`${String(p.ms).padStart(4)}ms`) : c.faint('     ');
      lines.push(`${tag}${time}  ${c.muted(p.name.padEnd(14))}${p.detail}`);
      if (p.hint) lines.push(`              ${c.muted('hint:')} ${c.cyan(p.hint)}`);
    }
    lines.push(c.faint('  ' + '─'.repeat(72)));
    const summary = failed > 0
      ? c.short(`  ${failed} failing`)
      : warned > 0
      ? c.warn(`  ${warned} warning${warned === 1 ? '' : 's'}`)
      : c.long('  all systems nominal');
    lines.push(summary);
    lines.push('');
    return {
      success: failed === 0,
      message: lines.join('\n'),
      data: { probes, failed, warned },
    };
  },
};

/**
 * `magic perf` — per-op latency overview + cache hit rate. Used to validate
 * the "faster than the official UI" promise: shows the user exactly how
 * many ms went into RPC vs SDK vs cache hit on their last few commands.
 */
export const magicPerf: ToolDefinition = {
  name: 'magicPerf',
  description: 'Show read-cache + RPC latency telemetry.',
  async execute(_params, context): Promise<ToolResult> {
    let cacheStats: ReturnType<MagicTradeClient['reads']['stats']> | null = null;
    try {
      const client = buildMagicClient(context);
      cacheStats = client.reads.stats();
    } catch { /* no client yet */ }

    let rpcStats: { active: { url: string; label: string; latencyMs: number; slot: number; lag: number }; total: number } | null = null;
    try {
      const { getRpcManager } = await import('../network/rpc-manager.js');
      const mgr = getRpcManager();
      if (mgr) {
        const active = mgr.activeEndpoint;
        rpcStats = {
          active: {
            url: active.url,
            label: active.label,
            latencyMs: mgr.getEndpointLatency(active.url),
            slot: mgr.getEndpointSlot(active.url),
            lag: mgr.getSlotLag(active.url),
          },
          total: mgr.totalEndpoints,
        };
      }
    } catch { /* fall through */ }

    const lines: string[] = [];
    lines.push('');
    lines.push(`  ${c.teal.bold('Perf')}  ${c.muted('— latency + cache telemetry')}`);
    lines.push(c.faint('  ' + '─'.repeat(60)));

    if (cacheStats) {
      const hitColor = cacheStats.hitRate > 0.5 ? c.long : cacheStats.hitRate > 0.2 ? c.warn : c.muted;
      lines.push(`  ${c.muted('cache')}        ${cacheStats.size}/${cacheStats.maxEntries} entries · TTL ${cacheStats.ttlMs}ms`);
      lines.push(`  ${c.muted('  hits')}       ${c.primary(String(cacheStats.hits))}`);
      lines.push(`  ${c.muted('  misses')}     ${c.primary(String(cacheStats.misses))}`);
      lines.push(`  ${c.muted('  coalesced')}  ${c.primary(String(cacheStats.coalesced))}`);
      lines.push(`  ${c.muted('  hit rate')}   ${hitColor((cacheStats.hitRate * 100).toFixed(1) + '%')}`);
    } else {
      lines.push(`  ${c.muted('cache')}        ${c.faint('not initialised yet — run a read first')}`);
    }
    lines.push('');
    if (rpcStats?.active) {
      const a = rpcStats.active;
      const latStr = a.latencyMs >= 0 ? `${a.latencyMs}ms` : '—';
      const lat = a.latencyMs > 800 ? c.short : a.latencyMs > 300 ? c.warn : a.latencyMs >= 0 ? c.long : c.muted;
      lines.push(`  ${c.muted('rpc')}          ${a.label}  ${lat(latStr)}  ${c.muted('slot')} ${a.slot >= 0 ? a.slot : '—'}${a.lag > 0 ? c.warn(' (-' + a.lag + ' lag)') : ''}`);
      if (rpcStats.total > 1) {
        lines.push(`  ${c.muted('  backups')}    ${rpcStats.total - 1} configured`);
      }
    } else {
      lines.push(`  ${c.muted('rpc')}          ${c.faint('manager not available')}`);
    }
    lines.push('');
    lines.push(`  ${c.muted('Tip: cache hit means a sub-1ms response. Misses are RPC roundtrips.')}`);
    lines.push('');
    return { success: true, message: lines.join('\n'), data: { cache: cacheStats, rpc: rpcStats } };
  },
};

/** Helper used by other magic tools to journal trades. */
export function journalMagicTrade(
  context: ToolContext,
  type: import('../security/magic-history.js').MagicTradeEntry['type'],
  details: Partial<import('../security/magic-history.js').MagicTradeEntry>,
): void {
  const kp = context.walletManager.getKeypair();
  const network = (context.config.network ?? 'mainnet-beta') as 'mainnet-beta' | 'devnet';
  if (!kp || !details.txSignature) return;
  // Reject sentinels — `'already-landed'` / `'expired-but-landed'` are NOT
  // real signatures; writing them as txSignature would taint the journal
  // with `expired-…` entries and produce broken Solscan links if the user
  // ever re-renders history. Sentinels are detected via isRealSignature
  // (sub-43 chars or any of the known sentinel constants).
  if (!isRealSignature(details.txSignature)) return;
  recordMagicTrade({
    ts: new Date().toISOString(),
    type,
    walletAddress: kp.publicKey.toBase58(),
    network,
    txSignature: details.txSignature,
    market: details.market,
    side: details.side,
    collateralUsd: details.collateralUsd,
    sizeUsd: details.sizeUsd,
    leverage: details.leverage,
    triggerPriceUsd: details.triggerPriceUsd,
  });
}

export const magicTools: ToolDefinition[] = [
  magicVault,
  magicSettle,
  magicStatus,
  magicDelegation,
  magicPortfolio,
  magicPositions,
  magicVerify,
  magicPrice,
  magicApiHealth,
  magicTokens,
  magicPrices,
  magicPoolData,
  magicRaw,
  magicSnapshot,
  magicPreview,
  magicBuilder,
  magicBasketStream,
  magicMarkets,
  magicSetup,
  magicDeposit,
  magicDepositDirect,
  magicInitDepositLedger,
  magicInitBasket,
  magicDelegateBasket,
  magicWithdraw,
  magicRequestWithdrawal,
  magicWithdrawalSettle,
  magicWithdrawStatus,
  magicWithdrawWatch,
  magicOpen,
  magicClose,
  magicAddCollateral,
  magicRemoveCollateral,
  magicReverse,
  magicPartialClose,
  magicCloseAll,
  magicIncrease,
  magicTriggerOrder,
  magicSetTriggers,
  magicPlaceLimit,
  magicOrders,
  magicCancel,
  magicAccount,
  magicCancelLimit,
  magicCancelTrigger,
  magicLiquidate,
  magicHistory,
  magicDashboard,
  magicErHealth,
  magicAlerts,
  magicFaucet,
  magicDoctor,
  magicPerf,
];
