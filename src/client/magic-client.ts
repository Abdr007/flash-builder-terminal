/**
 * MagicTradeClient — wraps `@flash_trade/magic-trade-client` for FlashEdge.
 *
 * Network defaults:
 *   - mainnet-beta: Pool.0 on program FTv2…hrzV (the same on-chain program as
 *     L1 Flash Trade), delegated to MagicBlock's ER at flashtrade.magicblock.app.
 *   - devnet: Pool.1 on the standalone FMT program (FMTgs…txvj).
 *
 * Two transports the user must understand:
 *   - L1 (mainchain): init UDL, init basket, delegate basket, deposits, session
 *     create/revoke. Uses `sendAndConfirmTransaction` against the L1 RPC.
 *   - ER: openPosition, closePosition, add/removeCollateral, increase/decrease,
 *     execute-orders. Uses the SDK's `sendErTransaction` with skipConfirm:true
 *     for sub-50ms keystroke→signature latency.
 *
 * Signing security: every instruction array passes through
 * `validateInstructionPrograms()` (whitelist) and `signing-guard.ts`
 * (caps + rate limit + audit log) before being signed. Same gates as live mode.
 */

import {
  MagicTradePerpetualsClient,
  PoolConfig,
  Side,
  type MarketConfig,
  MAGIC_TRADE_IDL,
  type PlaceLimitOrderParams,
  type EditLimitOrderParams,
  type PlaceTriggerOrderParams,
  type CancelTriggerOrderParams,
  type Custody,
} from '@flash_trade/magic-trade-client';
import * as anchor from '@coral-xyz/anchor';
import { AnchorProvider } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
  Signer,
  type Cluster,
} from '@solana/web3.js';
import BN from 'bn.js';
import { readFileSync } from 'fs';

import {
  TradeSide,
  Position,
  MarketData,
  Portfolio,
  OpenPositionResult,
  ClosePositionResult,
  CollateralResult,
} from '../types/index.js';
import { validateInstructionPrograms } from '../security/validate-programs.js';
import { getSigningGuard } from '../security/signing-guard.js';
import { assertNotKilled } from '../security/kill-switch.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';
import { ReadCache } from '../utils/read-cache.js';
import { getPoolConfig } from '../utils/pool-cache.js';
import { mapSdkError, toTradingError } from './sdk-errors.js';
// `wrapConnectionWithBlockhashCache` lives in `../utils/cached-blockhash-connection.ts`
// and is preserved for future use against any Connection where the field
// is settable. The SDK's `erConnection` is a getter (no setter), so this
// client uses method-level patching inside `installBlockhashWarmer`
// instead — see the comment there for why.
import {
  priceToNumber,
  liquidationPriceEstimate,
  feeUsdEstimate,
} from './math.js';
import { composeBalanceMap } from './balances.js';
import { OracleExponentCache } from './oracle-exponent-cache.js';
import { verifyWithdrawLanded } from './verify-withdraw.js';
import { inferL1AuditType } from './audit-type.js';
import { verifyKeypairIntact } from './keypair-integrity.js';

const log = getLogger();

/** USD values are 6dp on-chain (matches mainnet convention). */
const USD_DECIMALS = 6;
const USD_POWER = 10 ** USD_DECIMALS;

/** Soft cap on simultaneous trade locks per session. */
const MAX_ACTIVE_TRADES = 32;

/**
 * Captured shape of a single TP / SL slot at the moment we snapshot it.
 * Used by the bg-cancel race-safety logic so we only cancel triggers
 * whose `(triggerSize, triggerPrice)` still matches what the user closed
 * — a follow-up open that re-uses the same orderId slot will have a
 * different fingerprint and is left alone.
 */
export interface TriggerFingerprint {
  market: PublicKey;
  orderId: number;
  isStopLoss: boolean;
  triggerSizeRaw: string;        // BN.toString() — stable cross-process
  triggerPriceRaw: string;       // OraclePrice.price as string
  triggerPriceExponent: number;
}

/** Minimal subset of `Order` we read for fingerprinting. */
export interface TriggerOrderShape {
  triggerSize?: BN;
  triggerPrice?: { price?: BN; exponent?: number };
}

/** Minimal basket shape — we only use the trigger arrays for cancel logic. */
export interface BasketShape {
  orders?: Array<{
    market: PublicKey;
    order: {
      stopLossOrders?: TriggerOrderShape[];
      takeProfitOrders?: TriggerOrderShape[];
    };
  }>;
}

/**
 * Re-fetch the basket and return only the fingerprints whose live
 * trigger STILL matches what we captured (same triggerSize + same
 * triggerPrice). Anything mutated, replaced, or wiped is dropped.
 *
 * Used by `cancelTriggersInBackground` to make orphan-cleanup safe
 * against re-opens within the bg tx's flight window.
 */
export function matchFingerprints(basket: BasketShape | null, fingerprints: TriggerFingerprint[]): TriggerFingerprint[] {
  const orders = basket?.orders ?? [];
  const out: TriggerFingerprint[] = [];
  for (const fp of fingerprints) {
    const slot = orders.find((s) => s.market.equals(fp.market));
    if (!slot) continue;
    const arr = fp.isStopLoss ? slot.order.stopLossOrders : slot.order.takeProfitOrders;
    const o = arr?.[fp.orderId];
    if (!o) continue;
    if (!o.triggerSize || (typeof o.triggerSize.isZero === 'function' && o.triggerSize.isZero())) continue;
    if (o.triggerSize.toString() !== fp.triggerSizeRaw) continue;
    if ((o.triggerPrice?.price?.toString() ?? '0') !== fp.triggerPriceRaw) continue;
    out.push(fp);
  }
  return out;
}

export interface MagicTradeClientOptions {
  /** Owner wallet — pays L1 fees, signs init/delegate/deposit/createSession. */
  wallet: Keypair;
  /** L1 RPC connection (mainnet-beta or devnet, must match `network`). */
  l1Connection: Connection;
  /** Cluster the pool lives on. */
  network: 'mainnet-beta' | 'devnet';
  /** PoolConfig name (e.g. 'Pool.0' for mainnet). */
  poolName: string;
  /** ER router endpoint URL. */
  erEndpoint: string;
  /** Override `poolConfig.programId` (rare — only for non-default deploys). */
  programIdOverride?: string;
  /** Compute-unit price (microlamports) for L1 txs. ER txs use the protocol max. */
  prioritizationFee?: number;
  /**
   * When true (default), ER trade ixs return the signature immediately after
   * submission and poll for confirmation in the background. Set false to wait
   * synchronously for ER commit (slower but caller knows trade landed).
   */
  fastConfirm?: boolean;
}

export class MagicTradeClient {
  readonly walletAddress: string;
  readonly poolConfig: PoolConfig;
  readonly programId: PublicKey;
  readonly network: 'mainnet-beta' | 'devnet';

  readonly basketPda: PublicKey;
  readonly userDepositLedgerPda: PublicKey;

  private readonly wallet: Keypair;
  private readonly l1Connection: Connection;
  private readonly sdk: MagicTradePerpetualsClient;
  private readonly erEndpoint: string;

  /** When true, ER trade ixs use skipConfirm and return immediately. */
  private readonly fastConfirm: boolean;

  /**
   * Most-recent previewOpen quote, cached so openPosition can skip the
   * duplicate `getOpenPositionQuote` simulate (~100ms saved on the hot path).
   * Keyed by `${target}:${side}:${collateral}:${leverage}:${collateralToken}`;
   * cache-hit only when the same key is re-requested within 5s.
   */
  private lastQuoteCache: {
    key: string;
    quote: {
      collateralAmount: BN;
      sizeAmount: BN;
      entryPrice: { price: BN; exponent: number };
      liquidationPrice: { price: BN; exponent: number };
      sizeUsd: BN;
      collateralUsd: BN;
      entryFeeUsd: BN;
      swapRequired: boolean;
    };
    ts: number;
  } | null = null;

  /**
   * Pre-warmed ER blockhash. Refreshed every 250ms in the background so trade
   * ixs can skip the RPC roundtrip (~30-80ms per tx) for `getLatestBlockhash`.
   * The SDK's `sendErTransactionLegacy` calls `conn.getLatestBlockhash()` —
   * we monkey-patch it on the ER connection so the cached value is returned.
   *
   * Tightened from 400ms → 250ms to keep the cache fresher for high-frequency
   * trading. ER block time is ~400ms; cache lives less than one block so we
   * never hand out a stale-by-default value.
   */
  /**
   * Mutable cache slot read by the `getLatestBlockhash` Proxy and written by
   * both the inline cache-miss path and the background warmer. Holding the
   * slot in a `{ ref }` wrapper lets us hand the same reference to the
   * Proxy at construction time AND keep a typed handle here for eviction
   * (set `.ref = null` on stale-blockhash retry).
   */
  private blockhashCacheRef: import('../utils/cached-blockhash-connection.js').BlockhashCacheRef =
    { ref: null };
  private blockhashTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Per-instance oracle-exponent cache. See `oracle-exponent-cache.ts`
   * for the rationale (per-instance prevents cross-pool / cross-network
   * bleed; the module-level fallback inside that class lets a sibling
   * client's earlier observation be a tier-2 hint).
   */
  private exponentCache = new OracleExponentCache();
  /**
   * Connection instance whose `getLatestBlockhash` we patched. Held so
   * `shutdown()` can restore the original method when this client is
   * disposed — without this, a re-created client built on the same SDK
   * would keep serving stale values from the disposed cache closure.
   *
   * (Earlier we tried a Proxy-based wrapper that replaced `sdk.erConnection`
   * wholesale, but `erConnection` is a getter with no matching setter —
   * the integration test caught it. We're back to method-level patching.)
   */
  private patchedErConnection: Connection | null = null;
  /** Original (unwrapped) `getLatestBlockhash`, restored by `shutdown()`. */
  private originalErGetLatestBlockhash:
    | ((...args: unknown[]) => Promise<{ blockhash: string; lastValidBlockHeight: number }>)
    | null = null;
  // ER block time is ~400ms. Refresh every 150ms so a fresh blockhash
  // arrives within ~½ a block window. Max age of 400ms = never serve a
  // hash older than one block, eliminating the rare "Blockhash not found"
  // retry that previously cost ~250ms when the network drifted.
  private static readonly BLOCKHASH_REFRESH_MS = 150;
  private static readonly BLOCKHASH_MAX_AGE_MS = 400;

  /**
   * Cached oracle prices per symbol — populated by background pre-warmer for
   * markets the user has interacted with. Saves the per-trade `fetchEntryPrice`
   * simulate (~100ms) on follow-up trades for the same symbol.
   */
  private oracleCache = new Map<string, { price: number; fetchedAt: number }>();
  /**
   * TTL cache for read-heavy methods (portfolio, market data, balances).
   * 1.5s TTL coalesces back-to-back commands without showing meaningful
   * staleness at trade-decision time. Write paths bust('portfolio:') etc.
   * to keep the next read fresh.
   */
  public readonly reads = new ReadCache<unknown>({ ttlMs: 1500, maxEntries: 256 });
  private oracleWatchSet = new Set<string>();
  private oracleTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly ORACLE_REFRESH_MS = 1000;
  private static readonly ORACLE_MAX_AGE_MS = 3000;

  /** Per-market mutex (key: `MARKET:SIDE`). Each entry is an in-flight trade. */
  private readonly activeTrades = new Set<string>();

  constructor(opts: MagicTradeClientOptions) {
    this.wallet = opts.wallet;
    this.walletAddress = opts.wallet.publicKey.toBase58();
    this.l1Connection = opts.l1Connection;
    this.erEndpoint = opts.erEndpoint;
    this.network = opts.network;
    this.fastConfirm = opts.fastConfirm ?? true;

    // Use a Node-native Agent with keep-alive for the L1 connection so
    // sendRawTransaction reuses TCP/TLS instead of paying a fresh handshake
    // on every trade. Big win on cold sessions; ~50-100ms saved on first tx.
    // The ER router connection (built by the SDK from `erEndpoint`) inherits
    // the same Node global agent, so this benefits ER sends too.
    const cluster: Cluster = opts.network === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
    try {
      // getPoolConfig caches the parsed PoolConfig per (poolName, cluster) so
      // repeated client construction (wallet switches, prewarm, doctor) only
      // pays the ~10ms parse cost once per process lifetime.
      this.poolConfig = getPoolConfig(opts.poolName, cluster);
    } catch (err) {
      throw new Error(
        `[magic-mode] Pool '${opts.poolName}' not found in @flash_trade/magic-trade-client PoolConfig for cluster '${cluster}'. ` +
          `Set MAGIC_NETWORK + MAGIC_POOL_NAME to a published pool, or update the SDK.`,
        { cause: err },
      );
    }
    if (!this.poolConfig.isMagicBlock) {
      throw new Error(
        `[magic-mode] Pool '${opts.poolName}' on '${cluster}' is not a Magic-Block pool ` +
          `(isMagicBlock=false). Mainnet uses 'Pool.0', devnet uses 'Pool.1'.`,
      );
    }

    this.programId = opts.programIdOverride
      ? new PublicKey(opts.programIdOverride)
      : new PublicKey(this.poolConfig.programId);

    // Build the L1 anchor provider — the SDK uses this for mainchain ixs and
    // internally constructs an ER provider from `erEndpoint`.
    const WalletCtor = (anchor as unknown as { Wallet: new (kp: Keypair) => unknown }).Wallet;
    const anchorWallet = new WalletCtor(this.wallet) as anchor.Wallet;
    const provider = new AnchorProvider(this.l1Connection, anchorWallet, {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    });

    // SDK's MagicTradePerpetualsClient.initEr() prints a raw `console.log`
    // banner. That intrudes into our terminal output (esp. background
    // pre-warm). Silence it surgically during construction.
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      const first = args[0];
      if (typeof first === 'string' && first.startsWith('[MagicTrade]')) return;
      return origLog(...args);
    };
    try {
      this.sdk = new MagicTradePerpetualsClient(
        provider,
        MAGIC_TRADE_IDL,
        this.programId,
        {
          prioritizationFee: opts.prioritizationFee ?? 0,
          useExternalOracle: false,
        },
        opts.erEndpoint,
      );
    } finally {
      console.log = origLog;
    }

    const owner = this.wallet.publicKey;
    this.basketPda = PublicKey.findProgramAddressSync(
      [Buffer.from('basket'), owner.toBuffer()],
      this.programId,
    )[0];
    this.userDepositLedgerPda = PublicKey.findProgramAddressSync(
      [Buffer.from('user_deposit_ledger'), owner.toBuffer()],
      this.programId,
    )[0];

    log.info(
      'magic-client',
      `init network=${cluster} pool=${opts.poolName} program=${this.programId.toBase58().slice(0, 8)}… er=${opts.erEndpoint}`,
    );

    // Pre-warm ER blockhash so trade ixs skip the RPC roundtrip on the hot path.
    this.installBlockhashWarmer();
  }

  /** Stop the background blockhash warmer — call on shutdown to avoid leaking timers. */
  shutdown(): void {
    if (this.blockhashTimer) {
      clearInterval(this.blockhashTimer);
      this.blockhashTimer = null;
    }
    if (this.oracleTimer) {
      clearInterval(this.oracleTimer);
      this.oracleTimer = null;
    }
    // Cancel any pending ER tx-status polls so they don't fire after the REPL
    // has closed and try to write to a closed stdout.
    for (const handle of this.pendingPollTimers) {
      try { clearTimeout(handle); } catch { /* ignore */ }
    }
    this.pendingPollTimers.clear();
    // Restore the patched Connection's `getLatestBlockhash` so a client
    // re-created on the same SDK isn't left serving stale values from
    // our now-disposed cache closure.
    const erConn = this.patchedErConnection;
    const orig = this.originalErGetLatestBlockhash;
    if (erConn && orig) {
      try {
        (erConn as unknown as { getLatestBlockhash: Connection['getLatestBlockhash'] }).getLatestBlockhash =
          orig as unknown as Connection['getLatestBlockhash'];
      } catch { /* connection may already be released */ }
    }
    this.patchedErConnection = null;
    this.originalErGetLatestBlockhash = null;
    this.blockhashCacheRef.ref = null;
  }

  /**
   * Mark a symbol for background oracle pre-warming. After the first trade or
   * `magic price <sym>` call we keep the price hot via a 1s background loop,
   * so subsequent opens skip the ~100ms simulate entirely.
   */
  watchOraclePrice(symbol: string): void {
    if (this.oracleWatchSet.has(symbol)) return;
    this.oracleWatchSet.add(symbol);
    this.installOracleWarmer();
    // Kick an immediate fetch for the new symbol — don't wait for the next
    // 1s tick. fetchOraclePrice now populates oracleCache directly.
    if (!this.cachedOraclePrice(symbol)) {
      this.fetchOraclePrice(symbol).catch(() => undefined);
    }
  }

  /** Read a cached oracle price if fresh, else null (caller fetches live). */
  cachedOraclePrice(symbol: string): number | null {
    const c = this.oracleCache.get(symbol);
    if (!c) return null;
    if (Date.now() - c.fetchedAt > MagicTradeClient.ORACLE_MAX_AGE_MS) return null;
    return c.price;
  }

  private installOracleWarmer(): void {
    if (this.oracleTimer) return;
    const tick = async (): Promise<void> => {
      const symbols = Array.from(this.oracleWatchSet);
      if (symbols.length === 0) return;
      // Parallel — each fetchOraclePrice is one ER simulate.
      await Promise.all(
        symbols.map(async (s) => {
          try {
            const price = await this.fetchOraclePrice(s);
            if (Number.isFinite(price) && price > 0) {
              this.oracleCache.set(s, { price, fetchedAt: Date.now() });
            }
          } catch {
            /* skip */
          }
        }),
      );
    };
    void tick();
    this.oracleTimer = setInterval(() => void tick(), MagicTradeClient.ORACLE_REFRESH_MS);
    this.oracleTimer.unref?.();
  }

  // ─── IFlashClient: reads ───────────────────────────────────────────────────

  getBalance(): number {
    // Sync signature inherited from IFlashClient — real balance is async via getPortfolio.
    return 0;
  }

  async getPortfolio(): Promise<Portfolio> {
    return this.reads.get(`portfolio:${this.walletAddress}`, () => this.getPortfolioUncached()) as Promise<Portfolio>;
  }

  private async getPortfolioUncached(): Promise<Portfolio> {
    const owner = this.wallet.publicKey;

    // Basket lives on ER (live state); UDL on L1 (where deposits are written).
    //
    // We deliberately distinguish two failure modes:
    //   1. "Account does not exist" — a fresh wallet that has not yet run
    //      `magic setup`. NOT an error. Treat as "no positions" so the
    //      portfolio/dashboard renders a clean empty state instead of a
    //      stack trace on first launch. This is a high-frequency UX path
    //      and was the #1 first-impression bug.
    //   2. Anything else (RPC down, deserialisation failure, …) — let it
    //      propagate so the user sees the real reason rather than a
    //      misleading "no positions".
    const [basket, ledger] = await Promise.all([
      this.erAccounts
        .fetchBasket(owner)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (/account.*does not exist|has no data|account not initialized|AccountNotInitialized/i.test(msg)) {
            return null;
          }
          throw err;
        }) as Promise<{ positions: Array<{ market: PublicKey; position: unknown }> | null } | null>,
      this.sdk.accounts.fetchUserDepositLedger(owner).catch(() => null),
    ]);

    const positions = basket ? await this.buildPositionsFromBasket(basket as { positions: Array<{ market: PublicKey; position: unknown }> | null }) : [];

    let totalCollateralUsd = 0;
    let totalUnrealizedPnl = 0;
    for (const p of positions) {
      totalCollateralUsd += p.collateralUsd;
      totalUnrealizedPnl += p.unrealizedPnl;
    }

    const deposits = (ledger?.deposits ?? []) as Array<{ amount: BN; mint: PublicKey }>;
    const balanceUsd = deposits.reduce((acc, d) => {
      const tok = this.tokenForMintOrNull(d.mint);
      if (!tok) return acc;
      // Stable mints map 1:1 to USD; non-stable would need oracle conversion (P2 follow-up).
      return tok.isStable ? acc + Number(d.amount) / 10 ** tok.decimals : acc;
    }, 0);

    return {
      walletAddress: this.walletAddress,
      balance: balanceUsd,
      balanceLabel: 'USDC',
      totalCollateralUsd,
      totalUnrealizedPnl,
      totalRealizedPnl: 0,
      totalFees: 0,
      positions,
      totalPositionValue: positions.reduce((acc, p) => acc + p.sizeUsd, 0),
    };
  }

  async getPositions(): Promise<Position[]> {
    const portfolio = await this.getPortfolio();
    return portfolio.positions;
  }

  async getMarketData(market?: string): Promise<MarketData[]> {
    const filter = market ? market.toUpperCase() : null;
    return this.reads.get(`markets:${this.network}:${this.poolConfig.poolName}:${filter ?? '*'}`,
      () => this.getMarketDataUncached(filter)) as Promise<MarketData[]>;
  }

  private async getMarketDataUncached(filter: string | null): Promise<MarketData[]> {
    // Pull all custody accounts in one batch — gives us OI per custody.
    const custodyAccts = await this.sdk.accounts.fetchAllCustodies(this.poolConfig.poolId).catch(() => []);
    const oiByCustody = new Map<string, { long: number; short: number }>();
    for (const c of custodyAccts) {
      const sym = this.poolConfig.custodies.find((cc) => cc.custodyAccount.equals(c.publicKey))?.symbol;
      if (!sym) continue;
      // The SDK's batched fetcher returns either a raw Custody or a
      // ProgramAccount<Custody> wrapper depending on version — narrow
      // either to the IDL-typed Assets shape. Older code cast to a
      // bespoke `{ collateral, locked, owned }` shape that doesn't
      // exist on chain (Assets is `{ owned, locked, receivable,
      // payable }`); the long-OI lookup it tried was always zero.
      //
      // True per-side OI lives on `Market.collective_position`, not
      // on the custody — fetching that requires a separate batched
      // read. We approximate here with what the custody exposes and
      // leave a follow-up to wire `Market.collective_position` for
      // the real numbers. Until then, both sides report 0 (which
      // matches the pre-existing — and visibly empty — behaviour
      // rather than introducing a new wrong-looking number).
      const account = (c as unknown as { account?: Custody }).account
        ?? (c as unknown as Custody);
      void account;
      oiByCustody.set(sym, { long: 0, short: 0 });
    }

    // Live oracle prices — fetch in parallel via SDK simulate. Skipped when caller
    // doesn't filter to a specific symbol (full table refresh would be 27 simulates).
    const priceMap = new Map<string, number>();
    if (filter) {
      const cfg = this.poolConfig.custodies.find((c) => c.symbol === filter);
      if (cfg) {
        const px = await this.fetchOraclePrice(cfg.symbol, undefined, TradeSide.Long).catch(() => 0);
        priceMap.set(cfg.symbol, px);
      }
    }

    const out: MarketData[] = [];
    for (const m of this.poolConfig.markets) {
      const target = this.poolConfig.custodies.find((c) => c.custodyAccount.equals(m.targetCustody));
      if (!target) continue;
      if (filter && target.symbol !== filter) continue;
      if (out.some((o) => o.symbol === target.symbol)) continue;
      const oi = oiByCustody.get(target.symbol) ?? { long: 0, short: 0 };
      out.push({
        symbol: target.symbol,
        price: priceMap.get(target.symbol) ?? 0,
        priceChange24h: 0, // 24h delta is sourced from CoinGecko in live mode
        openInterestLong: oi.long,
        openInterestShort: oi.short,
        maxLeverage: m.maxLev,
        fundingRate: 0,
      });
    }
    return out;
  }

  /**
   * Get the current oracle/entry price for a target symbol using the SDK's
   * typed `getEntryPriceAndFee` view. Pass a size of 1 base unit so fees ≈ 0
   * and the returned `entry_price` is effectively the spot oracle price.
   *
   * Why not `sdk.getOraclePrice`? It returns just the raw ix and the IDL
   * doesn't declare a typed `returns` field, so the SDK's ViewHelper.decodeLogs
   * errors with "View expected return type". `getEntryPriceAndFee` is fully
   * typed — same simulate cost (~50-100ms) and we get a fee estimate too.
   */
  async fetchOraclePrice(targetSymbol: string, lockSymbol?: string, side: TradeSide = TradeSide.Long): Promise<number> {
    const lock = lockSymbol ?? this.resolveMarket(targetSymbol, side).lockSymbol;
    const sdkSide = side === TradeSide.Long ? Side.Long : Side.Short;
    let result;
    try {
      result = await this.sdk.getEntryPriceAndFee(targetSymbol, lock, sdkSide, this.poolConfig, new BN(1));
    } catch (err) {
      // SDK simulation needs the user's basket/UDL accounts. Fresh
      // wallets (pre-`magic setup`) hit ProgramAccountNotFound /
      // AccountNotInitialized here — but a price read shouldn't require
      // any user-side setup. Fall back to a direct Pyth Hermes read
      // using the custody's published `pythTicker`. This is what the
      // monitor TUI already uses for its 24/7 mainnet feed; here we
      // wire it as the price-tool fallback so `magic price SOL` works
      // the moment a user runs it on a brand-new install.
      const msg = err instanceof Error ? err.message : String(err);
      if (/ProgramAccountNotFound|AccountNotInitialized|Account.*does not exist/i.test(msg)) {
        const fallback = await this.fetchOraclePriceFromPyth(targetSymbol).catch(() => null);
        if (fallback !== null && fallback > 0) {
          if (Number.isFinite(fallback)) {
            this.oracleCache.set(targetSymbol, { price: fallback, fetchedAt: Date.now() });
          }
          return fallback;
        }
      }
      throw toTradingError(err, 'price');
    }
    const entry = result.entryPrice as { price: BN; exponent: number };
    const price = priceToNumber(entry);
    // Remember the chain's exponent for this symbol so later TP/SL/limit
    // serialization uses the right scale rather than a hard-coded -8.
    this.rememberExponent(targetSymbol, entry.exponent);
    // Populate the cache so the next open()/reverse()/etc. skips this simulate.
    // Previously only the background warmer did this, which meant the very
    // first trade always paid the ~300-500ms simulate cost.
    if (Number.isFinite(price) && price > 0) {
      this.oracleCache.set(targetSymbol, { price, fetchedAt: Date.now() });
    }
    return price;
  }

  /**
   * Direct Pyth Hermes price read — used as a fallback when the SDK's
   * program-simulation path can't run (fresh wallets without basket /
   * UDL accounts). The custody's `pythTicker` (e.g. `Crypto.SOL/USD`)
   * maps 1:1 to a Pyth Hermes feed id; the result is comparable to the
   * SDK's `entryPrice` for read-only purposes (no fee component).
   */
  private async fetchOraclePriceFromPyth(targetSymbol: string): Promise<number | null> {
    const cust = this.poolConfig.custodies.find((c) => c.symbol === targetSymbol.toUpperCase());
    if (!cust || !cust.pythTicker) return null;
    const { getPythService } = await import('../data/pyth-prices.js');
    const svc = getPythService();
    const map = await svc.getCurrentPrices([cust.pythTicker]).catch(() => null);
    if (!map) return null;
    const entry = map.get(cust.pythTicker);
    return entry && Number.isFinite(entry.price) && entry.price > 0 ? entry.price : null;
  }

  /**
   * Preview an open without signing. Returns the same numbers the trade card
   * will show: entry, liq, size, collateral, fee, swap-required flag. Used
   * for the Y/N confirm prompt so the user sees exactly what they're about to
   * sign before any tx hits chain.
   */
  async previewOpen(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
    collateralToken?: string,
  ): Promise<{
    targetSymbol: string;
    lockSymbol: string;
    collateralSymbol: string;
    entryPrice: number;
    liquidationPrice: number;
    sizeUsd: number;
    collateralUsd: number;
    feeUsd: number;
    swapRequired: boolean;
  }> {
    const targetSymbol = market.toUpperCase();
    const collateralSymbol = (collateralToken ?? 'USDC').toUpperCase();
    const sdkSide = side === TradeSide.Long ? Side.Long : Side.Short;
    const { lockSymbol } = this.resolveMarket(targetSymbol, side);
    const collateralCustody = this.poolConfig.getCustodyFromSymbol(collateralSymbol);
    const collateralRaw = new BN(Math.floor(collateralAmount * 10 ** collateralCustody.decimals));
    const leverageBps = new BN(Math.round(leverage * 10_000));

    let quote;
    try {
      quote = await this.sdk.getOpenPositionQuote(
        targetSymbol,
        lockSymbol,
        sdkSide,
        this.poolConfig,
        collateralRaw,
        leverageBps,
        collateralSymbol,
        null,
        null,
        null,
        this.basketPda,
      );
    } catch (err) {
      throw toTradingError(err, 'previewOpen');
    }

    // Stash the quote so a subsequent openPosition() call with matching params
    // can reuse it (skips a ~100ms simulate on the hot path).
    this.lastQuoteCache = {
      key: this.quoteKey(targetSymbol, side, collateralAmount, leverage, collateralSymbol),
      quote: {
        collateralAmount: quote.collateralAmount as BN,
        sizeAmount: quote.sizeAmount as BN,
        entryPrice: quote.entryPrice as { price: BN; exponent: number },
        liquidationPrice: quote.liquidationPrice as { price: BN; exponent: number },
        sizeUsd: quote.sizeUsd as BN,
        collateralUsd: quote.collateralUsd as BN,
        entryFeeUsd: quote.entryFeeUsd as BN,
        swapRequired: Boolean(quote.swapRequired),
      },
      ts: Date.now(),
    };

    const entryQuote = quote.entryPrice as { price: BN; exponent: number };
    this.rememberExponent(targetSymbol, entryQuote.exponent);
    return {
      targetSymbol,
      lockSymbol,
      collateralSymbol,
      entryPrice: priceToNumber(entryQuote),
      liquidationPrice: priceToNumber(quote.liquidationPrice as { price: BN; exponent: number }),
      sizeUsd: Number((quote.sizeUsd as BN).toString()) / USD_POWER,
      collateralUsd: Number((quote.collateralUsd as BN).toString()) / USD_POWER,
      feeUsd: Number((quote.entryFeeUsd as BN).toString()) / USD_POWER,
      swapRequired: Boolean(quote.swapRequired),
    };
  }

  private quoteKey(target: string, side: TradeSide, coll: number, lev: number, payTok: string): string {
    return `${target.toUpperCase()}:${side}:${coll}:${lev}:${payTok.toUpperCase()}`;
  }

  // ─── IFlashClient: trades ──────────────────────────────────────────────────

  async openPosition(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
    collateralToken?: string,
    tpPriceUsd?: number,
    slPriceUsd?: number,
  ): Promise<OpenPositionResult> {
    const targetSymbol = market.toUpperCase();
    const collateralSymbol = (collateralToken ?? 'USDC').toUpperCase();
    const sdkSide = side === 'long' ? Side.Long : Side.Short;
    const { lockSymbol } = this.resolveMarket(targetSymbol, side);

    // No Pyth-staleness gate here — Flash V2 uses its OWN internal oracle
    // (`intOracleAccount`) that's updated continuously, so equity / metals /
    // commodities are tradable 24/7 even when Pyth's external feed is hours
    // stale (after-hours, weekends). The program is the source of truth on
    // tradability; if it rejects, the user sees the real on-chain error via
    // the background pollErTxBackground watcher.

    // Signing-guard pre-checks (mirror live-mode behaviour).
    const guard = getSigningGuard();
    const sizeUsd = collateralAmount * leverage;
    const limit = guard.checkTradeLimits({ collateral: collateralAmount, leverage, sizeUsd, market: targetSymbol });
    if (!limit.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'open',
        market: targetSymbol,
        side,
        collateral: collateralAmount,
        leverage,
        sizeUsd,
        walletAddress: this.walletAddress,
        result: 'rejected',
        reason: limit.reason,
      });
      throw new Error(limit.reason);
    }
    const rate = guard.checkRateLimit();
    if (!rate.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'open',
        market: targetSymbol,
        side,
        walletAddress: this.walletAddress,
        result: 'rate_limited',
        reason: rate.reason,
      });
      throw new Error(rate.reason);
    }

    // Hot-path optimization: mark this market for background oracle pre-warming
    // so the next trade in the same market skips the ~100ms simulate.
    this.watchOraclePrice(targetSymbol);

    // Pre-flight basket-balance check.
    //
    // Without this, an open with insufficient `available` (deposits −
    // debits + pendingCredits) submits successfully to the ER, the
    // background watcher catches the InsufficientAvailableBalance
    // error 2 s later, and the user has already seen a green
    // `POSITION OPENED` card for a tx that never landed. That's the
    // worst possible UX failure mode: the CLI lying about an outcome.
    //
    // We read the basket via the cached `getAvailableBalances` (3 s
    // TTL, sign-time invalidated). If we can prove the balance is
    // insufficient now, throw a clear error BEFORE signing — saving
    // both the doomed tx fee AND the user's trust.
    //
    // Best-effort: if the basket read fails (RPC blip), we proceed
    // and let the program decide. The background watcher catches the
    // failure as before.
    try {
      const balances = await this.getAvailableBalances();
      const stable = balances.get(collateralSymbol);
      // 0.0001 USDC epsilon: tolerates float-rounding noise from
      // `getAvailableBalances` (which divides BNs by 10^6). Without
      // this, a literal full-balance trade ("collateral = available")
      // sometimes trips the guard because the divided number was
      // 12.999999999998 instead of 13.0. 0.0001 USDC is well below
      // any meaningful trade size and well above any plausible
      // float-rounding error.
      if (stable && Number.isFinite(stable.available) && stable.available + 0.0001 < collateralAmount) {
        throw new Error(
          `Insufficient ${collateralSymbol} available in your basket (have ${stable.available.toFixed(4)}, need ${collateralAmount}). ` +
          `Run \`vault\` to see balances; \`deposit ${collateralSymbol} <amount>\` to fund, or \`settle\` if you have pending credits.`,
        );
      }
    } catch (err) {
      // Re-throw OUR thrown insufficient-balance error; swallow only
      // the RPC-failure case (basket read couldn't resolve).
      const msg = err instanceof Error ? err.message : String(err);
      if (/Insufficient .* available in your basket/i.test(msg)) throw err;
      log.debug('magic-client', `pre-flight balance check skipped (${msg})`);
    }

    const lockKey = `${targetSymbol}:${side}`;
    this.acquireTradeLock(lockKey);
    try {
      // No cache-hit short-circuit on the open path. The earlier idempotent-
      // retry cache caused subsequent legitimate opens with same (market, side,
      // collateral, leverage) to silently no-op and render fake $0.00 entry.
      // Duplicate-position protection lives on-chain (program rejects 2nd open
      // on the same market+side); concurrent retries are caught by the trade
      // lock above; cooldown by the rate limit. The cache added no real safety.

      // Auto-settle was here but it added ~200-1500ms to every open and
      // settle is currently broken on-chain anyway. Skipped on the hot path.
      // If a trade fails with InsufficientAvailableBalance the user gets a
      // clear error and can run `magic settle` manually (or just deposit more).

      const collateralCustody = this.poolConfig.getCustodyFromSymbol(collateralSymbol);
      const collateralRaw = new BN(Math.floor(collateralAmount * 10 ** collateralCustody.decimals));
      const leverageBps = new BN(Math.round(leverage * 10_000));

      // Mirror the official Flash UI's pattern:
      //   - Always plain openPosition (no swapAndOpenPosition — the program handles
      //     cross-token via the receivingCustody account internally).
      //   - getOpenPositionQuote takes the LOCK symbol as `collateralSymbol` (for
      //     its market lookup) and the user's pay token as `receivingSymbol`.
      //   - openPosition takes (target, lock, collateral=user-pay-token).
      //
      // Hot-path speed: try sources for size in order
      //   1. Recent preview quote cache (5s) — same params as a just-shown preview
      //   2. Oracle cache (3s) — compute size locally from cached price
      //   3. Live SDK getOpenPositionQuote — ~100ms simulate against ER
      const quoteCacheKey = this.quoteKey(targetSymbol, side, collateralAmount, leverage, collateralSymbol);
      const cachedQuote = this.lastQuoteCache;
      const cachedOracle = this.cachedOraclePrice(targetSymbol);
      const targetCustody = this.poolConfig.getCustodyFromSymbol(targetSymbol);

      type Quote = NonNullable<typeof cachedQuote>['quote'];
      let quote: Quote;
      let quoteIsCanonical = true; // false → synthesized; sizeAmount may diverge from on-chain

      // Inline TP/SL bundling requires `sizeRawForIx` to match the chain's
      // actual position size to the token. The synthesized fast-path computes
      // size from a cached oracle and so can be a few raw units off — the
      // chain's TP/SL would then close a slightly-wrong slice. When the user
      // requests inline TP/SL, force the canonical SDK quote path.
      const requestedInlineTrigger = (tpPriceUsd && tpPriceUsd > 0) || (slPriceUsd && slPriceUsd > 0);

      if (cachedQuote && cachedQuote.key === quoteCacheKey && Date.now() - cachedQuote.ts < 5000) {
        quote = cachedQuote.quote;
      } else if (cachedOracle && cachedOracle > 0 && !requestedInlineTrigger) {
        quoteIsCanonical = false;
        // Synthesize a quote locally from the cached oracle. Saves the
        // ~100ms simulate. Fees subtracted at the standard 4 bps.
        const sizeRaw = new BN(Math.floor((sizeUsd / cachedOracle) * 10 ** targetCustody.decimals));
        const sizeUsdRaw = new BN(Math.floor(sizeUsd * 1_000_000));
        const collUsdRaw = new BN(Math.floor(collateralAmount * 1_000_000));
        // Pure-math helpers from `./math.ts` — property-tested for the
        // invariants we care about (long liq < entry, fee bounded, etc.).
        const feeUsdRaw = new BN(Math.floor(feeUsdEstimate(sizeUsd, 4) * 1_000_000));
        const oracleRaw = new BN(Math.floor(cachedOracle * 1e8));
        const liqUsd = liquidationPriceEstimate(
          cachedOracle,
          leverage,
          side === TradeSide.Long ? 'long' : 'short',
        );
        const liqRaw = new BN(Math.floor(liqUsd * 1e8));
        quote = {
          collateralAmount: collateralRaw,
          sizeAmount: sizeRaw,
          entryPrice: { price: oracleRaw, exponent: -8 },
          liquidationPrice: { price: liqRaw, exponent: -8 },
          sizeUsd: sizeUsdRaw,
          collateralUsd: collUsdRaw,
          entryFeeUsd: feeUsdRaw,
          swapRequired: collateralSymbol !== lockSymbol,
        };
      } else {
        try {
          quote = (await this.sdk.getOpenPositionQuote(
            targetSymbol,
            lockSymbol,
            sdkSide,
            this.poolConfig,
            collateralRaw,
            leverageBps,
            collateralSymbol,
            null,
            null,
            null,
            this.basketPda,
          )) as unknown as Quote;
        } catch (err) {
          throw toTradingError(err, 'openPosition.quote');
        }
      }
      const collateralRawForIx = quote.collateralAmount as BN;
      const sizeRawForIx = quote.sizeAmount as BN;
      const entryQuoteForOpen = quote.entryPrice as { price: BN; exponent: number };
      // Remember the chain's exponent — TP/SL serialization for non-crypto
      // markets relies on this.
      this.rememberExponent(targetSymbol, entryQuoteForOpen.exponent);
      const entryPriceForReturn = priceToNumber(entryQuoteForOpen);
      const liqPriceForReturn = priceToNumber(quote.liquidationPrice as { price: BN; exponent: number });

      const result = await this.sdk.openPosition(
        targetSymbol,
        lockSymbol,
        collateralSymbol,
        sdkSide,
        this.poolConfig,
        collateralRawForIx,
        sizeRawForIx,
      );

      // Optional inline TP/SL — bundled into the SAME tx as the open.
      // The trigger ixs reference (target, lock, side) — the basket position
      // they close against is created by the preceding open ix in this tx.
      // This preserves the ~0.2s open latency by avoiding two separate ER
      // round-trips and skipping the inter-trade rate-limit cooldown.
      //
      // Defensive sanity: if quote was synthesized AND user requested inline
      // TP/SL, refuse — the synthesized size can differ from on-chain by a
      // few raw units, which would leave a dust position. The branch above
      // already forces the canonical path when requestedInlineTrigger=true,
      // so this assertion documents the invariant rather than re-route.
      if (requestedInlineTrigger && !quoteIsCanonical) {
        throw new Error(
          '[magic-mode] internal invariant: inline TP/SL requested but quote is synthesized. ' +
          'Refusing to attach triggers with mismatched size.',
        );
      }
      const ixs: TransactionInstruction[] = [...result.instructions];
      const additionalSigners = [...result.additionalSigners];
      if (tpPriceUsd && tpPriceUsd > 0) {
        const tpRes = await this.sdk.placeTriggerOrder(
          targetSymbol,
          lockSymbol,
          sdkSide,
          this.poolConfig,
          {
            triggerPrice: this.usdToOraclePrice(targetSymbol, tpPriceUsd),
            deltaSizeAmount: sizeRawForIx,
            isStopLoss: false,
          } as unknown as PlaceTriggerOrderParams,
        );
        ixs.push(...tpRes.instructions);
        additionalSigners.push(...tpRes.additionalSigners);
      }
      if (slPriceUsd && slPriceUsd > 0) {
        const slRes = await this.sdk.placeTriggerOrder(
          targetSymbol,
          lockSymbol,
          sdkSide,
          this.poolConfig,
          {
            triggerPrice: this.usdToOraclePrice(targetSymbol, slPriceUsd),
            deltaSizeAmount: sizeRawForIx,
            isStopLoss: true,
          } as unknown as PlaceTriggerOrderParams,
        );
        ixs.push(...slRes.instructions);
        additionalSigners.push(...slRes.additionalSigners);
      }

      const sig = await this.sendErIxs(ixs, additionalSigners, 'magic.openPosition');
      // We no longer block on chain-truth here in the common case — the
      // ~300 ms it cost on every successful open was the dominant share
      // of the user's wall-clock. The background watcher
      // (`pollErTxBackground`, fires 2 s after submit) still surfaces
      // post-confirm errors via `replSafeWrite`.
      //
      // EXCEPTION: when the user attached inline TP/SL, we DO take a
      // narrow 300 ms budget to confirm the position exists on chain.
      // Reason: the trigger ixs are bundled in the same tx, so if the
      // open silently failed the user is left with TP/SL pointing at
      // nothing — which is harmless but confusing. A 300 ms check on
      // open lets us either (a) confirm everything landed cleanly or
      // (b) raise the warning sooner than the 2 s background poll.
      // The check is a soft floor (Promise.race with timeout) so a
      // slow ER read can never extend the user's wait past 300 ms.
      if (requestedInlineTrigger) {
        try {
          await Promise.race([
            this.verifyPositionOpenedOnChain(targetSymbol, side),
            new Promise((_, rej) => setTimeout(() => rej(new Error('chain-truth check timed out')), 300)),
          ]);
        } catch (err) {
          // Soft signal only — bg watcher will still surface a hard
          // failure if the tx didn't land. We log to debug and move on.
          log.debug('magic-client', `inline-trigger chain-truth check soft-fail (${getErrorMessage(err)}); bg watcher will confirm`);
        }
      }
      guard.recordSigning();
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'open',
        market: targetSymbol,
        side,
        collateral: collateralAmount,
        leverage,
        sizeUsd,
        walletAddress: this.walletAddress,
        result: 'confirmed',
      });

      // Use the SDK's canonical sizeUsd (fees baked in) so card matches preview.
      const canonicalSizeUsd = Number((quote.sizeUsd as BN).toString()) / USD_POWER;
      const feeUsdNum = quote.entryFeeUsd
        ? Number((quote.entryFeeUsd as BN).toString()) / USD_POWER
        : 0;
      return {
        txSignature: sig,
        entryPrice: entryPriceForReturn,
        liquidationPrice: liqPriceForReturn,
        sizeUsd: canonicalSizeUsd,
        feeUsd: Number.isFinite(feeUsdNum) ? feeUsdNum : 0,
        // Synthesized quotes use a fixed 4 bp fee model — surface that so
        // the caller can render "≈" prefixes / footer notes instead of
        // implying it's a definitive on-chain number.
        feeIsEstimate: !quoteIsCanonical,
        lockSymbol,
        swapRequired: Boolean(quote.swapRequired),
      };
    } catch (err) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'open',
        market: targetSymbol,
        side,
        collateral: collateralAmount,
        leverage,
        walletAddress: this.walletAddress,
        result: 'failed',
        reason: getErrorMessage(err),
      });
      throw err;
    } finally {
      this.releaseTradeLock(lockKey);
    }
  }

  async closePosition(
    market: string,
    side: TradeSide,
    receiveToken?: string,
    _closePercent?: number,
    _closeAmount?: number,
  ): Promise<ClosePositionResult> {
    const targetSymbol = market.toUpperCase();
    const sdkSide = side === 'long' ? Side.Long : Side.Short;
    const { lockSymbol } = this.resolveMarket(targetSymbol, side);
    // User defaults to USDC payout; can override with receiveToken.
    const receivingSymbol = receiveToken?.toUpperCase() ?? 'USDC';

    const guard = getSigningGuard();
    const rate = guard.checkRateLimit();
    if (!rate.allowed) throw new Error(rate.reason);

    const lockKey = `${targetSymbol}:${side}`;
    this.acquireTradeLock(lockKey);

    // Capture an orphan-trigger fingerprint BEFORE the close lands.
    // The bg cancel needs a stable reference — orderId + triggerSize +
    // exponent — so it can refuse to cancel triggers that were swapped
    // out by an intervening open on the same (market, side). See
    // `cancelTriggersInBackground` for the full race-safety logic.
    const triggerSnapshot = await this.snapshotActiveTriggersForPosition(targetSymbol, side).catch(() => []);

    try {
      // No cache-hit short-circuit (see openPosition for rationale). Calling
      // close on a non-existent position errors at the program level.

      // SDK arg order: (target, lockSymbol, side, pool, receivingSymbol). The
      // 2nd arg is used by `findMarketConfig(target, lockSymbol, side)` — must
      // be the market's lock custody, NOT the user's payout token.
      //
      // Just the close ix. TP / SL cancellation runs as a background
      // tx after this resolves — keeps the user-visible close at its
      // ER-RTT floor (~60–100 ms) instead of paying for the basket
      // fetch + extra ix payload.
      const result = await this.sdk.closePosition(
        targetSymbol,
        lockSymbol,
        sdkSide,
        this.poolConfig,
        receivingSymbol,
      );

      let sig: string;
      try {
        sig = await this.sendErIxs(result.instructions, result.additionalSigners, 'magic.closePosition');
      } catch (err) {
        // FAILURE AUDIT — every signing path must record both confirmed
        // AND failed outcomes. Without this, a tx that consumed a
        // rate-limit slot leaves zero forensic trace.
        guard.logAudit({
          timestamp: new Date().toISOString(),
          type: 'close',
          market: targetSymbol,
          side,
          walletAddress: this.walletAddress,
          result: 'failed',
          reason: getErrorMessage(err),
        });
        throw err;
      }
      // Fire-and-forget cancel of any TP / SL attached to this side,
      // gated by the fingerprint snapshot we took before the close.
      // Retries 3× on failure; surfaces final-failure to user via REPL
      // writer.
      void this.cancelTriggersInBackground(targetSymbol, side, triggerSnapshot);
      guard.recordSigning();
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'close',
        market: targetSymbol,
        side,
        walletAddress: this.walletAddress,
        result: 'confirmed',
      });

      return { txSignature: sig, exitPrice: 0, pnl: 0 };
    } finally {
      this.releaseTradeLock(lockKey);
    }
  }

  async addCollateral(
    market: string,
    side: TradeSide,
    amount: number,
    /**
     * Optional override for the collateral asset. Defaults to USDC; when set
     * to a non-stable (SOL, BTC, …) the SDK swaps it to the lock asset on
     * the way in. Caller is responsible for passing a symbol that exists in
     * the active pool — this method validates and throws a typed error
     * otherwise so the user gets a clear "not in pool" message instead of an
     * SDK panic.
     */
    depositingSymbolOverride?: string,
  ): Promise<CollateralResult> {
    const targetSymbol = market.toUpperCase();
    const sdkSide = side === 'long' ? Side.Long : Side.Short;
    const { lockSymbol } = this.resolveMarket(targetSymbol, side);
    const depositingSymbol = (depositingSymbolOverride ?? 'USDC').toUpperCase();
    let depositCustody;
    try {
      depositCustody = this.poolConfig.getCustodyFromSymbol(depositingSymbol);
    } catch {
      throw new Error(
        `Collateral asset \`${depositingSymbol}\` is not in the active pool. ` +
        `Available: ${this.poolConfig.tokens.map((t) => t.symbol).join(', ')}`,
      );
    }
    // Use the deposit-token's decimals (USDC=6, SOL=9, BTC=8 etc.) — we used
    // to hard-code 6 because we always assumed USDC; that broke SOL/BTC adds
    // by 10³ / 10² respectively.
    const amountRaw = new BN(Math.floor(amount * 10 ** depositCustody.decimals));

    const guard = getSigningGuard();
    const rate = guard.checkRateLimit();
    if (!rate.allowed) throw new Error(rate.reason);

    const lockKey = `${targetSymbol}:${side}`;
    this.acquireTradeLock(lockKey);
    try {
      const result = await this.sdk.addCollateral(
        targetSymbol,
        lockSymbol,
        sdkSide,
        this.poolConfig,
        amountRaw,
        depositingSymbol,
      );
      let sig: string;
      try {
        sig = await this.sendErIxs(result.instructions, result.additionalSigners, 'magic.addCollateral');
      } catch (err) {
        guard.logAudit({
          timestamp: new Date().toISOString(),
          type: 'add_collateral',
          market: targetSymbol,
          side,
          collateral: amount,
          walletAddress: this.walletAddress,
          result: 'failed',
          reason: getErrorMessage(err),
        });
        throw err;
      }
      guard.recordSigning();
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'add_collateral',
        market: targetSymbol,
        side,
        collateral: amount,
        walletAddress: this.walletAddress,
        result: 'confirmed',
      });
      return { txSignature: sig };
    } finally {
      this.releaseTradeLock(lockKey);
    }
  }

  async removeCollateral(
    market: string,
    side: TradeSide,
    amount: number,
    /** Optional payout asset (defaults to USDC). Validated against the pool. */
    dispensingSymbolOverride?: string,
  ): Promise<CollateralResult> {
    const targetSymbol = market.toUpperCase();
    const sdkSide = side === 'long' ? Side.Long : Side.Short;
    const { lockSymbol } = this.resolveMarket(targetSymbol, side);
    const dispensingSymbol = (dispensingSymbolOverride ?? 'USDC').toUpperCase();
    try {
      this.poolConfig.getCustodyFromSymbol(dispensingSymbol);
    } catch {
      throw new Error(
        `Payout asset \`${dispensingSymbol}\` is not in the active pool. ` +
        `Available: ${this.poolConfig.tokens.map((t) => t.symbol).join(', ')}`,
      );
    }
    // remove takes USD-denominated delta (6dp).
    const amountUsd = new BN(Math.floor(amount * USD_POWER));

    const guard = getSigningGuard();
    const rate = guard.checkRateLimit();
    if (!rate.allowed) throw new Error(rate.reason);

    const lockKey = `${targetSymbol}:${side}`;
    this.acquireTradeLock(lockKey);
    try {
      const result = await this.sdk.removeCollateral(
        targetSymbol,
        lockSymbol,
        sdkSide,
        this.poolConfig,
        amountUsd,
        dispensingSymbol,
      );
      let sig: string;
      try {
        sig = await this.sendErIxs(result.instructions, result.additionalSigners, 'magic.removeCollateral');
      } catch (err) {
        guard.logAudit({
          timestamp: new Date().toISOString(),
          type: 'remove_collateral',
          market: targetSymbol,
          side,
          collateral: amount,
          walletAddress: this.walletAddress,
          result: 'failed',
          reason: getErrorMessage(err),
        });
        throw err;
      }
      guard.recordSigning();
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'remove_collateral',
        market: targetSymbol,
        side,
        collateral: amount,
        walletAddress: this.walletAddress,
        result: 'confirmed',
      });
      return { txSignature: sig };
    } finally {
      this.releaseTradeLock(lockKey);
    }
  }

  // ─── Extended trade ops (reverse, partial close, increase, triggers) ────

  /**
   * Reverse a position — close current side, open opposite side with the
   * same collateral. Two ER txs back-to-back. Returns both signatures.
   * Named `flipPosition` (not `reversePosition`) to avoid clashing with the
   * optional IFlashClient.reversePosition that has a different signature.
   */
  /**
   * Atomic reverse — close current side + open opposite side in a SINGLE tx.
   * This is what the official UI does (see ref tx 2s7qtL2KTYoK… on the ER):
   * one signature, one rate-limit charge, no race window between the two ixs.
   *
   * Falls back to two-tx `flipPosition` only if the single-tx variant is
   * rejected by the program (account size, CU limit, etc).
   */
  async reversePositionAtomic(
    market: string,
    currentSide: TradeSide,
    collateralAmount: number,
    leverage: number,
  ): Promise<{ txSignature: string; newSide: TradeSide; entryPrice: number; liquidationPrice: number; sizeUsd: number }> {
    const guard = getSigningGuard();
    const targetSymbol = market.toUpperCase();
    const collateralSymbol = 'USDC';
    const sizeUsd = collateralAmount * leverage;

    const limit = guard.checkTradeLimits({ collateral: collateralAmount, leverage, sizeUsd, market: targetSymbol });
    if (!limit.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'reverse',
        market: targetSymbol,
        side: currentSide,
        collateral: collateralAmount,
        leverage,
        sizeUsd,
        walletAddress: this.walletAddress,
        result: 'rejected',
        reason: limit.reason,
      });
      throw new Error(limit.reason);
    }
    await guard.waitForRateLimit();
    const rate = guard.checkRateLimit();
    if (!rate.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'reverse',
        market: targetSymbol,
        side: currentSide,
        walletAddress: this.walletAddress,
        result: 'rate_limited',
        reason: rate.reason,
      });
      throw new Error(rate.reason);
    }

    // Atomic reverse (close + open in same tx) is the fast path — one
    // signature, one rate-limit charge, no race window between close and
    // open. We used to pre-check `getAvailableBalances()` to decide
    // whether atomic was safe, but that read added ~150 ms cold to every
    // reverse and was redundant with the program's own preflight.
    //
    // The new approach: just attempt atomic. If the program rejects
    // with `InsufficientAvailableBalance`, fall back to the two-tx
    // `flipPosition` path. Worst case is +~50–100 ms (a failed atomic
    // submit before the fallback), but the happy path saves a full RPC
    // roundtrip every time. Most reverses are happy-path.
    //
    // The fallback is also awaited bare — its errors must propagate so
    // the user sees real causes instead of a silent half-reverse (closed
    // but not reopened).
    const tryFlipFallback = async () => {
      const flip = await this.flipPosition(market, currentSide, collateralAmount, leverage);
      const newSide: TradeSide = currentSide === TradeSide.Long ? TradeSide.Short : TradeSide.Long;
      const oraclePrice = this.cachedOraclePrice(targetSymbol)
        ?? (await this.fetchOraclePrice(targetSymbol).catch(() => 0));
      // Prefer the REAL liquidation price from the chain — the new position
      // is on-chain after `flipPosition`, so a quick getPositions() lookup
      // gives us the program-computed liq instead of the haircut estimate.
      let liq = 0;
      try {
        const positions = await this.getPositions();
        const match = positions.find((p) =>
          p.market.toUpperCase() === targetSymbol &&
          String(p.side).toLowerCase() === (newSide === TradeSide.Long ? 'long' : 'short'),
        );
        if (match && Number.isFinite(match.liquidationPrice) && match.liquidationPrice > 0) {
          liq = match.liquidationPrice;
        }
      } catch { /* fall back below */ }
      if (liq === 0 && oraclePrice > 0) {
        liq = liquidationPriceEstimate(
          oraclePrice,
          leverage,
          newSide === TradeSide.Long ? 'long' : 'short',
        );
      }
      return {
        txSignature: flip.openSig,
        newSide: flip.newSide,
        entryPrice: oraclePrice,
        liquidationPrice: liq,
        sizeUsd,
      };
    };

    const newSide: TradeSide = currentSide === TradeSide.Long ? TradeSide.Short : TradeSide.Long;
    const sdkCurrentSide = currentSide === TradeSide.Long ? Side.Long : Side.Short;
    const sdkNewSide = newSide === TradeSide.Long ? Side.Long : Side.Short;
    const closeLockSymbol = this.resolveMarket(targetSymbol, currentSide).lockSymbol;
    const openLockSymbol = this.resolveMarket(targetSymbol, newSide).lockSymbol;
    const collateralCustody = this.poolConfig.getCustodyFromSymbol(collateralSymbol);
    const targetCustody = this.poolConfig.getCustodyFromSymbol(targetSymbol);
    const collateralRaw = new BN(Math.floor(collateralAmount * 10 ** collateralCustody.decimals));
    const leverageBps = new BN(Math.round(leverage * 10_000));

    // Hot path: synthesize quote locally from the cached oracle. Skips the
    // ~300-500ms SDK simulate (`getOpenPositionQuote`) — the same shortcut
    // that makes `open` feel fast. We only fall back to the simulate if the
    // oracle isn't cached yet (first-trade-cold-start case).
    type Quote = {
      collateralAmount: BN;
      sizeAmount: BN;
      entryPrice: { price: BN; exponent: number };
      liquidationPrice: { price: BN; exponent: number };
    };
    let quote: Quote;
    const cachedOracle = this.cachedOraclePrice(targetSymbol);
    if (cachedOracle && cachedOracle > 0) {
      const sizeRaw = new BN(Math.floor((sizeUsd / cachedOracle) * 10 ** targetCustody.decimals));
      // Linear estimate from `math.ts` — invariants are property-tested.
      const liq = liquidationPriceEstimate(
        cachedOracle,
        leverage,
        newSide === TradeSide.Long ? 'long' : 'short',
      );
      quote = {
        collateralAmount: collateralRaw,
        sizeAmount: sizeRaw,
        entryPrice: { price: new BN(Math.round(cachedOracle * 1e6)), exponent: -6 },
        liquidationPrice: { price: new BN(Math.round(liq * 1e6)), exponent: -6 },
      };
    } else {
      try {
        quote = (await this.sdk.getOpenPositionQuote(
          targetSymbol,
          openLockSymbol,
          sdkNewSide,
          this.poolConfig,
          collateralRaw,
          leverageBps,
          collateralSymbol,
          null,
          null,
          null,
          this.basketPda,
        )) as unknown as Quote;
      } catch {
        const oracle = await this.fetchOraclePrice(targetSymbol, openLockSymbol, newSide);
        const sizeRaw = new BN(Math.floor((sizeUsd / oracle) * 10 ** targetCustody.decimals));
        quote = {
          collateralAmount: collateralRaw,
          sizeAmount: sizeRaw,
          entryPrice: { price: new BN(Math.round(oracle * 1e6)), exponent: -6 },
          liquidationPrice: { price: new BN(0), exponent: 0 },
        };
      }
    }

    // CRITICAL: pass 'USDC' as the receivingSymbol — without it, the SDK
    // defaults the dispensing custody to the lock custody (SOL for SOL/long,
    // BTC for BTC/long, etc.) and the user gets paid out in that asset
    // instead of stable. Reverse should always settle the closed leg in USDC.
    //
    // Build close + open in parallel (independent ix construction).
    // The trigger-cancellation is NOT included in the atomic bundle —
    // it's fired as a background tx after the foreground reverse
    // confirms. Two reasons:
    //
    //   1. Atomic close+open+cancel runs ~5+ ixs in one tx, which
    //      pushes ER validation latency from ~200 ms to ~400–500 ms.
    //   2. The user-visible action is "your position is now flipped" —
    //      orphan TP/SL on the closed side don't affect the new
    //      position's state until they would fire (price-driven).
    //      A 200 ms window where they exist is acceptable.
    //
    // The background tx retries up to 3× on failure. If all retries
    // fail, the next close on the same market will catch + cancel the
    // orphans (closePosition has its own bundled cancel pass).
    //
    // Snapshot triggers BEFORE the atomic tx fires — fingerprint is
    // captured against the OLD position so the bg cancel can never
    // clip the NEW side's freshly-attached triggers.
    const [closeIxs, openIxs, triggerSnapshot] = await Promise.all([
      this.sdk.closePosition(targetSymbol, closeLockSymbol, sdkCurrentSide, this.poolConfig, 'USDC'),
      this.sdk.openPosition(
        targetSymbol,
        openLockSymbol,
        collateralSymbol,
        sdkNewSide,
        this.poolConfig,
        quote.collateralAmount as BN,
        quote.sizeAmount as BN,
      ),
      this.snapshotActiveTriggersForPosition(targetSymbol, currentSide).catch(() => [] as TriggerFingerprint[]),
    ]);
    const ixs = [...closeIxs.instructions, ...openIxs.instructions];
    const additionalSigners = [...closeIxs.additionalSigners, ...openIxs.additionalSigners];
    const lockKey = `${targetSymbol}:reverse`;
    this.acquireTradeLock(lockKey);
    let atomicSig: string | null = null;
    try {
      try {
        atomicSig = await this.sendErIxs(ixs, additionalSigners, 'magic.reverseAtomic');
      } catch (err) {
        // The program rejected the atomic close+open in a single tx —
        // typically because the freed collateral is parked in
        // `pendingCredits` and the open's preflight reads `available`
        // before the close's effect propagates. Fall back to the slower
        // two-tx path. Any other error propagates.
        const msg = err instanceof Error ? err.message : String(err);
        if (/InsufficientAvailableBalance|insufficient.*balance/i.test(msg)) {
          log.info('magic-client', `reverse atomic rejected (${msg}); falling back to two-tx flip`);
          // Release the lock BEFORE the fallback acquires its own.
          this.releaseTradeLock(lockKey);
          return await tryFlipFallback();
        }
        throw err;
      }
      // Fire-and-forget background cancel of the OLD side's TP / SL
      // triggers. Off the user-visible critical path (the reverse
      // success card renders immediately when atomicSig resolves).
      // Retries up to 3× on failure; closePosition has its own bundled
      // cancel pass which will catch any survivors next time the user
      // touches this market.
      void this.cancelTriggersInBackground(targetSymbol, currentSide, triggerSnapshot);
      guard.recordSigning();
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'reverse',
        market: targetSymbol,
        side: newSide,
        collateral: collateralAmount,
        leverage,
        sizeUsd,
        walletAddress: this.walletAddress,
        result: 'confirmed',
        txSignature: atomicSig,
      });
      return {
        txSignature: atomicSig,
        newSide,
        entryPrice: priceToNumber(quote.entryPrice),
        liquidationPrice: priceToNumber(quote.liquidationPrice),
        sizeUsd,
      };
    } finally {
      // Only release if we still hold it — the fallback path released early.
      if (atomicSig !== null || this.activeTrades.has(lockKey)) {
        try { this.releaseTradeLock(lockKey); } catch { /* already released */ }
      }
    }
  }

  /**
   * Two-tx position flip — close the current side, then open the opposite
   * side. Slower than `reversePositionAtomic` (~1.5s vs 0.3s) but always
   * lands when the atomic path is unavailable. Used as the load-bearing
   * fallback inside `reversePositionAtomic` itself, so it is NOT
   * deprecated and SHOULD remain part of the public surface.
   */
  async flipPosition(
    market: string,
    currentSide: TradeSide,
    collateralAmount: number,
    leverage: number,
  ): Promise<{ closeSig: string; openSig: string; newSide: TradeSide }> {
    const guard = getSigningGuard();
    await guard.waitForRateLimit();
    const closeResult = await this.closePosition(market, currentSide);
    const newSide = currentSide === TradeSide.Long ? TradeSide.Short : TradeSide.Long;
    await guard.waitForRateLimit();
    const openResult = await this.openPosition(market, newSide, collateralAmount, leverage);
    return { closeSig: closeResult.txSignature, openSig: openResult.txSignature, newSide };
  }

  /**
   * Partial close — reduce position size by `closeUsd` USD (or by percent of
   * current size). Uses SDK's decreasePositionSize. Position remains open
   * with the residual size.
   */
  async decreasePosition(
    market: string,
    side: TradeSide,
    closeUsd: number,
    receiveToken = 'USDC',
  ): Promise<{ txSignature: string }> {
    const targetSymbol = market.toUpperCase();
    const sdkSide = side === TradeSide.Long ? Side.Long : Side.Short;
    const { lockSymbol } = this.resolveMarket(targetSymbol, side);
    const targetCustody = this.poolConfig.getCustodyFromSymbol(targetSymbol);

    // Convert USD delta to target-token raw via current oracle price.
    const oraclePrice = await this.fetchOraclePrice(targetSymbol, lockSymbol, side);
    if (!Number.isFinite(oraclePrice) || oraclePrice <= 0) {
      throw new Error(`[magic-mode] could not fetch ${targetSymbol} oracle for partial close`);
    }
    const sizeDeltaRaw = new BN(Math.floor((closeUsd / oraclePrice) * 10 ** targetCustody.decimals));

    const guard = getSigningGuard();
    const rate = guard.checkRateLimit();
    if (!rate.allowed) throw new Error(rate.reason);

    const lockKey = `${targetSymbol}:${side}`;
    this.acquireTradeLock(lockKey);
    try {
      const result = await this.sdk.decreasePositionSize(
        targetSymbol,
        lockSymbol,
        sdkSide,
        this.poolConfig,
        sizeDeltaRaw,
        receiveToken.toUpperCase(),
      );
      let sig: string;
      try {
        sig = await this.sendErIxs(result.instructions, result.additionalSigners, 'magic.decrease');
      } catch (err) {
        guard.logAudit({
          timestamp: new Date().toISOString(),
          type: 'partial_close',
          market: targetSymbol,
          side,
          sizeUsd: closeUsd,
          walletAddress: this.walletAddress,
          result: 'failed',
          reason: getErrorMessage(err),
        });
        throw err;
      }
      guard.recordSigning();
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'partial_close',
        market: targetSymbol,
        side,
        sizeUsd: closeUsd,
        walletAddress: this.walletAddress,
        result: 'confirmed',
      });
      return { txSignature: sig };
    } finally {
      this.releaseTradeLock(lockKey);
    }
  }

  /**
   * Increase position size — adds `addUsd` of additional size at current
   * oracle price, optionally adding more collateral via `addCollateralUsd`.
   * Uses SDK's increasePositionSize.
   */
  async increasePosition(
    market: string,
    side: TradeSide,
    addUsd: number,
    addCollateralUsd = 0,
    collateralToken = 'USDC',
  ): Promise<{ txSignature: string }> {
    const targetSymbol = market.toUpperCase();
    const sdkSide = side === TradeSide.Long ? Side.Long : Side.Short;
    const { lockSymbol } = this.resolveMarket(targetSymbol, side);
    const targetCustody = this.poolConfig.getCustodyFromSymbol(targetSymbol);
    // The SDK's `increasePositionSize` interprets `colRaw` in the LOCK
    // custody's decimals (the existing position's collateral leg), NOT in the
    // `collateralToken` arg. Using the wrong custody here was a 1000× scaling
    // bug for non-USDC-locked markets (SOL/long, BTC/long, ETH/long): a
    // user adding "$50 collateral" sent ~$0.05 worth of lamports because
    // `colCustody.decimals` was 6 (USDC) while the chain expected 9 (SOL).
    const lockCustody = this.poolConfig.getCustodyFromSymbol(lockSymbol);

    const oraclePrice = await this.fetchOraclePrice(targetSymbol, lockSymbol, side);
    if (!Number.isFinite(oraclePrice) || oraclePrice <= 0) {
      throw new Error(`[magic-mode] could not fetch ${targetSymbol} oracle for increase`);
    }
    const sizeDeltaRaw = new BN(Math.floor((addUsd / oraclePrice) * 10 ** targetCustody.decimals));

    // Convert `addCollateralUsd` (USD) to lock-custody raw units. For a stable
    // lock (USDC/USDT) this is just USD × 10^decimals. For a non-stable lock
    // (SOL/BTC/ETH) we must price the lock token against USD via its oracle.
    let colRaw: BN;
    if (addCollateralUsd <= 0) {
      colRaw = new BN(0);
    } else if (lockCustody.isStable) {
      colRaw = new BN(Math.floor(addCollateralUsd * 10 ** lockCustody.decimals));
    } else {
      // Lock is e.g. SOL — fetch SOL/USD to convert. fetchOraclePrice with
      // (sym, sym) returns the symbol's spot.
      const lockPrice = await this.fetchOraclePrice(lockSymbol, lockSymbol, side).catch(() => NaN);
      if (!Number.isFinite(lockPrice) || lockPrice <= 0) {
        throw new Error(
          `[magic-mode] cannot price ${lockSymbol} (lock token) for non-stable collateral conversion. ` +
          `Try setting addCollateralUsd=0 to keep current collateral, or open a new position via 'open' instead.`,
        );
      }
      colRaw = new BN(Math.floor((addCollateralUsd / lockPrice) * 10 ** lockCustody.decimals));
    }
    void collateralToken; // currently informational; SDK derives the lock custody itself

    // Defense-in-depth: increasing a position grows risk, so it must respect
    // the same per-trade size/leverage caps that gate `openPosition`. We use
    // the inferred leverage of the increment (size delta / collateral added);
    // when no extra collateral is added, leverage is undefined and we cap on
    // size only.
    const incLeverage = addCollateralUsd > 0 ? addUsd / addCollateralUsd : 0;
    const guard = getSigningGuard();
    const limit = guard.checkTradeLimits({
      collateral: addCollateralUsd,
      leverage: incLeverage,
      sizeUsd: addUsd,
      market: targetSymbol,
    });
    if (!limit.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'increase',
        market: targetSymbol,
        side,
        collateral: addCollateralUsd,
        leverage: incLeverage,
        sizeUsd: addUsd,
        walletAddress: this.walletAddress,
        result: 'rejected',
        reason: limit.reason,
      });
      throw new Error(limit.reason);
    }
    const rate = guard.checkRateLimit();
    if (!rate.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'increase',
        market: targetSymbol,
        side,
        walletAddress: this.walletAddress,
        result: 'rate_limited',
        reason: rate.reason,
      });
      throw new Error(rate.reason);
    }

    const lockKey = `${targetSymbol}:${side}`;
    this.acquireTradeLock(lockKey);
    try {
      const result = await this.sdk.increasePositionSize(
        targetSymbol,
        lockSymbol,
        sdkSide,
        this.poolConfig,
        sizeDeltaRaw,
        colRaw,
      );
      try {
        const sig = await this.sendErIxs(result.instructions, result.additionalSigners, 'magic.increase');
        guard.recordSigning();
        guard.logAudit({
          timestamp: new Date().toISOString(),
          type: 'increase',
          market: targetSymbol,
          side,
          collateral: addCollateralUsd,
          leverage: incLeverage,
          sizeUsd: addUsd,
          walletAddress: this.walletAddress,
          result: 'confirmed',
          txSignature: sig,
        });
        return { txSignature: sig };
      } catch (err) {
        guard.logAudit({
          timestamp: new Date().toISOString(),
          type: 'increase',
          market: targetSymbol,
          side,
          walletAddress: this.walletAddress,
          result: 'failed',
          reason: getErrorMessage(err),
        });
        throw err;
      }
    } finally {
      this.releaseTradeLock(lockKey);
    }
  }

  /**
   * Place a TP or SL trigger order on an open position.
   * triggerPrice = USD level. isStopLoss = true for SL, false for TP.
   * deltaSizeUsd = how much of the position to close at trigger (default = full).
   */
  async placeTrigger(
    market: string,
    side: TradeSide,
    triggerPriceUsd: number,
    isStopLoss: boolean,
    deltaSizeUsd?: number,
  ): Promise<{ txSignature: string }> {
    const targetSymbol = market.toUpperCase();
    const sdkSide = side === TradeSide.Long ? Side.Long : Side.Short;
    const { lockSymbol } = this.resolveMarket(targetSymbol, side);
    const targetCustody = this.poolConfig.getCustodyFromSymbol(targetSymbol);

    const oraclePrice = await this.fetchOraclePrice(targetSymbol, lockSymbol, side);
    const fullSize = (await this.getPortfolio()).positions.find(
      (p) => p.market.toUpperCase() === targetSymbol && p.side === side,
    )?.sizeUsd;
    const closeUsd = deltaSizeUsd ?? fullSize ?? 0;
    if (closeUsd <= 0) throw new Error('[magic-mode] no open position to attach trigger to (or zero size)');
    const deltaSizeRaw = new BN(Math.floor((closeUsd / oraclePrice) * 10 ** targetCustody.decimals));

    const guard = getSigningGuard();
    const rate = guard.checkRateLimit();
    if (!rate.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'limit_order',
        market: targetSymbol,
        side,
        walletAddress: this.walletAddress,
        result: 'rate_limited',
        reason: `${isStopLoss ? 'stop_loss' : 'take_profit'}: ${rate.reason}`,
      });
      throw new Error(rate.reason);
    }

    const result = await this.sdk.placeTriggerOrder(
      targetSymbol,
      lockSymbol,
      sdkSide,
      this.poolConfig,
      {
        triggerPrice: this.usdToOraclePrice(targetSymbol, triggerPriceUsd),
        deltaSizeAmount: deltaSizeRaw,
        isStopLoss,
      } as unknown as PlaceTriggerOrderParams,
    );
    try {
      const sig = await this.sendErIxs(result.instructions, result.additionalSigners, isStopLoss ? 'magic.sl' : 'magic.tp');
      guard.recordSigning();
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'limit_order',
        market: targetSymbol,
        side,
        sizeUsd: closeUsd,
        walletAddress: this.walletAddress,
        result: 'confirmed',
        txSignature: sig,
        reason: isStopLoss ? 'stop_loss' : 'take_profit',
      });
      return { txSignature: sig };
    } catch (err) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'limit_order',
        market: targetSymbol,
        side,
        walletAddress: this.walletAddress,
        result: 'failed',
        reason: getErrorMessage(err),
      });
      throw err;
    }
  }

  /** Place a limit order. Fills automatically when oracle hits limitPriceUsd. */
  async placeLimit(
    market: string,
    side: TradeSide,
    limitPriceUsd: number,
    collateralUsd: number,
    leverage: number,
    tpUsd?: number,
    slUsd?: number,
    collateralToken = 'USDC',
  ): Promise<{ txSignature: string }> {
    const targetSymbol = market.toUpperCase();
    const sdkSide = side === TradeSide.Long ? Side.Long : Side.Short;
    const { lockSymbol } = this.resolveMarket(targetSymbol, side);
    const targetCustody = this.poolConfig.getCustodyFromSymbol(targetSymbol);
    const colCustody = this.poolConfig.getCustodyFromSymbol(collateralToken.toUpperCase());

    const collateralRaw = new BN(Math.floor(collateralUsd * 10 ** colCustody.decimals));
    const sizeUsd = collateralUsd * leverage;
    const sizeRaw = new BN(Math.floor((sizeUsd / limitPriceUsd) * 10 ** targetCustody.decimals));

    // Defense-in-depth: limit orders create future positions; the same per-trade
    // caps that gate `openPosition` must apply here so a typo can't size a
    // resting order beyond the user's configured ceilings.
    const guard = getSigningGuard();
    const limit = guard.checkTradeLimits({ collateral: collateralUsd, leverage, sizeUsd, market: targetSymbol });
    if (!limit.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'limit_order',
        market: targetSymbol,
        side,
        collateral: collateralUsd,
        leverage,
        sizeUsd,
        walletAddress: this.walletAddress,
        result: 'rejected',
        reason: limit.reason,
      });
      throw new Error(limit.reason);
    }
    const rate = guard.checkRateLimit();
    if (!rate.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'limit_order',
        market: targetSymbol,
        side,
        walletAddress: this.walletAddress,
        result: 'rate_limited',
        reason: rate.reason,
      });
      throw new Error(rate.reason);
    }

    // Force a live oracle read so we have the chain's exponent cached for the
    // serialization that follows. Limit orders typically run for non-crypto
    // markets where -8 is wrong (equities/FX often use -5/-4); without this
    // pre-warm a brand-new symbol would default to -8 and serialize garbage.
    try { await this.fetchOraclePrice(targetSymbol, lockSymbol, side); } catch { /* fall back to -8 */ }

    const result = await this.sdk.placeLimitOrder(
      targetSymbol,
      lockSymbol,
      sdkSide,
      this.poolConfig,
      {
        limitPrice: this.usdToOraclePrice(targetSymbol, limitPriceUsd),
        collateralAmount: collateralRaw,
        sizeAmount: sizeRaw,
        takeProfitPrice: tpUsd ? this.usdToOraclePrice(targetSymbol, tpUsd) : this.usdToOraclePrice(targetSymbol, 0),
        stopLossPrice: slUsd ? this.usdToOraclePrice(targetSymbol, slUsd) : this.usdToOraclePrice(targetSymbol, 0),
      } as unknown as PlaceLimitOrderParams,
      collateralToken.toUpperCase(),
    );
    try {
      const sig = await this.sendErIxs(result.instructions, result.additionalSigners, 'magic.placeLimit');
      guard.recordSigning();
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'limit_order',
        market: targetSymbol,
        side,
        collateral: collateralUsd,
        leverage,
        sizeUsd,
        walletAddress: this.walletAddress,
        result: 'confirmed',
        txSignature: sig,
      });
      return { txSignature: sig };
    } catch (err) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'limit_order',
        market: targetSymbol,
        side,
        walletAddress: this.walletAddress,
        result: 'failed',
        reason: getErrorMessage(err),
      });
      throw err;
    }
  }

  /** Cancel a limit order (sets limit_price and size_amount to 0 via edit). */
  async cancelLimit(
    market: string,
    side: TradeSide,
    orderId: number,
    collateralToken = 'USDC',
  ): Promise<{ txSignature: string }> {
    const targetSymbol = market.toUpperCase();
    const sdkSide = side === TradeSide.Long ? Side.Long : Side.Short;
    const { lockSymbol } = this.resolveMarket(targetSymbol, side);
    const result = await this.sdk.editLimitOrder(
      targetSymbol,
      lockSymbol,
      sdkSide,
      this.poolConfig,
      {
        orderId,
        // All-zero "cancel sentinel" — exponent doesn't matter at value=0.
        limitPrice: this.usdToOraclePrice(targetSymbol, 0),
        sizeAmount: new BN(0),
        stopLossPrice: this.usdToOraclePrice(targetSymbol, 0),
        takeProfitPrice: this.usdToOraclePrice(targetSymbol, 0),
      } as unknown as EditLimitOrderParams,
      collateralToken.toUpperCase(),
    );
    const guardCancel = getSigningGuard();
    const rateCancel = guardCancel.checkRateLimit();
    if (!rateCancel.allowed) throw new Error(rateCancel.reason);
    try {
      const sig = await this.sendErIxs(result.instructions, result.additionalSigners, 'magic.cancelLimit');
      guardCancel.recordSigning();
      guardCancel.logAudit({
        timestamp: new Date().toISOString(),
        type: 'cancel_order',
        market: targetSymbol,
        side,
        walletAddress: this.walletAddress,
        result: 'confirmed',
        txSignature: sig,
      });
      return { txSignature: sig };
    } catch (err) {
      guardCancel.logAudit({
        timestamp: new Date().toISOString(),
        type: 'cancel_order',
        market: targetSymbol,
        side,
        walletAddress: this.walletAddress,
        result: 'failed',
        reason: getErrorMessage(err),
      });
      throw err;
    }
  }

  /**
   * Snapshot every active TP / SL slot attached to the position on
   * (market, side) AT THE TIME OF CALL. Returns a list of fingerprints
   * — `(market, orderId, isStopLoss, triggerSize, triggerPrice)` —
   * which `cancelTriggersInBackground` then uses to cancel ONLY those
   * specific triggers, even if a follow-up open re-occupies the same
   * orderId slot.
   *
   * Why: the original bg-cancel design re-read the basket at cancel
   * time, found whatever triggers existed at that moment, and queued
   * cancels by orderId. If the user re-opened the same (market, side)
   * within the few hundred ms it took the bg tx to land, the new
   * position's freshly-attached triggers occupied the same orderIds —
   * and the bg cancel tx silently destroyed them. Race confirmed by
   * two independent audit passes.
   *
   * Fingerprint matching closes that race: the bg cancel only fires
   * if the trigger at orderId STILL has the same triggerSize +
   * triggerPrice. Any trigger that's been replaced or modified is
   * skipped.
   *
   * IDL shape (`Order`):
   *   stop_loss_orders:   Vec<TriggerOrder>
   *   take_profit_orders: Vec<TriggerOrder>
   *
   *   TriggerOrder { trigger_price: OraclePrice; trigger_size: u64; receive_custody_uid: u8 }
   *
   * Anchor decodes snake_case → camelCase, so we read `triggerSize` /
   * `triggerPrice` (not `sizeAmount` — the bug we fixed in 0.3.2).
   *
   * NOTE on per-side: `Order` is per-MARKET, not per-(market, side).
   * Both long and short triggers on the same market live in the same
   * arrays — the program doesn't expose a side discriminator for
   * trigger orders. We snapshot all triggers on the market; the
   * fingerprint is what makes the cancel side-specific in practice
   * (a long's TP at $100 has a different size than a short's TP at $90).
   */
  private async snapshotActiveTriggersForPosition(
    targetSymbol: string,
    side: TradeSide,
  ): Promise<TriggerFingerprint[]> {
    const basket = (await this.fetchBasket().catch(() => null)) as BasketShape | null;
    if (!basket?.orders) return [];
    void side; // documented above
    const out: TriggerFingerprint[] = [];
    for (const slot of basket.orders) {
      const cfg = this.poolConfig.markets.find((m) => m.marketAccount.equals(slot.market));
      if (!cfg) continue;
      const tgt = this.poolConfig.custodies.find((cu) => cu.custodyAccount.equals(cfg.targetCustody));
      if (tgt?.symbol !== targetSymbol) continue;

      const fingerprint = (o: TriggerOrderShape, orderId: number, isStopLoss: boolean): TriggerFingerprint | null => {
        const sz = o.triggerSize;
        if (!sz || (typeof sz.isZero === 'function' && sz.isZero())) return null;
        return {
          market: slot.market,
          orderId,
          isStopLoss,
          triggerSizeRaw: sz.toString(),
          triggerPriceRaw: o.triggerPrice?.price?.toString() ?? '0',
          triggerPriceExponent: o.triggerPrice?.exponent ?? -8,
        };
      };

      const tpArr = slot.order.takeProfitOrders ?? [];
      for (let i = 0; i < tpArr.length; i++) {
        const fp = fingerprint(tpArr[i], i, false);
        if (fp) out.push(fp);
      }
      const slArr = slot.order.stopLossOrders ?? [];
      for (let i = 0; i < slArr.length; i++) {
        const fp = fingerprint(slArr[i], i, true);
        if (fp) out.push(fp);
      }
    }
    return out;
  }

  /**
   * Race-safe background cancellation of orphan TP / SL triggers.
   *
   * Compared to the previous "fire-and-forget read+cancel" design, this:
   *   1. Cancels ONLY triggers that still match a captured fingerprint,
   *      so a follow-up open's triggers can never be clipped.
   *   2. Goes through the rate-limiter (`guard.checkRateLimit`) and
   *      audit log on both confirmed AND failed paths.
   *   3. Surfaces final-failure (after 3 retries) to the user via
   *      `replSafeWrite` so an orphan that survives is visible, not
   *      silently lost in a debug log.
   *
   * Three retries with 200 / 400 / 800 ms backoff. Detached — caller
   * should `void` this promise.
   */
  private async cancelTriggersInBackground(
    targetSymbol: string,
    side: TradeSide,
    expectedFingerprints: TriggerFingerprint[],
  ): Promise<void> {
    if (expectedFingerprints.length === 0) return;
    const guard = getSigningGuard();

    const attempt = async (n: number): Promise<void> => {
      try {
        // Re-fetch the basket and verify each fingerprint still matches.
        // Triggers whose size/price changed between snapshot and now are
        // skipped — they're someone else's now.
        const basket = (await this.fetchBasket()) as BasketShape | null;
        const stillLive = matchFingerprints(basket, expectedFingerprints);
        if (stillLive.length === 0) {
          log.debug('magic-client', `bg cancel-triggers: all expected triggers already gone (market=${targetSymbol})`);
          return;
        }

        const rate = guard.checkRateLimit();
        if (!rate.allowed) throw new Error(rate.reason);

        const cancelBundles = await Promise.all(stillLive.map(async (fp) => {
          const args = {
            market: fp.market,
            orderId: fp.orderId,
            isStopLoss: fp.isStopLoss,
          } as unknown as CancelTriggerOrderParams;
          return this.sdk.cancelTriggerOrder(this.poolConfig, args);
        }));
        const ixs = cancelBundles.flatMap((c) => c.instructions);
        const signers = cancelBundles.flatMap((c) => c.additionalSigners);

        const sig = await this.sendErIxs(ixs, signers, `magic.bgCancelTriggers.${targetSymbol}`);
        guard.recordSigning();
        guard.logAudit({
          timestamp: new Date().toISOString(),
          type: 'cancel_order',
          market: targetSymbol,
          side,
          walletAddress: this.walletAddress,
          result: 'confirmed',
          txSignature: sig,
          reason: `bg cleanup of ${stillLive.length} orphan trigger(s)`,
        });
        log.debug('magic-client', `bg cancel-triggers landed for ${targetSymbol}: ${stillLive.length} cancelled`);
      } catch (err) {
        if (n >= 3) {
          guard.logAudit({
            timestamp: new Date().toISOString(),
            type: 'cancel_order',
            market: targetSymbol,
            side,
            walletAddress: this.walletAddress,
            result: 'failed',
            reason: `bg cleanup failed after 3 attempts: ${getErrorMessage(err)}`,
          });
          // Surface to user — orphans may still be live and could fire
          // on a future position. Visible warning beats a silent debug log.
          try {
            const { replSafeWrite } = await import('../cli/repl-write.js');
            replSafeWrite(
              `  ⚠  Could not auto-cancel ${expectedFingerprints.length} orphan TP/SL on ${targetSymbol}. ` +
              `Run \`orders\` to inspect, \`cancel all\` to clean up.`,
            );
          } catch { /* REPL not active in agent / one-shot — log only */ }
          log.warn('magic-client', `bg cancel-triggers failed after 3 attempts for ${targetSymbol}: ${getErrorMessage(err)}`);
          return;
        }
        const backoff = 200 * Math.pow(2, n - 1);
        await new Promise((r) => setTimeout(r, backoff));
        await attempt(n + 1);
      }
    };
    attempt(1).catch(() => { /* nested handler swallows */ });
  }

  /** Cancel a TP/SL trigger order by id. */
  async cancelTrigger(
    market: string,
    orderId: number,
    isStopLoss: boolean,
  ): Promise<{ txSignature: string }> {
    const targetSymbol = market.toUpperCase();
    const targetCustody = this.poolConfig.getCustodyFromSymbol(targetSymbol);
    const marketAccount = this.poolConfig.markets.find((m) => m.targetCustody.equals(targetCustody.custodyAccount))?.marketAccount;
    if (!marketAccount) throw new Error(`No market for ${targetSymbol}`);

    const result = await this.sdk.cancelTriggerOrder(this.poolConfig, {
      market: marketAccount,
      orderId,
      isStopLoss,
    } as unknown as CancelTriggerOrderParams);
    const guardCancelTrig = getSigningGuard();
    const rateCancelTrig = guardCancelTrig.checkRateLimit();
    if (!rateCancelTrig.allowed) throw new Error(rateCancelTrig.reason);
    try {
      const sig = await this.sendErIxs(result.instructions, result.additionalSigners, 'magic.cancelTrigger');
      guardCancelTrig.recordSigning();
      guardCancelTrig.logAudit({
        timestamp: new Date().toISOString(),
        type: 'cancel_order',
        market: targetSymbol,
        walletAddress: this.walletAddress,
        result: 'confirmed',
        txSignature: sig,
        reason: isStopLoss ? 'stop_loss' : 'take_profit',
      });
      return { txSignature: sig };
    } catch (err) {
      guardCancelTrig.logAudit({
        timestamp: new Date().toISOString(),
        type: 'cancel_order',
        market: targetSymbol,
        walletAddress: this.walletAddress,
        result: 'failed',
        reason: getErrorMessage(err),
      });
      throw err;
    }
  }

  /** Liquidate someone else's underwater position. Earns liquidator fee. */
  async liquidatePosition(
    positionOwner: PublicKey,
    market: string,
    side: TradeSide,
  ): Promise<{ txSignature: string }> {
    const targetSymbol = market.toUpperCase();
    const sdkSide = side === TradeSide.Long ? Side.Long : Side.Short;
    const { lockSymbol } = this.resolveMarket(targetSymbol, side);
    const result = await this.sdk.liquidatePosition(
      positionOwner,
      targetSymbol,
      lockSymbol,
      sdkSide,
      this.poolConfig,
    );
    const guardLiq = getSigningGuard();
    const rateLiq = guardLiq.checkRateLimit();
    if (!rateLiq.allowed) throw new Error(rateLiq.reason);
    try {
      const sig = await this.sendErIxs(result.instructions, result.additionalSigners, 'magic.liquidate');
      guardLiq.recordSigning();
      guardLiq.logAudit({
        timestamp: new Date().toISOString(),
        type: 'liquidate',
        market: targetSymbol,
        side,
        walletAddress: this.walletAddress,
        result: 'confirmed',
        txSignature: sig,
        reason: `target=${positionOwner.toBase58()}`,
      });
      return { txSignature: sig };
    } catch (err) {
      guardLiq.logAudit({
        timestamp: new Date().toISOString(),
        type: 'liquidate',
        market: targetSymbol,
        side,
        walletAddress: this.walletAddress,
        result: 'failed',
        reason: getErrorMessage(err),
      });
      throw err;
    }
  }

  // ─── L1 setup (basket / UDL / delegate / deposit) ─────────────────────────

  async initializeUserDepositLedger(): Promise<string | 'already_initialised'> {
    const existing = await this.sdk.accounts.fetchUserDepositLedger(this.wallet.publicKey).catch(() => null);
    if (existing) return 'already_initialised';
    const result = await this.sdk.initializeUserDepositLedger();
    return this.sendL1Ixs(result.instructions, result.additionalSigners, 'magic.initUDL');
  }

  async initializeBasket(): Promise<string | 'already_initialised'> {
    const existing = await this.sdk.accounts.fetchBasket(this.wallet.publicKey).catch(() => null);
    if (existing) return 'already_initialised';
    const result = await this.sdk.initializeBasket();
    return this.sendL1Ixs(result.instructions, result.additionalSigners, 'magic.initBasket');
  }

  async delegateBasket(commitFrequencySec = 300): Promise<string> {
    // The validator key for delegation is provided by the ER router. We use a
    // sensible default — the SDK's delegateBasket accepts a DelegateConfig.
    const validatorKey = await this.fetchClosestValidatorKey();
    const result = await this.sdk.delegateBasket(this.wallet.publicKey, {
      commitFrequency: commitFrequencySec,
      validatorKey,
    });
    return this.sendL1Ixs(result.instructions, result.additionalSigners, 'magic.delegateBasket');
  }

  async depositDirect(tokenMint: PublicKey, amountRaw: bigint): Promise<string> {
    try {
      const result = await this.sdk.depositDirect(tokenMint, new BN(amountRaw.toString()));
      return await this.sendL1Ixs(result.instructions, result.additionalSigners, 'magic.depositDirect');
    } catch (err) {
      throw toTradingError(err, 'deposit');
    }
  }

  /**
   * Read the ER's view of the basket (where openPosition actually executes).
   * L1's basket is the latest committed snapshot — the ER state is "live" and
   * what the program checks at trade time.
   */
  private get erAccounts(): { fetchBasket: (owner: PublicKey) => Promise<unknown>; fetchUserDepositLedger: (owner: PublicKey) => Promise<unknown> } {
    const sdkAny = this.sdk as unknown as {
      erAccounts: { fetchBasket: (owner: PublicKey) => Promise<unknown>; fetchUserDepositLedger: (owner: PublicKey) => Promise<unknown> } | null;
      accounts: { fetchBasket: (owner: PublicKey) => Promise<unknown>; fetchUserDepositLedger: (owner: PublicKey) => Promise<unknown> };
    };
    return sdkAny.erAccounts ?? sdkAny.accounts;
  }

  /**
   * Settle a custody's pending credits/debits — TWO-STEP flow:
   *   1. L1: requestCustodySettlementWithAction
   *      Creates the settlementReceipt PDA and commits ER state to L1.
   *   2. ER: processCustodySettlementEr
   *      Reads the receipt and drains matched debit/credit pairs from the
   *      basket into UDL deposits.
   *
   * Doing only step 2 fails with `AccountDiscriminatorNotFound` because the
   * settlementReceipt doesn't exist yet — that's why my earlier single-step
   * implementation always failed with InvalidWritableAccount.
   *
   * Returns the ER signature (the one that actually drains the balance).
   */
  async settleCustody(custodySymbol: string): Promise<string> {
    try {
      // Step 1 — L1 request: create the settlementReceipt + commit ER state.
      const validatorKey = await this.fetchClosestValidatorKey().catch(() => this.wallet.publicKey);
      const requestResult = await this.sdk.requestCustodySettlementWithAction(custodySymbol, this.poolConfig, {
        commitFrequency: 300,
        validatorKey,
      });
      await this.sendL1Ixs(requestResult.instructions, requestResult.additionalSigners, `magic.settleRequest.${custodySymbol}`);

      // Composite op: rate-limit cooldown between legs so the second send
      // doesn't get refused by the per-process rate-limit gate.
      await getSigningGuard().waitForRateLimit();

      // Step 2 — L1 execute: drain the receipt back into the user's UDL.
      // We use the SDK's low-level `executeCustodySettlementBaseChain` ix
      // builder directly. The previous code routed the second leg via
      // `processCustodySettlementEr` (ER side), which the on-chain program
      // doesn't expose — it returned 3001 InstructionFallbackNotFound and
      // left funds stuck in pendingCredits. The L1 path (executeCustody-
      // SettlementBaseChain) is the same ix `executeWithdrawalBaseChain`
      // bundles internally for the bundled-settle path, so it's
      // battle-tested.
      const custody = this.poolConfig.getCustodyFromSymbol(custodySymbol);
      const tok = this.poolConfig.tokens.find((t) => t.symbol === custodySymbol);
      const tokenProgramId = tok?.isToken2022
        ? new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
        : new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      // Reach into the SDK's low-level instruction builder. Lazy-imported so
      // a future SDK that renames / removes the export degrades gracefully
      // (caller catches and surfaces a hint).
      const ixModule = await import('@flash_trade/magic-trade-client/dist/instructions/executeCustodySettlementBaseChain.js')
        .catch(() => null);
      if (!ixModule || typeof ixModule.executeCustodySettlementBaseChain !== 'function') {
        throw new Error(
          'Settle path requires SDK\'s `executeCustodySettlementBaseChain` ix builder, which is missing or moved. ' +
          'Run `npm update @flash_trade/magic-trade-client` and retry.',
        );
      }
      const program = (this.sdk as unknown as { program: Parameters<typeof ixModule.executeCustodySettlementBaseChain>[0] }).program;
      const settleIx = await ixModule.executeCustodySettlementBaseChain(
        program,
        this.wallet.publicKey,
        this.poolConfig.poolId,
        custody.custodyId,
        custody.custodyAccount,
        custody.mintKey,
        tokenProgramId,
      );
      return await this.sendL1Ixs([settleIx], [], `magic.settleExecute.${custodySymbol}`);
    } catch (err) {
      throw toTradingError(err, 'settle');
    }
  }

  /**
   * Settle all custodies that currently have pending credits/debits in the
   * user's basket. Returns one signature per settled custody.
   */
  async settleAll(): Promise<Array<{ symbol: string; sig: string | null; err?: string }>> {
    // Read from ER — the basket on L1 is the last-committed snapshot, not live state.
    const basket = (await this.erAccounts.fetchBasket(this.wallet.publicKey).catch(() => null)) as
      | { debits?: Array<{ mint: PublicKey; amount: BN }>; pendingCredits?: Array<{ mint: PublicKey; amount: BN }> }
      | null;
    const symbols = new Set<string>();
    for (const e of basket?.debits ?? []) {
      const sym = this.poolConfig.custodies.find((c) => c.mintKey.equals(e.mint))?.symbol;
      if (sym) symbols.add(sym);
    }
    for (const e of basket?.pendingCredits ?? []) {
      const sym = this.poolConfig.custodies.find((c) => c.mintKey.equals(e.mint))?.symbol;
      if (sym) symbols.add(sym);
    }
    const out: Array<{ symbol: string; sig: string | null; err?: string }> = [];
    for (const sym of symbols) {
      try {
        const sig = await this.settleCustody(sym);
        out.push({ symbol: sym, sig });
      } catch (err) {
        out.push({ symbol: sym, sig: null, err: getErrorMessage(err) });
      }
    }
    return out;
  }

  /**
   * Compute the user's actual available balance per token from the on-chain
   * basket + UDL — same formula the program uses at line 175 of openPosition:
   *   available = deposits − debits + pendingCredits
   */
  async getAvailableBalances(): Promise<Map<string, { available: number; deposits: number; debits: number; pendingCredits: number; decimals: number }>> {
    return this.reads.get(`vault:${this.walletAddress}`, () => this.getAvailableBalancesUncached()) as Promise<Map<string, { available: number; deposits: number; debits: number; pendingCredits: number; decimals: number }>>;
  }

  private async getAvailableBalancesUncached(): Promise<Map<string, { available: number; deposits: number; debits: number; pendingCredits: number; decimals: number }>> {
    const owner = this.wallet.publicKey;
    // Read basket from ER (it's where openPosition checks state); UDL stays on L1.
    const [basket, udl] = await Promise.all([
      this.erAccounts.fetchBasket(owner).catch(() => null) as Promise<{ debits?: Array<{ mint: PublicKey; amount: BN }>; pendingCredits?: Array<{ mint: PublicKey; amount: BN }> } | null>,
      this.sdk.accounts.fetchUserDepositLedger(owner).catch(() => null) as Promise<{ deposits?: Array<{ mint: PublicKey; amount: BN }> } | null>,
    ]);
    return composeBalanceMap(
      this.poolConfig.custodies,
      udl?.deposits,
      basket?.debits,
      basket?.pendingCredits,
    );
  }

  /**
   * Withdraw collateral from the vault — two-step L1 process:
   *   1. Request: marks the withdrawal in the UDL + ER, commits state to L1.
   *   2. Settle:  releases the tokens from the platform vault back to user's ATA.
   *
   * The SDK's flags `requestCustodySettlementWithAction` / `executeCustody-
   * SettlementBaseChain` bundle a custody-settlement step into each side. If
   * the user already ran `settle USDC` separately (which consumes the
   * settlement receipt), bundling a fresh one fails with `AccountNotInitial-
   * ized` (Anchor 3012) because step 2 looks for a receipt that's already
   * been drained.
   *
   * Strategy: ALWAYS try with bundled settlement first (works for the common
   * "haven't settled yet" case). On failure with 3012 anywhere in the call,
   * automatically retry without bundling (works after a manual settle).
   */
  async withdraw(
    tokenMint: PublicKey,
    amountRaw: bigint,
  ): Promise<{ requestSig: string; settleSig: string }> {
    const validatorKey = await this.fetchClosestValidatorKey().catch(() => this.wallet.publicKey);

    // Pre-flight snapshot: capture the basket's available balance BEFORE we
    // start sending. After any error path we compare against this; if the
    // balance went down by ≥ amountRaw, the withdraw succeeded on-chain
    // regardless of what the SDK threw. This is the "deposit-grade"
    // atomicity guarantee — never report failure when chain-truth says
    // success.
    const tokenInfo = this.tokenForMintOrNull(tokenMint);
    const tokenSymbol = tokenInfo?.symbol;
    const preBalances = await this.getAvailableBalancesUncached().catch(() => null);
    const preAvailable = tokenSymbol ? (preBalances?.get(tokenSymbol)?.available ?? 0) : 0;
    // Convert amountRaw (token-raw units) → USD (or token-units, doesn't
    // matter — we just need a comparable scale). We compare in raw units
    // because that's what the basket exposes and there's no oracle dependency.
    const amountTokens = tokenInfo ? Number(amountRaw) / 10 ** tokenInfo.decimals : Number(amountRaw);

    // ALSO snapshot the user's ATA balance — the destination of the withdraw.
    // This is the strongest signal: if the ATA balance went up by ≈
    // amountTokens, funds physically arrived in the user's wallet, full stop.
    // Basket-side check alone is fragile: `available = deposits - debits +
    // pendingCredits`, and pending settle ix's can move that needle in ways
    // that look like a withdraw without actually being one.
    const ataPreBalance = await this.readUserAtaBalance(tokenMint).catch(() => null);

    // Hoist the partial signatures out so the outer error path can still
    // return them when chain-truth says the funds moved. Without this,
    // a request-leg sig that successfully landed but whose execute-leg
    // SDK-poll timed out would surface as `'expired-but-landed'` /
    // `'expired-but-landed'` — losing the real Solscan-clickable
    // signature the user actually signed and broadcast.
    let lastRequestSig: string | null = null;
    let lastSettleSig: string | null = null;

    const tryWithdraw = async (bundleSettle: boolean): Promise<{ requestSig: string; settleSig: string }> => {
      const reqResult = await this.sdk.requestWithdrawalWithAction(
        tokenMint,
        new BN(amountRaw.toString()),
        { commitFrequency: 300, validatorKey },
        this.poolConfig,
        bundleSettle,
      );
      const requestSig = await this.sendL1Ixs(reqResult.instructions, reqResult.additionalSigners, 'magic.requestWithdraw');
      lastRequestSig = requestSig;
      // Composite operation: request + execute is ONE user-initiated withdraw.
      // The rate-limit gate inside sendL1Ixs fires between the two steps and
      // would refuse the second leg (the user's funds would already have
      // moved on the first leg, but they'd see "rate limited" with no
      // settle sig — confusing). Wait out the inter-trade cooldown here so
      // the second leg passes the gate cleanly.
      await getSigningGuard().waitForRateLimit();
      const settleResult = await this.sdk.executeWithdrawalBaseChain(tokenMint, this.poolConfig, bundleSettle);
      const settleSig = await this.sendL1Ixs(settleResult.instructions, settleResult.additionalSigners, 'magic.executeWithdraw');
      lastSettleSig = settleSig;
      return { requestSig, settleSig };
    };

    // Chain-truth verifier — composed in `verify-withdraw.ts` so the
    // dual-signal logic can be unit-tested in isolation. Closure shape
    // here just glues this client's I/O methods to the verifier's
    // contract.
    const verifyLanded = (): Promise<boolean> => verifyWithdrawLanded(
      {
        ataPre: ataPreBalance,
        basketPre: tokenSymbol && preBalances ? preAvailable : null,
        tokenSymbol: tokenSymbol ?? null,
        amountTokens,
      },
      {
        readAta: () => this.readUserAtaBalance(tokenMint),
        readBasket: async () => {
          if (!tokenSymbol) return undefined;
          const post = await this.getAvailableBalancesUncached();
          return post.get(tokenSymbol)?.available;
        },
      },
    );

    // Helper: re-classify errors that are actually success in disguise.
    const isAlreadyProcessed = (msg: string): boolean => /already been processed/i.test(msg);
    const isFresh3012 = (msg: string): boolean =>
      !isAlreadyProcessed(msg) && /Custom":\s*3012|AccountNotInitialized/i.test(msg);

    // Single try with multi-stage recovery:
    //   1. tryWithdraw(true)         (bundled-settle path — the common case)
    //   2. on 3012 → tryWithdraw(false)  (unbundled — the post-settle case)
    //   3. on any failure, verifyLanded()
    //      → if chain says funds moved, return success
    //      → else throw a properly-mapped error
    try {
      return await tryWithdraw(true);
    } catch (err) {
      const msg = (err as { message?: string }).message ?? String(err);

      if (isAlreadyProcessed(msg)) {
        log.info('magic-client', 'withdraw: tx already on-chain — treating as success');
        return { requestSig: 'already-landed', settleSig: 'already-landed' };
      }

      if (isFresh3012(msg)) {
        log.info('magic-client', 'withdraw: bundled-settle 3012 → retrying unbundled');
        try {
          return await tryWithdraw(false);
        } catch (err2) {
          const msg2 = (err2 as { message?: string }).message ?? String(err2);
          if (isAlreadyProcessed(msg2)) {
            log.info('magic-client', 'withdraw: retry says already-processed — first attempt landed');
            return { requestSig: 'already-landed', settleSig: 'already-landed' };
          }
          // FINAL ARBITER: did the chain actually move the funds anyway?
          // (Common when the request leg landed but the execute leg's
          // signature couldn't be polled to confirmation in time, OR when
          // a bundled settle ix's failure propagated the wrong error code.)
          if (await verifyLanded()) {
            log.warn('magic-client', `withdraw: SDK threw "${msg2}" but chain confirms funds moved — treating as success`);
            // Prefer the REAL signatures we captured before the throw —
            // they're clickable on Solscan. Only fall through to the
            // sentinel when we genuinely have no signature (i.e. the
            // request leg itself never returned).
            return {
              requestSig: lastRequestSig ?? 'expired-but-landed',
              settleSig: lastSettleSig ?? lastRequestSig ?? 'expired-but-landed',
            };
          }
          throw toTradingError(err2, 'withdraw');
        }
      }

      // Same final-arbiter check on the FIRST-attempt failure path.
      if (await verifyLanded()) {
        log.warn('magic-client', `withdraw: SDK threw "${msg}" but chain confirms funds moved — treating as success`);
        return {
          requestSig: lastRequestSig ?? 'expired-but-landed',
          settleSig: lastSettleSig ?? lastRequestSig ?? 'expired-but-landed',
        };
      }
      throw toTradingError(err, 'withdraw');
    }
  }

  // ─── Inspection helpers ────────────────────────────────────────────────────

  async preflight(stableMint?: PublicKey): Promise<{
    walletAddress: string;
    l1SolBalance: number;
    udlInitialised: boolean;
    basketInitialised: boolean;
    basketDelegated: boolean;
    stableAtaExists: boolean | null;
    stableAtaBalance: string | null;
    depositCount: number;
    network: string;
    poolName: string;
  }> {
    const owner = this.wallet.publicKey;
    const [l1Lamports, udl, basket, delegated] = await Promise.all([
      this.l1Connection.getBalance(owner).catch(() => 0),
      this.sdk.accounts.fetchUserDepositLedger(owner).catch(() => null),
      this.sdk.accounts.fetchBasket(owner).catch(() => null),
      this.checkBasketDelegated(),
    ]);

    let stableAtaExists: boolean | null = null;
    let stableAtaBalance: string | null = null;
    if (stableMint) {
      try {
        const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
        const ata = getAssociatedTokenAddressSync(stableMint, owner);
        const info = await this.l1Connection.getParsedAccountInfo(ata);
        if (info.value) {
          stableAtaExists = true;
          const parsed = (info.value.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed;
          stableAtaBalance = parsed?.info?.tokenAmount?.amount ?? null;
        } else {
          stableAtaExists = false;
        }
      } catch {
        stableAtaExists = null;
      }
    }

    return {
      walletAddress: owner.toBase58(),
      l1SolBalance: l1Lamports / LAMPORTS_PER_SOL,
      udlInitialised: udl !== null,
      basketInitialised: basket !== null,
      basketDelegated: delegated,
      stableAtaExists,
      stableAtaBalance,
      depositCount: Array.isArray(udl?.deposits) ? (udl.deposits as unknown[]).length : 0,
      network: this.network,
      poolName: this.poolConfig.poolName,
    };
  }

  async getDelegationStatus(): Promise<{ basketDelegated: boolean }> {
    return { basketDelegated: await this.checkBasketDelegated() };
  }

  /** List all magic-block pools the SDK knows about (across clusters). */
  listPoolConfigsAvailable(): Array<{ poolName: string; cluster: string; isActive: boolean }> {
    // Delegate to SDK's bundled JSON — we don't enumerate on-chain because
    // we already have the canonical list.
    const json = JSON.parse(
      readFileSync(
        new URL('../../node_modules/@flash_trade/magic-trade-client/dist/PoolConfig.json', import.meta.url),
        'utf8',
      ),
    ) as { pools: Array<{ poolName: string; cluster: string; isMagicBlock?: boolean }> };
    return json.pools
      .filter((p) => p.isMagicBlock)
      .map((p) => ({ poolName: p.poolName, cluster: p.cluster, isActive: p.poolName === this.poolConfig.poolName }));
  }

  listPools(): Array<{ pubkey: string; id: number }> {
    return [{ pubkey: this.poolConfig.poolAddress.toBase58(), id: this.poolConfig.poolId }];
  }

  listMarkets(): Array<{ pubkey: string; targetCustody: string; lockCustody: string; symbol: string; side: string; maxLev: number }> {
    return this.poolConfig.markets.map((m) => {
      const targetSymbol = this.poolConfig.custodies.find((c) => c.custodyAccount.equals(m.targetCustody))?.symbol ?? '?';
      return {
        pubkey: m.marketAccount.toBase58(),
        targetCustody: m.targetCustody.toBase58(),
        lockCustody: m.collateralCustody.toBase58(),
        symbol: targetSymbol,
        side: typeof m.side === 'string' ? m.side : Object.keys(m.side as object)[0],
        maxLev: m.maxLev,
      };
    });
  }

  listCustodies(): Array<{ pubkey: string; mint: string; decimals: number; isStable: boolean; symbol: string }> {
    return this.poolConfig.custodies.map((c) => ({
      pubkey: c.custodyAccount.toBase58(),
      mint: c.mintKey.toBase58(),
      decimals: c.decimals,
      isStable: c.isStable,
      symbol: c.symbol,
    }));
  }

  async fetchPlatform(): Promise<unknown> {
    return this.sdk.accounts.fetchPlatform().catch(() => null);
  }

  /**
   * Short-TTL cache for the basket account.
   *
   * Why 3 s? The basket only changes when WE sign a tx. Every signing
   * path goes through `sendErIxs` / `sendL1Ixs`, both of which call
   * `invalidateBasketCache()` on success. So in practice the cache is
   * always invalidated immediately after our own writes — the 3 s TTL
   * is just a safety net for the case where some on-chain force we
   * don't track (settle daemon, liquidator) mutates the account.
   *
   * Hit ratio in real flows: ~100% on close-after-open and rapid
   * trigger-resolve sequences. Saves ~50–150 ms per call when hot.
   */
  private basketCacheRef: { value: unknown; fetchedAt: number } | null = null;
  private static readonly BASKET_CACHE_TTL_MS = 3_000;

  async fetchBasket(): Promise<unknown> {
    const now = Date.now();
    const c = this.basketCacheRef;
    if (c && now - c.fetchedAt < MagicTradeClient.BASKET_CACHE_TTL_MS) {
      return c.value;
    }
    const value = await this.erAccounts.fetchBasket(this.wallet.publicKey).catch(() => null);
    this.basketCacheRef = { value, fetchedAt: now };
    return value;
  }

  /** Drop the basket cache. Called after every successful sign. */
  private invalidateBasketCache(): void {
    this.basketCacheRef = null;
  }

  /**
   * Lightweight chain-truth check: re-fetch the basket and verify a
   * non-zero position exists for `(targetSymbol, side)`. Used by the
   * inline-trigger open path under a 300 ms budget so the caller can
   * decide whether to surface a soft warning to the user.
   *
   * Bypasses `buildPositionsFromBasket` (which does a bunch of
   * expensive per-position PnL/liq fetches) — we only need to know if
   * the slot exists with non-zero size.
   *
   * Returns `true` on match, throws on miss / RPC failure (caller
   * wraps in `Promise.race` with a timeout).
   */
  private async verifyPositionOpenedOnChain(targetSymbol: string, side: TradeSide): Promise<true> {
    const basket = (await this.erAccounts.fetchBasket(this.wallet.publicKey)) as {
      positions?: Array<{
        market: PublicKey;
        position: { sizeAmount?: BN; sizeUsd?: BN };
      }>;
    } | null;
    const positions = basket?.positions ?? [];
    for (const pm of positions) {
      const market = this.poolConfig.markets.find((m) => m.marketAccount.equals(pm.market));
      if (!market) continue;
      const target = this.poolConfig.custodies.find((c) => c.custodyAccount.equals(market.targetCustody));
      if (target?.symbol !== targetSymbol) continue;
      const sideStr =
        typeof market.side === 'string'
          ? market.side
          : (Object.keys(market.side as object)[0] as TradeSide);
      if (sideStr !== side) continue;
      const sz = pm.position.sizeAmount ?? pm.position.sizeUsd;
      if (sz && typeof sz.isZero === 'function' && !sz.isZero()) {
        return true;
      }
    }
    throw new Error(`position not yet visible on chain (market=${targetSymbol} side=${side})`);
  }

  async fetchUserDepositLedger(): Promise<unknown> {
    return this.sdk.accounts.fetchUserDepositLedger(this.wallet.publicKey).catch(() => null);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * Cache the list of trusted program-id permutations we've already validated
   * this session. Capped at 64 entries (FIFO eviction) so a long-running
   * session that sees many novel ix-bundle compositions can't grow the cache
   * unboundedly. Versioned against the program allowlist so a runtime
   * `extendAllowedPrograms` (or its inverse) invalidates stale entries — a
   * cached "trusted" hash from a prior allowlist must NOT survive an allowlist
   * change, otherwise a since-removed program would slip past validation.
   */
  private trustedIxHashCache = new Map<string, number>();
  private static readonly TRUSTED_IX_CACHE_MAX = 64;

  private async sendErIxs(
    ixs: TransactionInstruction[],
    additionalSigners: Signer[],
    context: string,
  ): Promise<string> {
    // Persistent kill-switch — checked first so a panicked user has the
    // shortest possible path to halting all signing.
    assertNotKilled();
    // Hot-path optimization: if every program in this ix list has been
    // validated already (we built them all from the same SDK + PoolConfig),
    // skip the per-tx whitelist scan. Saves a few ms per trade.
    const ixHash = ixs.map((ix) => ix.programId.toBase58()).join(',');
    const { getAllowlistVersion } = await import('../security/validate-programs.js');
    const allowVersion = getAllowlistVersion();
    const cachedVersion = this.trustedIxHashCache.get(ixHash);
    if (cachedVersion !== allowVersion) {
      validateInstructionPrograms(ixs, context);
      // FIFO trim before insert.
      if (this.trustedIxHashCache.size >= MagicTradeClient.TRUSTED_IX_CACHE_MAX) {
        const oldest = this.trustedIxHashCache.keys().next().value;
        if (oldest !== undefined) this.trustedIxHashCache.delete(oldest);
      }
      this.trustedIxHashCache.set(ixHash, allowVersion);
    }
    if (!this.verifyOwnerKeypair()) {
      throw new Error('[magic-mode] owner keypair integrity check failed — refusing to sign');
    }

    // Owner-signed ER trades for now. Session keys aren't usable here yet —
    // session_token PDAs live on L1 and the ER can't see them, so passing one
    // into openPosition triggers `Custom(3012) AccountNotInitialized`.
    // Reading the keypair from disk is sub-ms, so this is still fast.
    const signers: Keypair[] = [this.wallet];
    for (const s of additionalSigners) {
      if ((s as Keypair).secretKey) signers.push(s as Keypair);
    }

    // Retry semantics are SPLIT by what the error proves about on-chain state:
    //
    //  - "blockhash not found": the tx was NEVER accepted (its blockhash is
    //    unknown to the cluster) → it definitively did not land → safe to evict
    //    the cached blockhash and re-sign.
    //
    //  - "already (been) processed": the network ALREADY accepted this exact
    //    signature → the tx very likely LANDED. Re-signing with a fresh
    //    blockhash produces a DISTINCT signature that executes the op a SECOND
    //    time. `openPosition` is dup-guarded on-chain, but the additive ops
    //    (increasePositionSize / addCollateral / decreasePosition) are NOT — a
    //    resubmit there double-spends the user's collateral. So we FAIL CLOSED:
    //    do not resubmit; surface a clear error and let the user verify state.
    const isStaleBlockhash = (err: unknown): boolean =>
      /blockhash not found/i.test((err as { message?: string }).message ?? '');
    const isAlreadyProcessed = (err: unknown): boolean =>
      /already been processed|already processed/i.test((err as { message?: string }).message ?? '');
    const alreadyProcessedError = (): Error =>
      new Error(
        `${context}: transaction was already submitted (network reports "already processed"). ` +
          `Not resubmitting — a fresh blockhash would create a second, double-executing transaction. ` +
          `Check your portfolio to confirm whether it landed before retrying.`,
      );

    if (this.fastConfirm) {
      // Submit-and-return: the SDK's skipConfirm returns the signature as soon
      // as ER accepts the bytes. We DO NOT block the user on confirmation —
      // ER commits sub-second but the round-trip still adds ~150-300ms which
      // the user has explicitly rejected for the hot path. `pollErTxBackground`
      // runs after a short delay; if the tx failed on-chain it surfaces a
      // post-hoc warning to stdout (see implementation below) so the user
      // still finds out — just on the next prompt cycle, not before this card.
      try {
        const sig = await this.sdk.sendErTransaction(ixs, signers, { skipConfirm: true });
        this.pollErTxBackground(sig, context);
        // Bust read caches so the next `portfolio` / `vault` sees fresh state.
        // Cheaper than per-tool plumbing — every signed ER write goes through here.
        this.reads.bust('portfolio:'); this.invalidateBasketCache();
        this.reads.bust('vault:');
        this.reads.bust('markets:');
        return sig;
      } catch (err) {
        if (isAlreadyProcessed(err)) throw alreadyProcessedError();
        if (!isStaleBlockhash(err)) throw err;
        log.warn('magic-client', `${context}: stale blockhash → evicting cache + retry`);
        this.blockhashCacheRef.ref = null;
        const sig = await this.sdk.sendErTransaction(ixs, signers, { skipConfirm: true });
        this.pollErTxBackground(sig, context);
        this.reads.bust('portfolio:'); this.invalidateBasketCache();
        this.reads.bust('vault:');
        this.reads.bust('markets:');
        return sig;
      }
    }

    try {
      const result = await this.sdk.sendAndConfirmErTransaction(ixs, signers, {
        pollTimeoutMs: 10_000,
        pollIntervalMs: 500,
      });
      this.reads.bust('portfolio:'); this.invalidateBasketCache();
      this.reads.bust('vault:');
      this.reads.bust('markets:');
      return result.signature;
    } catch (err) {
      if (isAlreadyProcessed(err)) throw alreadyProcessedError();
      if (!isStaleBlockhash(err)) throw err;
      this.blockhashCacheRef.ref = null;
      const result = await this.sdk.sendAndConfirmErTransaction(ixs, signers, {
        pollTimeoutMs: 10_000,
        pollIntervalMs: 500,
      });
      this.reads.bust('portfolio:'); this.invalidateBasketCache();
      this.reads.bust('vault:');
      this.reads.bust('markets:');
      return result.signature;
    }
  }

  /**
   * Background ER signature watcher — fires once 2s after submission to check
   * status. If confirmed, logs success; if failed/missing, logs the error so
   * the user (or audit log tail) can see something went wrong despite the fast
   * return.
   */
  /**
   * Track every background-poll setTimeout so we can clear them in `shutdown()`.
   * Without this, dozens of pending timers fire after the REPL has closed and
   * write to a closed stdout. Bounded to ~256 in-flight to defend against a
   * runaway script — additional polls become no-ops.
   */
  private pendingPollTimers = new Set<ReturnType<typeof setTimeout>>();
  private static readonly MAX_PENDING_POLLS = 256;

  private pollErTxBackground(sig: string, context: string): void {
    const erConn = (this.sdk as unknown as { erConnection: Connection | null }).erConnection;
    if (!erConn) return;
    if (this.pendingPollTimers.size >= MagicTradeClient.MAX_PENDING_POLLS) return;
    const handle = setTimeout(async () => {
      this.pendingPollTimers.delete(handle);
      try {
        // Use getTransaction to capture program logs — getSignatureStatus
        // alone gives a noisy `err` that's often a false-positive on ER.
        const tx = await erConn
          .getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
          .catch(() => null);
        if (!tx) {
          log.debug('magic-client', `[${context}] ${sig} not visible 2s after submit (ER lag)`);
          return;
        }
        const logs = tx.meta?.logMessages ?? [];
        const anchorMatch = logs.find((l) => /AnchorError|Error Number:\s*\d+/.test(l));
        if (tx.meta?.err && anchorMatch) {
          // Real program-level failure (not the ER's `InvalidWritableAccount`
          // false-positive). Surface the friendly mapped error to stdout so
          // the user finds out before their next trade. Wrapped in try/catch
          // because stdout may be closed by the time this fires (post-shutdown
          // background tick).
          const synthErr = new Error(`tx failed: ${JSON.stringify(tx.meta.err)}`);
          (synthErr as unknown as { logs: string[] }).logs = logs;
          const friendly = mapSdkError(synthErr, context);
          // Route through the REPL-safe writer so the warning doesn't
          // corrupt a prompt the user may be typing on. Try lazily; on
          // shutdown the import may fail or stdout may be closed — drop.
          try {
            const { replSafeWrite } = await import('../cli/repl-write.js');
            replSafeWrite(`  ⚠ Trade ${sig.slice(0, 6)}…${sig.slice(-4)} did NOT land: ${friendly}`);
          } catch { /* stdout closed or shutting down */ }
          log.warn('magic-client', `[${context}] ${sig} on-chain error: ${friendly}`);
        } else if (tx.meta?.err) {
          log.debug('magic-client', `[${context}] ${sig} status err (likely ER false-positive): ${JSON.stringify(tx.meta.err)}`);
        } else {
          log.debug('magic-client', `[${context}] ${sig} confirmed at slot ${tx.slot ?? '?'}`);
        }
      } catch (err) {
        log.debug('magic-client', `[${context}] background status poll failed for ${sig}: ${getErrorMessage(err)}`);
      }
    }, 2000);
    handle.unref?.();
    this.pendingPollTimers.add(handle);
  }

  private async sendL1Ixs(
    ixs: TransactionInstruction[],
    additionalSigners: Signer[],
    context: string,
  ): Promise<string> {
    // Persistent kill-switch — checked first.
    assertNotKilled();
    validateInstructionPrograms(ixs, context);
    if (!this.verifyOwnerKeypair()) {
      throw new Error('[magic-mode] owner keypair integrity check failed — refusing to sign');
    }

    // Rate-limit + audit gate. L1 paths (init UDL / basket / delegate /
    // deposit / withdraw / settle) previously bypassed this — only ER trade
    // paths were guarded. A runaway deposit/withdraw loop could thrash L1
    // and never appear in the audit log.
    const guard = getSigningGuard();
    const auditType = inferL1AuditType(context);
    const rate = guard.checkRateLimit();
    if (!rate.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: auditType,
        walletAddress: this.walletAddress,
        result: 'rate_limited',
        reason: `${context}: ${rate.reason}`,
      });
      throw new Error(rate.reason);
    }

    const tx = new Transaction();
    for (const ix of ixs) tx.add(ix);
    const signers: Signer[] = [this.wallet, ...additionalSigners];
    // Public mainnet RPCs reject `simulateTransaction` ("preflight check is not supported"),
    // so skip preflight on mainnet. Devnet RPCs allow it; keep it on for cheaper feedback.
    try {
      const sig = await sendAndConfirmTransaction(this.l1Connection, tx, signers, {
        commitment: 'confirmed',
        skipPreflight: this.network === 'mainnet-beta',
        maxRetries: 5,
      });
      guard.recordSigning();
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: auditType,
        walletAddress: this.walletAddress,
        result: 'confirmed',
        txSignature: sig,
        reason: context,
      });
      // L1 ops (deposit / withdraw / settle) change vault state; bust caches
      // so the next read reflects the new on-chain truth.
      this.reads.bust('portfolio:'); this.invalidateBasketCache();
      this.reads.bust('vault:');
      return sig;
    } catch (err) {
      // POST-EXPIRY RECOVERY: when a slow / rate-limited RPC can't poll the
      // signature to confirmation within the blockhash window (~90s),
      // sendAndConfirmTransaction throws "Signature X has expired: block
      // height exceeded" — but the tx itself often DID land. We extract the
      // signature from the error message and re-check status; if the chain
      // confirms it, we treat the operation as success rather than telling
      // the user "failed" when their funds already moved.
      //
      // This is the most-common failure mode on public Solana mainnet RPC
      // (rate-limited polling can't keep up with finalize).
      const msg = getErrorMessage(err);
      const sigMatch = msg.match(/Signature\s+([1-9A-HJ-NP-Za-km-z]{43,88})\s+has expired/);
      if (sigMatch) {
        const sig = sigMatch[1];
        try {
          // Tight poll loop — most "expired" txs are actually already
          // confirmed by the time the polling loop gives up. Check
          // immediately, then every 400 ms for up to 4 s, instead of
          // a single 1.5 s blind wait. Cuts perceived recovery latency
          // from ~1.5 s to <500 ms in the common case.
          let confirmed = false;
          for (let attempt = 0; attempt < 11 && !confirmed; attempt++) {
            if (attempt > 0) await new Promise((r) => setTimeout(r, 400));
            const statusResp = await this.l1Connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
            const st = statusResp.value[0];
            if (st && !st.err && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
              confirmed = true;
              break;
            }
          }
          if (confirmed) {
            log.warn('magic-client', `${context}: sig ${sig.slice(0, 8)} expired-but-confirmed; treating as success`);
            guard.recordSigning();
            guard.logAudit({
              timestamp: new Date().toISOString(),
              type: auditType,
              walletAddress: this.walletAddress,
              result: 'confirmed',
              txSignature: sig,
              reason: `${context} (recovered post-expiry)`,
            });
            this.reads.bust('portfolio:'); this.invalidateBasketCache();
            this.reads.bust('vault:');
            return sig;
          }
        } catch { /* recovery best-effort */ }
      }
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: auditType,
        walletAddress: this.walletAddress,
        result: 'failed',
        reason: `${context}: ${getErrorMessage(err)}`,
      });
      throw err;
    }
  }

  /**
   * Install an in-place blockhash cache on the SDK's ER Connection plus a
   * background refresher that keeps it warm.
   *
   * Implementation note — we tried a Proxy that replaced `sdk.erConnection`
   * with a wrapper instance, but the SDK exposes `erConnection` as a
   * GETTER (no matching setter), so field-level swap throws at runtime.
   * Instead we mutate the Connection's `getLatestBlockhash` METHOD on
   * the instance returned by the getter — the same approach that worked
   * for months in production. Method-level shadow is safe across SDK
   * upgrades as long as `Connection` keeps its method on the prototype
   * (which it has since web3.js v1.0).
   *
   * Background refresher calls the ORIGINAL bound method (captured before
   * the patch) so it actually hits the network instead of getting served
   * its own cached value.
   */
  private installBlockhashWarmer(): void {
    const erConn = (this.sdk as unknown as { erConnection: Connection | null }).erConnection;
    if (!erConn) return;

    const originalGet = erConn.getLatestBlockhash.bind(erConn);
    // Stash the original so `shutdown()` can restore the Connection
    // exactly as the SDK created it — important when test harnesses /
    // wallet rebuilds reuse the same Connection.
    this.originalErGetLatestBlockhash = originalGet as unknown as typeof this.originalErGetLatestBlockhash;
    this.patchedErConnection = erConn;

    const cacheRef = this.blockhashCacheRef;
    const maxAgeMs = MagicTradeClient.BLOCKHASH_MAX_AGE_MS;
    (erConn as unknown as { getLatestBlockhash: typeof erConn.getLatestBlockhash }).getLatestBlockhash = async (
      ...args: Parameters<typeof originalGet>
    ) => {
      const cached = cacheRef.ref;
      if (cached && Date.now() - cached.fetchedAt < maxAgeMs) {
        return { blockhash: cached.blockhash, lastValidBlockHeight: cached.lastValidBlockHeight };
      }
      const fresh = await originalGet(...args);
      cacheRef.ref = { ...fresh, fetchedAt: Date.now() };
      return fresh;
    };

    const refresh = async () => {
      try {
        const bh = await originalGet('confirmed');
        cacheRef.ref = { ...bh, fetchedAt: Date.now() };
      } catch {
        // The maxAge guard above triggers an inline RPC on the next call;
        // safe to swallow here.
      }
    };

    void refresh();
    this.blockhashTimer = setInterval(refresh, MagicTradeClient.BLOCKHASH_REFRESH_MS);
    this.blockhashTimer.unref?.();
  }

  /** Delegate to `verifyKeypairIntact` — extracted for unit testing. */
  private verifyOwnerKeypair(): boolean {
    return verifyKeypairIntact(this.wallet, this.walletAddress);
  }

  private acquireTradeLock(key: string): void {
    if (this.activeTrades.has(key)) {
      throw new Error(`[magic-mode] trade already in progress for ${key}`);
    }
    if (this.activeTrades.size >= MAX_ACTIVE_TRADES) {
      throw new Error('[magic-mode] too many concurrent trades — wait for inflight to settle');
    }
    this.activeTrades.add(key);
  }

  private releaseTradeLock(key: string): void {
    this.activeTrades.delete(key);
  }

  /**
   * Resolve `(targetSymbol, side)` → `{ lockSymbol, market }` by reading the
   * actual lock custody from PoolConfig.markets directly. Pool.0 has three
   * lock conventions:
   *   - Long with target lock:    SOL/BTC/ETH/HYPE/SPY/ZEC long
   *   - Long with BTC lock:       BNB/MON/SUI long (cross-asset coverage)
   *   - Long/Short with USDC lock: stables / FX / metals / equities / commodities
   * We just iterate the markets array and find the one matching (target, side),
   * then read .collateralCustody to get the lock symbol. Handles any future
   * pool config without code changes.
   */
  private resolveMarket(targetSymbol: string, side: TradeSide): { lockSymbol: string; market: MarketConfig } {
    const target = this.poolConfig.getCustodyFromSymbol(targetSymbol);
    if (!target) {
      throw new Error(`[magic-mode] unknown market symbol '${targetSymbol}'. Run \`magic markets\` to see available.`);
    }
    const wantSide = side === TradeSide.Long ? 'long' : 'short';
    for (const m of this.poolConfig.markets) {
      if (!m.targetCustody.equals(target.custodyAccount)) continue;
      const mSide = (typeof m.side === 'string' ? m.side : Object.keys(m.side as object)[0]) as 'long' | 'short';
      if (mSide !== wantSide) continue;
      const lockCustody = this.poolConfig.custodies.find((c) => c.custodyAccount.equals(m.collateralCustody));
      if (!lockCustody) continue;
      return { lockSymbol: lockCustody.symbol, market: m };
    }
    throw new Error(`[magic-mode] no market for ${targetSymbol} ${side} in pool ${this.poolConfig.poolName}`);
  }

  private tokenForMintOrNull(mint: PublicKey): { symbol: string; decimals: number; isStable: boolean } | null {
    try {
      return this.poolConfig.getTokenFromMintPk(mint);
    } catch {
      return null;
    }
  }

  /**
   * Thin wrapper over `OracleExponentCache.remember` — kept as a method so
   * call-site signatures don't change.
   */
  private rememberExponent(symbol: string, exponent: number): void {
    this.exponentCache.remember(symbol, exponent);
  }

  /**
   * Encode a USD price for an outbound trigger / limit order, using the
   * cached exponent for this symbol. Logs a warning when the cache
   * misses so non-crypto markets surface "you should fetchOraclePrice
   * first" instead of silently mis-scaling.
   */
  private usdToOraclePrice(symbol: string, usd: number): { price: BN; exponent: number } {
    const r = this.exponentCache.encode(symbol, usd);
    if (r.usedDefault) {
      log.warn(
        'magic-client',
        `usdToOraclePrice(${symbol.toUpperCase()}): no observed exponent on this client, defaulting to -8.`,
      );
    }
    return { price: r.price, exponent: r.exponent };
  }

  /**
   * Read the user's ATA balance for a given mint, returned in token-units
   * (decimal-adjusted). Returns `null` if the ATA doesn't exist yet or the
   * RPC fails — callers must handle that by falling back to a different
   * verification signal. Used by withdraw chain-truth verification.
   */
  private async readUserAtaBalance(mint: PublicKey): Promise<number | null> {
    try {
      const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
      const ata = getAssociatedTokenAddressSync(mint, this.wallet.publicKey);
      const info = await this.l1Connection.getParsedAccountInfo(ata);
      if (!info.value) return 0; // ATA doesn't exist → effectively zero
      const parsed = (info.value.data as { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } }).parsed;
      const ui = parsed?.info?.tokenAmount?.uiAmount;
      return typeof ui === 'number' && Number.isFinite(ui) ? ui : null;
    } catch {
      return null;
    }
  }

  /** Use Anchor's account-not-owned-by-program signal to check delegation. */
  private async checkBasketDelegated(): Promise<boolean> {
    try {
      const info = await this.l1Connection.getAccountInfo(this.basketPda);
      if (!info) return false;
      // When delegated to MagicBlock's ER, the account owner becomes the delegation program.
      return info.owner.toBase58() !== this.programId.toBase58();
    } catch {
      return false;
    }
  }

  /** Delegation needs an ER validator pubkey; `flashtrade.magicblock.app` exposes one. */
  private async fetchClosestValidatorKey(): Promise<PublicKey> {
    let identity: PublicKey | null = null;
    try {
      // Bound the request: a hostile or simply-slow ER endpoint must not be
      // able to hang `delegateBasket` / `withdraw` indefinitely. 5s is well
      // beyond a healthy round-trip but well below user perception of "stuck".
      const res = await fetch(this.erEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getValidatorIdentity' }),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const json = (await res.json()) as { result?: { identity?: string } };
        if (json.result?.identity) identity = new PublicKey(json.result.identity);
      }
    } catch {
      // fall through to the "could not fetch" error below
    }
    if (!identity) {
      throw new Error('[magic-mode] could not fetch ER validator identity from router; supply a validatorKey explicitly');
    }
    // Optional operator allowlist (defense-in-depth): the validator identity is
    // self-reported by the (untrusted) ER router. Delegation still requires the
    // owner's L1 signature and is L1-enforced, so a hostile router can at worst
    // cause a stuck/censored delegation (owner-recoverable), not theft. A
    // security-conscious operator can PIN the expected validator(s) via
    // MAGIC_ALLOWED_VALIDATORS (comma-separated base58) to refuse anything else.
    const allow = (process.env.MAGIC_ALLOWED_VALIDATORS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (allow.length > 0 && !allow.includes(identity.toBase58())) {
      throw new Error(
        `[magic-mode] router-reported validator ${identity.toBase58()} is not in the ` +
          `MAGIC_ALLOWED_VALIDATORS allowlist — refusing to delegate`,
      );
    }
    return identity;
  }

  /** Build positions array from Basket account, fetching real PnL/markPrice/liqPrice via SDK views. */
  private async buildPositionsFromBasket(basket: { positions: Array<{ market: PublicKey; position: unknown }> | null }): Promise<Position[]> {
    const rawList = (basket?.positions ?? []) as Array<{
      market: PublicKey;
      position: {
        openTime: BN;
        entryPrice: { price: BN; exponent: number };
        sizeUsd: BN;
        collateralUsd: BN;
        unsettledFeesUsd: BN;
        sizeAmount?: BN;
      };
    }>;
    // The basket retains slots for closed positions with zero size — filter them
    // out so callers (reverse / partial / increase) don't see ghost entries.
    const list = rawList.filter((pm) => {
      const sizeAmt = pm.position.sizeAmount;
      if (sizeAmt && typeof (sizeAmt as BN).isZero === 'function') {
        return !(sizeAmt as BN).isZero();
      }
      const sizeUsd = pm.position.sizeUsd;
      return sizeUsd ? !sizeUsd.isZero() : false;
    });
    if (list.length === 0) return [];

    // Resolve target symbol + side per market once.
    const enriched = list.map((pm) => {
      const market = this.poolConfig.markets.find((m) => m.marketAccount.equals(pm.market));
      const targetCustody = market
        ? this.poolConfig.custodies.find((c) => c.custodyAccount.equals(market.targetCustody))
        : undefined;
      const lockCustody = market
        ? this.poolConfig.custodies.find((c) => c.custodyAccount.equals(market.collateralCustody))
        : undefined;
      const targetSymbol = targetCustody?.symbol ?? '?';
      const lockSymbol = lockCustody?.symbol ?? 'USDC';
      const sideStr =
        market && typeof market.side === 'string'
          ? market.side
          : market
            ? (Object.keys(market.side as object)[0] as TradeSide)
            : 'long';
      const sdkSide = sideStr === 'short' ? Side.Short : Side.Long;
      return { pm, market, targetSymbol, lockSymbol, sideStr: sideStr as TradeSide, sdkSide };
    });

    // Parallelize: per position fetch (markPrice, PnL, liqPrice) via SDK views.
    // Each is a single ER simulate — typically 50-100ms — so N positions takes ≈ max(per-call) with parallelism.
    const owner = this.wallet.publicKey;
    const livePerPos = await Promise.all(
      enriched.map(async (e) => {
        const tasks = [
          this.fetchOraclePrice(e.targetSymbol, e.lockSymbol, e.sideStr).catch(() => 0),
          this.sdk.getPnl(owner, e.targetSymbol, e.lockSymbol, e.sdkSide, this.poolConfig).catch(() => null),
          this.sdk.getLiquidationPrice(owner, e.targetSymbol, e.lockSymbol, e.sdkSide, this.poolConfig).catch(() => null),
        ] as const;
        const [markPrice, pnl, liqPrice] = await Promise.all(tasks);
        return { markPrice, pnl, liqPrice };
      }),
    );

    return enriched.map((e, i) => {
      const p = e.pm.position;
      const entryPrice = priceToNumber(p.entryPrice);
      const sizeUsd = Number(p.sizeUsd) / USD_POWER;
      const collateralUsd = Number(p.collateralUsd) / USD_POWER;
      const leverage = collateralUsd > 0 ? sizeUsd / collateralUsd : 0;

      const live = livePerPos[i];
      const markPrice = live.markPrice || entryPrice;
      const liquidationPrice = live.liqPrice ? priceToNumber(live.liqPrice as { price: BN; exponent: number }) : 0;

      // ProfitAndLoss: { profit: u64, loss: u64 } — both 6dp USD.
      let unrealizedPnl = 0;
      const pnlData = live.pnl as { profit?: BN; loss?: BN } | null;
      if (pnlData) {
        const profit = pnlData.profit ? Number(pnlData.profit) / USD_POWER : 0;
        const loss = pnlData.loss ? Number(pnlData.loss) / USD_POWER : 0;
        unrealizedPnl = profit - loss;
      }
      const unrealizedPnlPercent = collateralUsd > 0 ? (unrealizedPnl / collateralUsd) * 100 : 0;

      return {
        pubkey: e.pm.market.toBase58(),
        market: e.targetSymbol,
        side: e.sideStr,
        entryPrice,
        currentPrice: markPrice,
        markPrice,
        sizeUsd,
        collateralUsd,
        leverage,
        unrealizedPnl,
        unrealizedPnlPercent,
        liquidationPrice,
        openFee: 0,
        totalFees: Number(p.unsettledFeesUsd ?? new BN(0)) / USD_POWER,
        fundingRate: 0,
        timestamp: Number(p.openTime ?? new BN(0)) * 1000,
      };
    });
  }
}

/**
 * Map an L1 ix-bundle context string to the SigningAuditEntry.type. Keeps
 * forensic granularity (separate "init_udl" vs "init_basket" vs "delegate")
 * without forcing every L1 caller to plumb its own audit-type field.
 */
// `priceToNumber`, `liquidationPriceEstimate`, `pnlUsd`, etc. are now in
// `./math.ts` (property-tested), the per-instance oracle-exponent cache
// lives in `./oracle-exponent-cache.ts`, and the L1 audit-type matcher
// in `./audit-type.ts`. Re-imported at the top.
