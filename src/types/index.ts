/**
 * Core types for flash-magic-terminal.
 *
 * Single-mode CLI — only magic-trading paths exist. Live + simulation
 * are out of scope (use the bolt-terminal v1 CLI for those).
 */

import { z } from 'zod';

// ─── Trade primitives ─────────────────────────────────────────────────────

export enum TradeSide {
  Long = 'long',
  Short = 'short',
}

// ─── Position / Portfolio shapes ───────────────────────────────────────────

export interface Position {
  pubkey: string;
  market: string;
  side: TradeSide;
  entryPrice: number;
  currentPrice: number;
  markPrice: number;
  sizeUsd: number;
  collateralUsd: number;
  leverage: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  liquidationPrice: number;
  openFee: number;
  totalFees: number;
  fundingRate: number;
  timestamp: number;
}

export interface Portfolio {
  walletAddress: string;
  balance: number;
  balanceLabel: string;
  totalCollateralUsd: number;
  totalUnrealizedPnl: number;
  totalRealizedPnl: number;
  totalFees: number;
  positions: Position[];
  totalPositionValue: number;
}

export interface MarketData {
  symbol: string;
  price: number;
  priceChange24h: number;
  openInterestLong: number;
  openInterestShort: number;
  maxLeverage: number;
  fundingRate: number;
}

// ─── Trade results ─────────────────────────────────────────────────────────

export interface OpenPositionResult {
  txSignature: string;
  entryPrice: number;
  liquidationPrice: number;
  sizeUsd: number;
  /** Open fee in USD (entry-fee component). 0 if unavailable. */
  feeUsd?: number;
  /**
   * `true` when `feeUsd` is a local estimate (synthesized quote path uses a
   * fixed 4 bp model to skip the SDK simulate). Callers that surface this
   * field to the user should label it as approximate. The canonical SDK
   * quote path leaves this `false`.
   */
  feeIsEstimate?: boolean;
  /** Lock-token symbol the position holds (USDC for stable longs, SOL/BTC/etc. for native). */
  lockSymbol?: string;
  /** True iff the user paid in a token different from the lock token. */
  swapRequired?: boolean;
}

export interface ClosePositionResult {
  txSignature: string;
  exitPrice: number;
  pnl: number;
  /** PnL as a percentage of collateral (positive = profit). */
  pnlPct?: number;
}

export interface CollateralResult {
  txSignature: string;
}

// ─── Tool definitions (used by tools/engine.ts) ────────────────────────────

export interface ToolContext {
  walletManager: import('../wallet/walletManager.js').WalletManager;
  config: MagicConfig;
}

export interface ToolResult {
  success: boolean;
  message: string;
  txSignature?: string;
  data?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: z.ZodType;
  execute: (params: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

// ─── App config ────────────────────────────────────────────────────────────

export interface MagicConfig {
  /** mainnet-beta or devnet. */
  network: 'mainnet-beta' | 'devnet';
  /** PoolConfig name from @flash_trade/magic-trade-client (default Pool.0 mainnet). */
  poolName: string;
  /** ER router URL — flashtrade.magicblock.app on mainnet. */
  erRpcUrl: string;
  /** Flash Trade V2 Builder API base URL. */
  flashApiUrl: string;
  /** L1 mainnet RPC for UDL reads + L1-side ixs. */
  l1RpcUrl: string;
  /** Override the FMT program ID. Default reads from PoolConfig. */
  programIdOverride?: string;
  /** Wallet keypair file path. Default ~/.config/solana/id.json. */
  walletPath: string;
  /** Optional dedicated withdrawal escrow fee-payer keypair path. */
  withdrawFeePayerPath?: string;
  /** Optional lamports forwarded to the withdrawal fee-payer when the API uses it. */
  withdrawFeePayerTopUpLamports?: number;
  /** Compute-unit price (microlamports) for L1 ixs. */
  computeUnitPrice: number;
  /** Skip Y/N preview before signing — default true (speed-first). */
  autoConfirm: boolean;
  /** ER trade ixs use skipConfirm and return immediately. */
  fastConfirm: boolean;
  /** Max collateral per single trade (USD). 0 = unlimited. */
  maxCollateralPerTrade: number;
  /** Max position size per single trade (USD). 0 = unlimited. */
  maxPositionSize: number;
  /** Max leverage allowed. 0 = use market defaults. */
  maxLeverage: number;
  /** Max signing operations per minute. */
  maxTradesPerMinute: number;
  /** Min ms between consecutive signings. */
  minDelayBetweenTradesMs: number;
}
