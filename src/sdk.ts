/**
 * Programmatic SDK entry point for the Flash Magic Terminal.
 *
 *     import { createMagicSession, TradeSide } from 'flash-magic-terminal';
 *
 *     const magic = await createMagicSession({
 *       walletKeypairPath: '~/.config/solana/id.json',
 *       network: 'mainnet-beta',
 *     });
 *
 *     const portfolio = await magic.getPortfolio();
 *     const open = await magic.openPosition('SOL', TradeSide.Long, 50, 2);
 *     await magic.shutdown();
 *
 * Everything goes through the same hardened paths the CLI uses — signing
 * guard, rate limit, kill switch, audit log, RPC validation, program
 * allowlist. There is no second code path; the SDK is just a typed
 * factory around `MagicTradeClient`.
 *
 * Auth: pass a keypair path (loaded with the same security checks the CLI
 * applies — home-dir-scoped, symlink-resolved, mode 0600) or pass a
 * pre-built `Keypair` object directly via `walletKeypair`.
 *
 * Production-grade error handling: every method throws a typed error
 * (`ValidationError`, `NetworkError`, `TradingError`, `GuardError`,
 * `ConfigError`) — branch on `instanceof` rather than parsing strings.
 *
 * NO_DNA: the SDK is environment-agnostic. The CLI's NO_DNA mode applies
 * only to its stdout formatting; SDK consumers receive typed objects.
 */

import { Connection, Keypair } from '@solana/web3.js';
import { MagicTradeClient } from './client/magic-client.js';
import { WalletManager } from './wallet/walletManager.js';
import { RpcManager, setRpcManager } from './network/rpc-manager.js';
import {
  loadConfig,
  validateRpcUrl,
  loadBackupL1Rpcs,
  MAGIC_POOL_NAME_MAINNET,
  MAGIC_POOL_NAME_DEVNET,
} from './config/index.js';
import { initSigningGuard, getSigningGuard } from './security/signing-guard.js';
import { initLogger, LogLevel } from './utils/logger.js';
import { TradeSide } from './types/index.js';
import { ConfigError } from './utils/errors.js';

export { TradeSide } from './types/index.js';
export type { MagicConfig, OpenPositionResult, ClosePositionResult, CollateralResult } from './types/index.js';
export { FlashError, ValidationError, ConfigError, NetworkError, TradingError, GuardError, AssertionError, asFlashError, describeErrorChain } from './utils/errors.js';
export { getSigningGuard } from './security/signing-guard.js';
export { isKilled, killSwitchOn, killSwitchOff, killSwitchState, assertNotKilled } from './security/kill-switch.js';
export { mapSdkError } from './client/sdk-errors.js';

export interface MagicSessionOptions {
  /** Path to a Solana CLI-format keypair JSON file. Mutually exclusive with `walletKeypair`. */
  walletKeypairPath?: string;
  /** Pre-built `Keypair`. Mutually exclusive with `walletKeypairPath`. */
  walletKeypair?: Keypair;
  /** Defaults to env / `loadConfig()`. */
  network?: 'mainnet-beta' | 'devnet';
  /** Defaults to Pool.0 (mainnet) / Pool.1 (devnet). */
  poolName?: string;
  /** Defaults to env. Validated through `validateRpcUrl` (https-only). */
  l1RpcUrl?: string;
  /** Defaults to env (Magic Block ER router). Validated through `validateRpcUrl`. */
  erRpcUrl?: string;
  /** Override the on-chain program ID. Rare. */
  programIdOverride?: string;
  /** Microlamports for L1 priority fee. Default 50_000. */
  computeUnitPrice?: number;
  /** ER ixs return on submit (don't block on confirm). Default true. */
  fastConfirm?: boolean;
  /** Per-trade caps. 0 = unlimited. */
  maxCollateralPerTrade?: number;
  maxPositionSize?: number;
  maxLeverage?: number;
  maxTradesPerMinute?: number;
  minDelayBetweenTradesMs?: number;
  /** Logger level. Default 'info'; agents typically want 'debug'. */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

/** Live trading session. Returned by `createMagicSession`. */
export interface MagicSession {
  /** The underlying `MagicTradeClient` for any methods not surfaced here. */
  client: MagicTradeClient;
  /** Wallet pubkey as a base58 string. */
  walletAddress: string;
  /** Network the session is bound to. */
  network: 'mainnet-beta' | 'devnet';

  // ─── Reads ─────────────────────────────────────────────────────────────
  getPortfolio: MagicTradeClient['getPortfolio'];
  getPositions: MagicTradeClient['getPositions'];
  getMarketData: MagicTradeClient['getMarketData'];
  getAvailableBalances: MagicTradeClient['getAvailableBalances'];
  fetchBasket: MagicTradeClient['fetchBasket'];
  fetchOraclePrice: MagicTradeClient['fetchOraclePrice'];
  previewOpen: MagicTradeClient['previewOpen'];

  // ─── Writes ────────────────────────────────────────────────────────────
  openPosition: MagicTradeClient['openPosition'];
  closePosition: MagicTradeClient['closePosition'];
  reversePositionAtomic: MagicTradeClient['reversePositionAtomic'];
  decreasePosition: MagicTradeClient['decreasePosition'];
  increasePosition: MagicTradeClient['increasePosition'];
  addCollateral: MagicTradeClient['addCollateral'];
  removeCollateral: MagicTradeClient['removeCollateral'];
  placeLimit: MagicTradeClient['placeLimit'];
  cancelLimit: MagicTradeClient['cancelLimit'];
  placeTrigger: MagicTradeClient['placeTrigger'];
  cancelTrigger: MagicTradeClient['cancelTrigger'];
  liquidatePosition: MagicTradeClient['liquidatePosition'];

  // ─── Setup / lifecycle ─────────────────────────────────────────────────
  initializeUserDepositLedger: MagicTradeClient['initializeUserDepositLedger'];
  initializeBasket: MagicTradeClient['initializeBasket'];
  delegateBasket: MagicTradeClient['delegateBasket'];
  depositDirect: MagicTradeClient['depositDirect'];
  withdraw: MagicTradeClient['withdraw'];
  settleCustody: MagicTradeClient['settleCustody'];

  /**
   * Tear down all background timers + clear caches. Always call this
   * when you're done — otherwise the process won't exit cleanly.
   *
   * Returns `{ warnings: string[] }` with one entry per phase that
   * failed (so SDK consumers can surface a "shutdown encountered N
   * warnings" line in their tooling). Empty array on a fully clean
   * teardown. Never throws.
   */
  shutdown: () => Promise<{ warnings: string[] }>;
}

const LOG_LEVEL_MAP: Record<string, LogLevel> = {
  debug: LogLevel.Debug,
  info: LogLevel.Info,
  warn: LogLevel.Warn,
  error: LogLevel.Error,
};

/**
 * Build a hardened trading session against the Flash Magic Trade ER.
 *
 * Throws `ConfigError` if neither `walletKeypair` nor `walletKeypairPath`
 * is supplied (or if both are). Every other failure mode is one of the
 * typed errors re-exported above.
 */
export async function createMagicSession(opts: MagicSessionOptions = {}): Promise<MagicSession> {
  if (!opts.walletKeypair && !opts.walletKeypairPath) {
    throw new ConfigError(
      'createMagicSession requires walletKeypair or walletKeypairPath',
      { hint: 'pass a Keypair instance or a path to a Solana keypair JSON' },
    );
  }
  if (opts.walletKeypair && opts.walletKeypairPath) {
    throw new ConfigError(
      'createMagicSession received both walletKeypair and walletKeypairPath',
      { hint: 'choose one' },
    );
  }

  // Initialise the logger early so `loadConfig` warnings have somewhere to go.
  initLogger({ level: LOG_LEVEL_MAP[opts.logLevel ?? 'info'] ?? LogLevel.Info });

  // Merge CLI config (env + ~/.magic/config.json) with the per-call overrides.
  const baseConfig = loadConfig();
  const network = opts.network ?? baseConfig.network;
  // When the SDK consumer overrides `network` (e.g. devnet) but does NOT
  // override `poolName`, `baseConfig.poolName` would still be the env's
  // pool — typically mainnet's `Pool.0`. Re-derive the pool default for
  // the resolved network so a "session on devnet" doesn't try to load
  // mainnet's pool by accident. Explicit `opts.poolName` always wins.
  const networkChanged = opts.network !== undefined && opts.network !== baseConfig.network;
  const defaultPoolForNetwork = network === 'devnet'
    ? MAGIC_POOL_NAME_DEVNET
    : MAGIC_POOL_NAME_MAINNET;
  const resolvedPoolName = opts.poolName
    ?? (networkChanged ? defaultPoolForNetwork : baseConfig.poolName);
  const config = {
    ...baseConfig,
    network,
    poolName: resolvedPoolName,
    l1RpcUrl: opts.l1RpcUrl ? validateRpcUrl(opts.l1RpcUrl, 'opts.l1RpcUrl') : baseConfig.l1RpcUrl,
    erRpcUrl: opts.erRpcUrl ? validateRpcUrl(opts.erRpcUrl, 'opts.erRpcUrl') : baseConfig.erRpcUrl,
    programIdOverride: opts.programIdOverride ?? baseConfig.programIdOverride,
    computeUnitPrice: opts.computeUnitPrice ?? baseConfig.computeUnitPrice,
    fastConfirm: opts.fastConfirm ?? baseConfig.fastConfirm,
    maxCollateralPerTrade: opts.maxCollateralPerTrade ?? baseConfig.maxCollateralPerTrade,
    maxPositionSize: opts.maxPositionSize ?? baseConfig.maxPositionSize,
    maxLeverage: opts.maxLeverage ?? baseConfig.maxLeverage,
    maxTradesPerMinute: opts.maxTradesPerMinute ?? baseConfig.maxTradesPerMinute,
    minDelayBetweenTradesMs: opts.minDelayBetweenTradesMs ?? baseConfig.minDelayBetweenTradesMs,
  };

  // RPC manager — primary + persisted backups, validated.
  const allL1Urls = [config.l1RpcUrl, ...loadBackupL1Rpcs().filter((u) => u !== config.l1RpcUrl)];
  const rpcManager = new RpcManager(allL1Urls);
  setRpcManager(rpcManager);

  // Wallet — load via WalletManager (security checks: home-dir scope,
  // symlink resolution, 0600 perms, prior-key zero on switch).
  const walletManager = new WalletManager(rpcManager.connection);
  rpcManager.setConnectionChangeCallback((conn) => walletManager.setConnection(conn));

  let walletAddress: string;
  let walletKeypair: Keypair;
  if (opts.walletKeypair) {
    // Caller-provided keypair — skip the file-based security checks and
    // trust the caller (they constructed it). WalletManager doesn't have a
    // public connect-from-keypair entry point because the CLI always loads
    // from disk, so we use the keypair directly and only pass it to the
    // client constructor below. WalletManager remains live for balance reads.
    walletKeypair = opts.walletKeypair;
    walletAddress = walletKeypair.publicKey.toBase58();
  } else {
    const loaded = walletManager.loadFromFile(opts.walletKeypairPath!);
    walletKeypair = loaded.keypair;
    walletAddress = loaded.address;
  }

  // Signing guard — same caps the CLI uses.
  initSigningGuard({
    maxCollateralPerTrade: config.maxCollateralPerTrade,
    maxPositionSize: config.maxPositionSize,
    maxLeverage: config.maxLeverage,
    maxTradesPerMinute: config.maxTradesPerMinute,
    minDelayBetweenTradesMs: config.minDelayBetweenTradesMs,
  });
  // Touch the singleton so the audit log file exists before the first sign.
  void getSigningGuard();

  // Build the client. Same constructor shape the CLI uses inside buildMagicClient.
  const l1Connection = new Connection(config.l1RpcUrl, 'confirmed');
  const client = new MagicTradeClient({
    wallet: walletKeypair,
    l1Connection,
    network: config.network,
    poolName: config.poolName,
    erEndpoint: config.erRpcUrl,
    programIdOverride: config.programIdOverride,
    prioritizationFee: config.computeUnitPrice,
    fastConfirm: config.fastConfirm,
  });

  return {
    client,
    walletAddress,
    network: config.network,

    // Reads
    getPortfolio: client.getPortfolio.bind(client),
    getPositions: client.getPositions.bind(client),
    getMarketData: client.getMarketData.bind(client),
    getAvailableBalances: client.getAvailableBalances.bind(client),
    fetchBasket: client.fetchBasket.bind(client),
    fetchOraclePrice: client.fetchOraclePrice.bind(client),
    previewOpen: client.previewOpen.bind(client),

    // Writes
    openPosition: client.openPosition.bind(client),
    closePosition: client.closePosition.bind(client),
    reversePositionAtomic: client.reversePositionAtomic.bind(client),
    decreasePosition: client.decreasePosition.bind(client),
    increasePosition: client.increasePosition.bind(client),
    addCollateral: client.addCollateral.bind(client),
    removeCollateral: client.removeCollateral.bind(client),
    placeLimit: client.placeLimit.bind(client),
    cancelLimit: client.cancelLimit.bind(client),
    placeTrigger: client.placeTrigger.bind(client),
    cancelTrigger: client.cancelTrigger.bind(client),
    liquidatePosition: client.liquidatePosition.bind(client),

    // Setup / lifecycle
    initializeUserDepositLedger: client.initializeUserDepositLedger.bind(client),
    initializeBasket: client.initializeBasket.bind(client),
    delegateBasket: client.delegateBasket.bind(client),
    depositDirect: client.depositDirect.bind(client),
    withdraw: client.withdraw.bind(client),
    settleCustody: client.settleCustody.bind(client),

    async shutdown() {
      // Return per-phase warnings so SDK consumers can surface "shutdown
      // had N warnings" instead of guessing whether teardown was clean.
      const warnings: string[] = [];
      try { client.shutdown(); } catch (err) { warnings.push(`client.shutdown: ${err instanceof Error ? err.message : String(err)}`); }
      try { rpcManager.stopHealthMonitor(); } catch (err) { warnings.push(`rpcManager.stop: ${err instanceof Error ? err.message : String(err)}`); }
      try {
        // Defensive: if a downstream consumer attached this client to the
        // global reconciler, tear it off so the periodic tick doesn't keep
        // a reference past shutdown.
        const { getReconciler } = await import('./core/state-reconciliation.js');
        getReconciler().setClient(null);
      } catch (err) { warnings.push(`reconciler.detach: ${err instanceof Error ? err.message : String(err)}`); }
      try { walletManager.disconnect(); } catch (err) { warnings.push(`walletManager.disconnect: ${err instanceof Error ? err.message : String(err)}`); }
      return { warnings };
    },
  };
}

/** Re-export TradeSide for users who want to construct calls without the type import. */
export const Side = TradeSide;
