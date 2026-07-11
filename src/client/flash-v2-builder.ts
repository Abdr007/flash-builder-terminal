import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { assertNotKilled } from '../security/kill-switch.js';
import { getSigningGuard, type SigningAuditEntry } from '../security/signing-guard.js';
import { validateVersionedTxPrograms, assertRequiredSigners } from '../security/validate-programs.js';
import { readTextCapped } from '../utils/fetch-json.js';
import { verifyKeypairIntact } from './keypair-integrity.js';

export const FLASH_V2_API_URL = 'https://flashapi.trade';

// Map a builder endpoint name to the audit-log category. Anything without a
// specific bucket is logged as 'other' so no signed transaction goes unaudited.
function auditType(name: string): SigningAuditEntry['type'] {
  switch (name) {
    case 'openPosition': return 'open';
    case 'closePosition': return 'close';
    case 'increasePosition': return 'increase';
    case 'decreasePosition': return 'partial_close';
    case 'reversePosition': return 'reverse';
    case 'addCollateral': return 'add_collateral';
    case 'removeCollateral': return 'remove_collateral';
    case 'deposit': case 'depositDirect': return 'deposit';
    case 'withdraw': case 'requestWithdrawal': case 'withdrawalSettle': return 'withdraw';
    case 'placeTriggerOrder': case 'placeTpSl': case 'editTriggerOrder': case 'editLimitOrder': return 'limit_order';
    case 'cancelTriggerOrder': case 'cancelLimitOrder': case 'cancelAllTriggerOrders': return 'cancel_order';
    case 'custodySettlement': return 'settle';
    case 'initBasket': return 'init_basket';
    case 'initDepositLedger': return 'init_udl';
    case 'delegateBasket': return 'delegate_basket';
    default: return 'other';
  }
}

export interface TradeLimitParams {
  collateral: number;
  leverage: number;
  sizeUsd: number;
  market: string;
}

// Input tokens whose UI amount can be treated ~1:1 as USD collateral. Anything
// else (SOL, ETH, …) is a token QUANTITY, not dollars, so its `inputAmountUi`
// must NOT be fed to the USD-denominated risk caps.
const USD_STABLE_INPUT_TOKENS: ReadonlySet<string> = new Set(['USDC', 'USDT', 'USD']);

// Derive trade-limit params from the outbound body for builders that carry the
// needed fields (openPosition has collateral + leverage in the request). Used
// to enforce MAX_LEVERAGE / MAX_COLLATERAL_PER_TRADE / MAX_POSITION_SIZE at the
// sign boundary. Returns null when the op isn't a size-bearing trade, a
// caller-supplied override is expected instead, OR the collateral is a non-USD
// token whose USD value can't be derived from the body.
function deriveTradeLimits(name: string, body: JsonObject): TradeLimitParams | null {
  if (name === 'openPosition') {
    // `inputAmountUi` is denominated in the INPUT TOKEN. Treating a raw token
    // quantity as USD would let `open SOL long 10 5x --collateral-token SOL`
    // (10 SOL ≈ $1,500) sail under a $1,000 cap while being checked as "$10".
    // Only a USD-stable input token can be valued from the body; for any other
    // token we return null so the sign boundary FAILS CLOSED when caps are set
    // (RISK_BEARING_BUILDERS handling below) rather than under-counting. A
    // caller with an oracle price can still pass an explicit USD opts.tradeLimits.
    const inputToken = String(body.inputTokenSymbol ?? '').toUpperCase();
    if (!USD_STABLE_INPUT_TOKENS.has(inputToken)) return null;
    const collateral = Number(body.inputAmountUi);
    const leverage = Number(body.leverage);
    if (!Number.isFinite(collateral) || !Number.isFinite(leverage)) return null;
    return { collateral, leverage, sizeUsd: collateral * leverage, market: String(body.outputTokenSymbol ?? '') };
  }
  return null;
}

// Builders that GROW a position's size or leverage. Every one of these must be
// bounded by the configured MAX_* caps before signing. `openPosition` derives
// its limits from the request body above; the rest cannot (their bodies carry
// token amounts / deltas, not the resulting USD exposure) and MUST be handed an
// explicit `opts.tradeLimits` computed from the existing position by the caller.
//
// When a risk-bearing builder reaches the sign boundary with no resolvable
// limits AND a cap is configured, we FAIL CLOSED (refuse to sign) rather than
// silently bypass the operator's risk control. `addCollateral` is deliberately
// absent: it REDUCES leverage, so blocking it would break a trader de-risking a
// position to avoid liquidation.
const RISK_BEARING_BUILDERS: ReadonlySet<string> = new Set([
  'openPosition',
  'increasePosition',
  'reversePosition',
  'removeCollateral',
  // Entry-capable trigger builders: a hand-crafted `builder placeTriggerOrder
  // --sign` / `editTriggerOrder` can open size, so it must also fail closed when
  // caps are configured (deriveTradeLimits returns null for them → fail-closed
  // path below). First-class TP/SL uses `placeTpSl`, which is NOT here, so
  // protective stops on existing positions are unaffected.
  'placeTriggerOrder',
  'editTriggerOrder',
]);

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type FlashV2Route = 'trading' | 'funds';

export interface FlashV2OperationSpec {
  path: string;
  route: FlashV2Route;
  required: readonly string[];
  allowed: readonly string[];
}

/**
 * On-chain outcome of a submitted tx. A submit that returns a signature has NOT
 * necessarily landed — it can still revert (slippage, margin, oracle deviation,
 * paused market). We resolve this before declaring success.
 *  - 'confirmed': landed with no error.
 *  - 'failed':    landed with an on-chain error (reverted) — surfaced as a throw.
 *  - 'pending':   could not reach a terminal status in the confirm window
 *                 (fail-safe; never reported as confirmed).
 */
export type FlashV2Confirmation = 'confirmed' | 'failed' | 'pending';

export interface FlashV2SignedResult {
  signature: string;
  route: FlashV2Route;
  rpc?: string;
  response: JsonObject;
  signedTransactionBase64: string;
  snapshot?: JsonObject;
  /** Verified on-chain outcome. 'confirmed' or 'pending' here; 'failed' throws. */
  confirmation: FlashV2Confirmation;
}

/** Thrown when a submitted tx reverted on-chain. Carries the signature so the
 *  user can inspect it, and so callers never render a "success" card. */
export class FlashV2TxRevertedError extends Error {
  readonly signature: string;
  readonly onChainError: string;
  constructor(signature: string, onChainError: string) {
    super(`transaction reverted on-chain (${onChainError}) — signature ${signature}`);
    this.name = 'FlashV2TxRevertedError';
    this.signature = signature;
    this.onChainError = onChainError;
  }
}

export interface FlashV2PreviewOnlyResult {
  previewOnly: true;
  response: JsonObject;
}

export type FlashV2BuilderResult = FlashV2SignedResult | FlashV2PreviewOnlyResult;

export class FlashV2HttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'FlashV2HttpError';
    this.status = status;
    this.body = body;
  }
}

export class FlashV2ApiPayloadError extends Error {
  readonly body: unknown;

  constructor(message: string, body: unknown) {
    super(message);
    this.name = 'FlashV2ApiPayloadError';
    this.body = body;
  }
}

export class FlashV2FieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlashV2FieldError';
  }
}

export const FLASH_V2_BUILDERS = {
  openPosition: {
    path: '/transaction-builder/open-position',
    route: 'trading',
    required: ['inputTokenSymbol', 'outputTokenSymbol', 'inputAmountUi', 'leverage', 'tradeType'],
    allowed: [
      'discountIndex',
      'inputAmountUi',
      'inputTokenSymbol',
      'leverage',
      'limitPrice',
      'orderType',
      'outputTokenSymbol',
      'owner',
      'privilege',
      'referralAccount',
      'sessionToken',
      'signer',
      'slippagePercentage',
      'stopLoss',
      'takeProfit',
      'tokenStakeAccount',
      'tradeType',
    ],
  },
  closePosition: {
    path: '/transaction-builder/close-position',
    route: 'trading',
    required: ['marketSymbol', 'side', 'inputUsdUi', 'withdrawTokenSymbol', 'owner'],
    allowed: [
      'closeAll',
      'discountIndex',
      'inputUsdUi',
      'marketSymbol',
      'owner',
      'privilege',
      'referralAccount',
      'sessionToken',
      'side',
      'signer',
      'slippagePercentage',
      'tokenStakeAccount',
      'withdrawTokenSymbol',
    ],
  },
  increasePosition: {
    path: '/transaction-builder/increase-position',
    route: 'trading',
    required: ['marketSymbol', 'side', 'sizeAmountUi', 'collateralAmountUi', 'owner'],
    allowed: [
      'collateralAmountUi',
      'collateralTokenSymbol',
      'discountIndex',
      'marketSymbol',
      'owner',
      'privilege',
      'referralAccount',
      'sessionToken',
      'side',
      'signer',
      'sizeAmountUi',
      'slippagePercentage',
      'tokenStakeAccount',
    ],
  },
  decreasePosition: {
    path: '/transaction-builder/decrease-position',
    route: 'trading',
    required: ['marketSymbol', 'side', 'sizeAmountUi', 'owner'],
    allowed: [
      'discountIndex',
      'marketSymbol',
      'owner',
      'privilege',
      'referralAccount',
      'sessionToken',
      'side',
      'signer',
      'sizeAmountUi',
      'slippagePercentage',
      'tokenStakeAccount',
      'withdrawTokenSymbol',
    ],
  },
  reversePosition: {
    path: '/transaction-builder/reverse-position',
    route: 'trading',
    required: ['marketSymbol', 'side', 'leverage', 'owner'],
    allowed: [
      'discountIndex',
      'leverage',
      'marketSymbol',
      'owner',
      'privilege',
      'referralAccount',
      'sessionToken',
      'side',
      'signer',
      'slippagePercentage',
      'tokenStakeAccount',
    ],
  },
  addCollateral: {
    path: '/transaction-builder/add-collateral',
    route: 'trading',
    required: ['marketSymbol', 'side', 'depositAmountUi', 'depositTokenSymbol', 'owner'],
    allowed: ['depositAmountUi', 'depositTokenSymbol', 'marketSymbol', 'owner', 'sessionToken', 'side', 'signer'],
  },
  removeCollateral: {
    path: '/transaction-builder/remove-collateral',
    route: 'trading',
    required: ['marketSymbol', 'side', 'withdrawAmountUsdUi', 'withdrawTokenSymbol', 'owner'],
    allowed: ['marketSymbol', 'owner', 'sessionToken', 'side', 'signer', 'withdrawAmountUsdUi', 'withdrawTokenSymbol'],
  },
  placeTriggerOrder: {
    path: '/transaction-builder/place-trigger-order',
    route: 'trading',
    required: ['marketSymbol', 'side', 'triggerPriceUi', 'sizeAmountUi', 'isStopLoss', 'owner'],
    allowed: ['isStopLoss', 'marketSymbol', 'owner', 'sessionToken', 'side', 'signer', 'sizeAmountUi', 'triggerPriceUi'],
  },
  placeTpSl: {
    path: '/transaction-builder/place-tp-sl',
    route: 'trading',
    required: ['marketSymbol', 'side', 'sizeAmountUi', 'owner'],
    allowed: ['marketSymbol', 'owner', 'sessionToken', 'side', 'signer', 'sizeAmountUi', 'stopLossUi', 'takeProfitUi'],
  },
  editTriggerOrder: {
    path: '/transaction-builder/edit-trigger-order',
    route: 'trading',
    required: ['marketSymbol', 'side', 'orderId', 'isStopLoss', 'triggerPriceUi', 'sizeAmountUi', 'owner'],
    allowed: ['isStopLoss', 'marketSymbol', 'orderId', 'owner', 'sessionToken', 'side', 'signer', 'sizeAmountUi', 'triggerPriceUi'],
  },
  cancelTriggerOrder: {
    path: '/transaction-builder/cancel-trigger-order',
    route: 'trading',
    required: ['marketSymbol', 'side', 'orderId', 'isStopLoss', 'owner'],
    allowed: ['isStopLoss', 'marketSymbol', 'orderId', 'owner', 'sessionToken', 'side', 'signer'],
  },
  cancelAllTriggerOrders: {
    path: '/transaction-builder/cancel-all-trigger-orders',
    route: 'trading',
    required: ['marketSymbol', 'side', 'owner'],
    allowed: ['marketSymbol', 'owner', 'sessionToken', 'side', 'signer'],
  },
  editLimitOrder: {
    path: '/transaction-builder/edit-limit-order',
    route: 'trading',
    required: ['marketSymbol', 'side', 'orderId', 'owner'],
    allowed: ['limitPriceUi', 'marketSymbol', 'orderId', 'owner', 'sessionToken', 'side', 'signer', 'sizeAmountUi', 'stopLossUi', 'takeProfitUi'],
  },
  cancelLimitOrder: {
    path: '/transaction-builder/cancel-limit-order',
    route: 'trading',
    required: ['marketSymbol', 'side', 'orderId', 'owner'],
    allowed: ['marketSymbol', 'orderId', 'owner', 'sessionToken', 'side', 'signer'],
  },
  deposit: {
    path: '/transaction-builder/deposit',
    route: 'funds',
    required: ['owner', 'tokenSymbol', 'amount'],
    allowed: ['amount', 'owner', 'tokenSymbol'],
  },
  depositDirect: {
    path: '/transaction-builder/deposit-direct',
    route: 'funds',
    required: ['owner', 'tokenMint', 'amount'],
    allowed: ['amount', 'fundingOwner', 'owner', 'tokenMint'],
  },
  initBasket: {
    path: '/transaction-builder/init-basket',
    route: 'funds',
    required: ['owner'],
    allowed: ['owner', 'payer'],
  },
  initDepositLedger: {
    path: '/transaction-builder/init-deposit-ledger',
    route: 'funds',
    required: ['owner'],
    allowed: ['owner', 'payer'],
  },
  delegateBasket: {
    path: '/transaction-builder/delegate-basket',
    route: 'funds',
    required: ['owner'],
    allowed: ['owner', 'payer'],
  },
  undelegateBasket: {
    path: '/transaction-builder/undelegate-basket',
    route: 'funds',
    required: ['owner'],
    allowed: ['admin', 'owner'],
  },
  withdraw: {
    path: '/transaction-builder/withdraw',
    route: 'funds',
    required: ['owner', 'tokenSymbol', 'amount', 'feePayer'],
    allowed: ['amount', 'feePayer', 'feePayerTopUpLamports', 'owner', 'tokenSymbol'],
  },
  custodySettlement: {
    path: '/transaction-builder/custody-settlement',
    route: 'funds',
    required: ['owner', 'tokenSymbol'],
    allowed: ['owner', 'tokenSymbol'],
  },
  withdrawalSettle: {
    path: '/transaction-builder/withdrawal-settle',
    route: 'funds',
    required: ['owner', 'tokenMint'],
    allowed: ['owner', 'tokenMint'],
  },
  requestWithdrawal: {
    path: '/transaction-builder/request-withdrawal',
    route: 'funds',
    required: ['owner', 'tokenMint', 'amount', 'feePayer'],
    allowed: ['amount', 'feePayer', 'owner', 'tokenMint'],
  },
  initTradeVault: {
    path: '/transaction-builder/init-trade-vault',
    route: 'funds',
    required: ['owner', 'tokenMint'],
    allowed: ['owner', 'tokenMint'],
  },
  createReferral: {
    path: '/transaction-builder/create-referral',
    route: 'funds',
    required: ['owner', 'referrer'],
    allowed: ['owner', 'referrer'],
  },
  createSession: {
    path: '/transaction-builder/create-session',
    route: 'funds',
    required: ['owner', 'sessionPubkey'],
    allowed: ['feePayer', 'owner', 'sessionPubkey', 'topUp', 'validUntilSec'],
  },
  revokeSession: {
    path: '/transaction-builder/revoke-session',
    route: 'funds',
    required: ['owner', 'sessionPubkey'],
    allowed: ['feePayer', 'owner', 'sessionPubkey'],
  },
  initTokenStake: {
    path: '/transaction-builder/init-token-stake',
    route: 'funds',
    required: ['owner'],
    allowed: ['owner'],
  },
  stakeToken: {
    path: '/transaction-builder/stake-token',
    route: 'funds',
    required: ['owner', 'amount'],
    allowed: ['amount', 'owner'],
  },
  unstakeTokenRequest: {
    path: '/transaction-builder/unstake-token-request',
    route: 'funds',
    required: ['owner', 'amount'],
    allowed: ['amount', 'owner'],
  },
  cancelUnstakeTokenRequest: {
    path: '/transaction-builder/cancel-unstake-token-request',
    route: 'funds',
    required: ['owner', 'withdrawRequestId'],
    allowed: ['owner', 'withdrawRequestId'],
  },
  withdrawToken: {
    path: '/transaction-builder/withdraw-token',
    route: 'funds',
    required: ['owner', 'withdrawRequestId'],
    allowed: ['owner', 'tokenMint', 'withdrawRequestId'],
  },
  collectTokenReward: {
    path: '/transaction-builder/collect-token-reward',
    route: 'funds',
    required: ['owner'],
    allowed: ['owner', 'tokenMint'],
  },
  addLiquidityAndStake: {
    path: '/transaction-builder/add-liquidity-and-stake',
    route: 'funds',
    required: ['owner', 'inputTokenSymbol', 'amount'],
    allowed: ['amount', 'inputTokenSymbol', 'minLpAmountOut', 'owner', 'queueErAction', 'whitelisted'],
  },
  removeLiquidity: {
    path: '/transaction-builder/remove-liquidity',
    route: 'funds',
    required: ['owner', 'outputTokenSymbol', 'unstakeAmount'],
    allowed: ['minAmountOut', 'outputTokenSymbol', 'owner', 'queueErAction', 'rewardSymbol', 'unstakeAmount', 'whitelisted'],
  },
  addCompoundingLiquidity: {
    path: '/transaction-builder/add-compounding-liquidity',
    route: 'funds',
    required: ['owner', 'inputTokenSymbol', 'amount'],
    allowed: ['amount', 'inputTokenSymbol', 'minAmountOut', 'owner', 'queueErAction', 'rewardSymbol', 'whitelisted'],
  },
  removeCompoundingLiquidity: {
    path: '/transaction-builder/remove-compounding-liquidity',
    route: 'funds',
    required: ['owner', 'outputTokenSymbol', 'amount'],
    allowed: ['amount', 'minAmountOut', 'outputTokenSymbol', 'owner', 'queueErAction', 'rewardSymbol', 'whitelisted'],
  },
  collectStakeReward: {
    path: '/transaction-builder/collect-stake-reward',
    route: 'funds',
    required: ['owner'],
    allowed: ['includeTokenStake', 'owner', 'poolName', 'rewardSymbol'],
  },
  compoundFees: {
    path: '/transaction-builder/compound-fees',
    route: 'funds',
    required: ['keeper'],
    allowed: ['keeper', 'poolName', 'queueErAction', 'rewardSymbol'],
  },
  collectRebate: {
    path: '/transaction-builder/collect-rebate',
    route: 'funds',
    required: ['owner', 'rebateTokenMint'],
    allowed: ['owner', 'rebateTokenMint'],
  },
  collectRevenue: {
    path: '/transaction-builder/collect-revenue',
    route: 'funds',
    required: ['owner', 'revenueTokenMint'],
    allowed: ['owner', 'revenueTokenMint'],
  },
  settleRebates: {
    path: '/transaction-builder/settle-rebates',
    route: 'funds',
    required: ['keeper'],
    allowed: ['keeper', 'poolName', 'rewardSymbol'],
  },
} as const satisfies Record<string, FlashV2OperationSpec>;

export type FlashV2BuilderName = keyof typeof FLASH_V2_BUILDERS;

export const FLASH_V2_PREVIEWS = {
  limitOrderFees: {
    path: '/preview/limit-order-fees',
    required: ['marketSymbol', 'inputAmountUi', 'outputAmountUi', 'side'],
    allowed: ['inputAmountUi', 'limitPrice', 'marketSymbol', 'outputAmountUi', 'side'],
  },
  exitFee: {
    path: '/preview/exit-fee',
    required: ['marketSymbol', 'side', 'closeAmountUsdUi', 'owner'],
    allowed: ['closeAmountUsdUi', 'marketSymbol', 'owner', 'side'],
  },
  tpSl: {
    path: '/preview/tp-sl',
    required: ['mode', 'marketSymbol', 'side'],
    allowed: [
      'collateralUsdUi',
      'entryPriceUi',
      'marketSymbol',
      'mode',
      'owner',
      'side',
      'sizeUsdUi',
      'targetPnlUsdUi',
      'targetRoiPercent',
      'triggerPriceUi',
    ],
  },
  margin: {
    path: '/preview/margin',
    required: ['marketSymbol', 'side', 'marginDeltaUsdUi', 'action', 'owner'],
    allowed: ['action', 'marginDeltaUsdUi', 'marketSymbol', 'owner', 'side'],
  },
} as const;

export type FlashV2PreviewName = keyof typeof FLASH_V2_PREVIEWS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function endpointUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}${path.startsWith('/') ? path : `/${path}`}`;
}

function payloadMessage(body: unknown, fallback: string): string {
  if (isRecord(body)) {
    const error = body.error;
    if (typeof error === 'string' && error.length > 0) return error;
    const err = body.err;
    if (typeof err === 'string' && err.length > 0) return err;
    const message = body.message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return fallback;
}

function stripUndefined(body: Record<string, unknown>): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    out[key] = value as JsonValue;
  }
  return out;
}

function assertDocumentedPayload(
  name: string,
  body: Record<string, unknown>,
  required: readonly string[],
  allowed: readonly string[],
): JsonObject {
  const clean = stripUndefined(body);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(clean).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new FlashV2FieldError(`${name} contains undocumented field(s): ${unknown.join(', ')}`);
  }
  const missing = required.filter((key) => clean[key] === undefined || clean[key] === null || clean[key] === '');
  if (missing.length > 0) {
    throw new FlashV2FieldError(`${name} missing required field(s): ${missing.join(', ')}`);
  }
  return clean;
}

function assertResponseOk(body: unknown): void {
  if (!isRecord(body)) return;
  if (typeof body.error === 'string') {
    throw new FlashV2ApiPayloadError(body.error, body);
  }
  if (typeof body.err === 'string') {
    throw new FlashV2ApiPayloadError(body.err, body);
  }
}

function txBase64From(response: JsonObject): string | null | undefined {
  const value = response.transactionBase64;
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return undefined;
}

function looksExpiredBlockhash(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Narrow to GENUINE blockhash-expiry errors. The old pattern also matched a
  // bare "expired" (e.g. "session token expired", "order expired"), which would
  // trigger a needless rebuild-resign-resubmit of an unrelated failure.
  return /BlockhashNotFound|TransactionExpiredBlockheight|block height exceeded|blockhash[^.]*(not found|expired)/i.test(msg);
}

export function uiAmount(value: string | number): string {
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) throw new Error(`invalid UI amount: ${value}`);
  // Bound the magnitude: beyond ~1e15 a float can't represent integers exactly,
  // and `Number.toString()` switches to exponential (e.g. 1e21 → "1e+21"),
  // which the API's JSON-number/string parser would choke on.
  if (Math.abs(value) >= 1e15) throw new Error(`UI amount out of range: ${value}`);
  // Fixed notation always (toFixed never yields exponential).
  const out = Number.isInteger(value) ? value.toFixed(0) : value.toFixed(12).replace(/\.?0+$/, '');
  // A tiny non-zero that rounds to "0" at 12 decimals would silently send a
  // zero amount — reject rather than lose the value.
  if (value !== 0 && (out === '0' || out === '-0')) throw new Error(`UI amount underflows to zero: ${value}`);
  return out;
}

export class FlashV2BuilderClient {
  readonly baseUrl: string;
  private readonly l1Connection: Connection;
  /** Connection to the MagicBlock ER the trades actually land on. Confirmation
   *  MUST be polled here (it confirms in <1s), not on L1 (where the signature
   *  only settles seconds later). Optional so funds-only / test callers can omit. */
  private readonly erConnection?: Connection;
  /** How many status polls the last confirmOnChain took (diagnostics). */
  private lastConfirmAttempts = 0;

  constructor(opts: { baseUrl?: string; l1Connection: Connection; erConnection?: Connection }) {
    this.baseUrl = opts.baseUrl ?? FLASH_V2_API_URL;
    this.l1Connection = opts.l1Connection;
    this.erConnection = opts.erConnection;
  }

  /** A MagicBlock Ephemeral Rollup endpoint — single-sequencer instant finality,
   *  so a `processed` status there is TERMINAL (unlike an L1 `processed`). */
  private static isEphemeralRollup(url: string | undefined): boolean {
    return !!url && /magicblock\.app/i.test(url);
  }

  /**
   * Ask the chain whether a submitted tx actually LANDED before we declare
   * success. A `/submit-transaction` that returns a signature only proves the
   * bytes were accepted for propagation — the tx can still REVERT on-chain
   * (slippage cap, insufficient margin, oracle deviation, paused market). Polls
   * the same `getSignatureStatus` path the retry-recovery already relies on.
   *
   * FAIL-SAFE: on RPC trouble or if no terminal status appears within the
   * window, returns 'pending' — NEVER a false 'confirmed'. A definite on-chain
   * error returns 'failed' (the caller throws so no success card is rendered).
   */
  private async confirmOnChain(
    signature: string,
    opts?: { attempts?: number; intervalMs?: number },
  ): Promise<{ status: FlashV2Confirmation; onChainError?: string }> {
    // CRITICAL: poll the endpoint the tx actually LANDED on. Flash V2 trades
    // execute on the MagicBlock ER (flashtrade.magicblock.app) and confirm there
    // in <1s; the signature only settles to L1 seconds later. Polling the L1
    // connection for an ER tx finds NOTHING until that late settlement, so the
    // loop used to burn the entire ~18s window and return a false 'pending' —
    // the 18s "slow" trades. Poll the ER connection when we have one. On an ER,
    // a `processed` status is TERMINAL (single sequencer, instant finality) — no
    // firmer status is coming, so accepting it is correct, not premature. On L1
    // we still require confirmed/finalized.
    const conn = this.erConnection ?? this.l1Connection;
    const isEr = FlashV2BuilderClient.isEphemeralRollup(conn.rpcEndpoint);
    const attempts = opts?.attempts ?? 18;
    // Poll fast early (the ER confirms sub-second), then back off. Total window
    // stays ≈13s as a fail-safe for the rare slow case.
    const fastIntervalMs = 200;
    const slowIntervalMs = opts?.intervalMs ?? 750;
    const fastAttempts = 8;
    for (let i = 0; i < attempts; i++) {
      this.lastConfirmAttempts = i + 1;
      try {
        // A just-submitted signature is in the RPC's recent-status cache;
        // `searchTransactionHistory` forces an extra long-term-storage lookup
        // that adds latency per poll for no benefit on a fresh tx. Recent-cache
        // for all but the final attempt, history once as a safety net.
        const searchTransactionHistory = i === attempts - 1;
        const st = await conn.getSignatureStatus(signature, { searchTransactionHistory });
        const v = st?.value;
        if (v) {
          if (v.err) return { status: 'failed', onChainError: JSON.stringify(v.err) };
          if (
            v.confirmationStatus === 'confirmed' ||
            v.confirmationStatus === 'finalized' ||
            (isEr && v.confirmationStatus === 'processed')
          ) {
            return { status: 'confirmed' };
          }
          // L1 'processed' only → keep polling for a firmer status.
        }
      } catch {
        /* transient RPC error — keep trying, then fall through to fail-safe 'pending' */
      }
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, i < fastAttempts ? fastIntervalMs : slowIntervalMs));
      }
    }
    return { status: 'pending' };
  }

  async request(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(endpointUrl(this.baseUrl, path), {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
      signal: init?.signal ?? AbortSignal.timeout(20_000),
    });
    // Byte-cap the read: this is the single choke-point for the ENTIRE
    // money-moving API surface (every builder op + trade submit). A plain
    // res.text() bounds time (the 20s AbortSignal) but NOT bytes — a hostile or
    // MITM'd flashapi (or a poisoned baseUrl) could stream a multi-hundred-MB
    // body within the window and OOM the single-threaded REPL. 8MB comfortably
    // fits any legitimate tx/portfolio JSON. Non-JSON error bodies still pass
    // through (the JSON.parse below falls back to raw text as before).
    const text = await readTextCapped(res, 8_000_000);
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      throw new FlashV2HttpError(res.status, payloadMessage(body, `Flash V2 HTTP ${res.status}`), body);
    }
    assertResponseOk(body);
    return body;
  }

  async get(path: string): Promise<unknown> {
    return this.request(path, { method: 'GET' });
  }

  async post(path: string, body: JsonObject): Promise<JsonObject> {
    const value = await this.request(path, { method: 'POST', body: JSON.stringify(body) });
    if (!isRecord(value)) throw new FlashV2ApiPayloadError('Flash V2 response was not a JSON object', value);
    return value as JsonObject;
  }

  health(): Promise<unknown> {
    return this.get('/health');
  }

  tokens(): Promise<unknown> {
    return this.get('/tokens');
  }

  spotTokens(): Promise<unknown> {
    return this.get('/spot/tokens');
  }

  prices(symbol?: string): Promise<unknown> {
    return this.get(symbol ? `/prices/${encodeURIComponent(symbol.toUpperCase())}` : '/prices');
  }

  poolData(pubkey?: string): Promise<unknown> {
    return this.get(pubkey ? `/pool-data/${encodeURIComponent(pubkey)}` : '/pool-data');
  }

  raw(kind: 'pools' | 'custodies' | 'markets' | 'perpetuals', pubkey?: string): Promise<unknown> {
    return this.get(pubkey ? `/raw/${kind}/${encodeURIComponent(pubkey)}` : `/raw/${kind}`);
  }

  rawBasket(pubkey: string): Promise<unknown> {
    return this.get(`/raw/baskets/${encodeURIComponent(pubkey)}`);
  }

  owner(owner: string): Promise<JsonObject> {
    return this.get(`/owner/${encodeURIComponent(owner)}`).then((value) => {
      if (!isRecord(value)) throw new FlashV2ApiPayloadError('owner snapshot was not a JSON object', value);
      return value as JsonObject;
    });
  }

  positions(owner: string): Promise<JsonObject> {
    return this.get(`/positions/owner/${encodeURIComponent(owner)}`).then((value) => {
      if (!isRecord(value)) throw new FlashV2ApiPayloadError('positions response was not a JSON object', value);
      return value as JsonObject;
    });
  }

  orders(owner: string): Promise<JsonObject> {
    return this.get(`/orders/owner/${encodeURIComponent(owner)}`).then((value) => {
      if (!isRecord(value)) throw new FlashV2ApiPayloadError('orders response was not a JSON object', value);
      return value as JsonObject;
    });
  }

  preview(name: FlashV2PreviewName, body: Record<string, unknown>): Promise<JsonObject> {
    const spec = FLASH_V2_PREVIEWS[name];
    const payload = assertDocumentedPayload(name, body, spec.required, spec.allowed);
    return this.post(spec.path, payload);
  }

  build(name: FlashV2BuilderName, body: Record<string, unknown>): Promise<JsonObject> {
    const spec = FLASH_V2_BUILDERS[name];
    const payload = assertDocumentedPayload(name, body, spec.required, spec.allowed);
    return this.post(spec.path, payload);
  }

  async signAndSubmit(
    name: FlashV2BuilderName,
    body: Record<string, unknown>,
    signers: Keypair[],
    opts: { skipPreflight?: boolean; refreshOwner?: string; retryExpiredBlockhash?: boolean; tradeLimits?: TradeLimitParams; confirmAttempts?: number; confirmIntervalMs?: number } = {},
  ): Promise<FlashV2BuilderResult> {
    const spec = FLASH_V2_BUILDERS[name];
    // Signature of the most recently signed tx (set just before submit) so the
    // retry path can check whether the original already landed.
    let lastSignedSig: string | null = null;
    const trace = process.env.MAGIC_TRACE === '1';
    const T0 = Date.now();
    let tBuild = T0, tSubmit = T0;
    const execute = async (): Promise<FlashV2BuilderResult> => {
      const response = await this.build(name, body);
      tBuild = Date.now();
      const txBase64 = txBase64From(response);
      if (txBase64 === null || txBase64 === undefined) {
        return { previewOnly: true, response };
      }
      const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));

      // ─── SECURITY GATE — every real signing path funnels through here ────────
      // (open/close/increase/decrease/reverse/collateral/deposit/withdraw/
      // triggers/settlements all reach this via signV2 or a direct call). These
      // guards were previously wired ONLY into the legacy magic-client path the
      // product never executes; enforcing them here is what actually protects
      // the money path.
      const owner = signers[0]?.publicKey.toBase58() ?? '';
      const guard = getSigningGuard();
      // 1. Kill-switch: refuse to sign anything while tripped.
      assertNotKilled();
      // 2. Don't blind-sign what the API returned: every program must be
      //    allowlisted and every required signer must be one we intend.
      validateVersionedTxPrograms(tx, name);
      assertRequiredSigners(tx, signers.map((s) => s.publicKey.toBase58()), name);
      // 3. Trade limits (MAX_LEVERAGE / MAX_COLLATERAL / MAX_POSITION_SIZE).
      //    Enforced on EVERY size/leverage-growing builder — not just
      //    openPosition. Callers hand size-growing ops (increase / reverse /
      //    removeCollateral, and the auto-merge open→increase path) an explicit
      //    `opts.tradeLimits` computed from the resulting position exposure.
      const tl = opts.tradeLimits ?? deriveTradeLimits(name, body as JsonObject);
      if (tl) {
        const check = guard.checkTradeLimits(tl);
        if (!check.allowed) {
          try { guard.logAudit({ timestamp: new Date().toISOString(), type: auditType(name), market: tl.market, collateral: tl.collateral, leverage: tl.leverage, sizeUsd: tl.sizeUsd, walletAddress: owner, result: 'rejected', reason: check.reason }); } catch { /* audit best-effort */ }
          throw new FlashV2FieldError(check.reason ?? 'trade limit exceeded');
        }
      } else if (RISK_BEARING_BUILDERS.has(name) && guard.capsConfigured()) {
        // Fail CLOSED: a position-growing op reached the sign boundary with no
        // resolvable limits while the operator has caps configured. Refuse
        // rather than sign past an unenforceable cap.
        const reason =
          `refusing to sign ${name}: per-trade risk caps are configured but this operation's ` +
          `size/leverage could not be resolved to enforce them. Retry, or clear MAX_* caps to override.`;
        try { guard.logAudit({ timestamp: new Date().toISOString(), type: auditType(name), walletAddress: owner, result: 'rejected', reason }); } catch { /* audit best-effort */ }
        throw new FlashV2FieldError(reason);
      }
      // 4. Rate limit (records a slot on success — keep it last before signing).
      const rate = guard.checkRateLimit();
      if (!rate.allowed) {
        try { guard.logAudit({ timestamp: new Date().toISOString(), type: auditType(name), walletAddress: owner, result: 'rate_limited', reason: rate.reason }); } catch { /* best-effort */ }
        throw new FlashV2FieldError(rate.reason ?? 'rate limited');
      }
      // ─────────────────────────────────────────────────────────────────────────

      // Integrity check IMMEDIATELY before signing. `owner` was captured, then
      // build() awaited a network round-trip; if an idle-disconnect fired during
      // that await it zeroes the key buffer that Keypair holds by reference, and
      // tx.sign would emit a signature that can't verify against the owner —
      // wasting a submit and confusing the user. Mirror magic-client's guard:
      // throw a clear error instead. Fail-closed; only signers[0] (the owner
      // keypair) can be wiped this way — a generated fee-payer cannot.
      if (signers[0] && !verifyKeypairIntact(signers[0], owner)) {
        throw new FlashV2FieldError('wallet key unavailable (disconnected mid-sign) — reconnect and retry');
      }
      tx.sign(signers);
      const raw = tx.serialize();
      lastSignedSig = tx.signatures[0] && tx.signatures[0].length === 64 ? bs58.encode(tx.signatures[0]) : null;
      const signedTransactionBase64 = Buffer.from(raw).toString('base64');
      let signature: string;
      let rpc: string | undefined;
      // LATENCY (the ~18s "slow" trades): BOTH flashapi's /submit-transaction AND
      // the MagicBlock ER's sendTransaction hold their HTTP RESPONSE until the tx
      // commits to L1 (~18s with a public L1 RPC) — even though the tx is actually
      // submitted the instant the router receives the bytes, and the ER reports
      // it 'processed' in <1s. The unlock: we ALREADY hold the signature locally
      // (tx.signatures[0] === lastSignedSig); we don't need the blocking response
      // to tell us. So FIRE the submit without awaiting its response, and confirm
      // via getSignatureStatus (ER 'processed' in <1s). A submit that's rejected
      // simply never confirms → fail-safe 'pending', never a false success, and
      // we fire exactly once so there is no double-execute.
      // Set MAGIC_FLASHAPI_SUBMIT=1 to force the old blocking path if ever needed.
      const useDirectErSubmit =
        spec.route === 'trading' && !!this.erConnection && process.env.MAGIC_FLASHAPI_SUBMIT !== '1';
      if (useDirectErSubmit) {
        if (!lastSignedSig) throw new FlashV2FieldError('could not derive signature from signed transaction');
        signature = lastSignedSig;
        rpc = this.erConnection!.rpcEndpoint;
        void this.erConnection!.sendRawTransaction(raw, {
          // ER preflight adds latency and the pre-sign balance check + on-chain
          // confirm already guard correctness; skip it for the hot path.
          skipPreflight: opts.skipPreflight ?? true,
        }).catch(() => {
          /* a rejected submit never confirms → the poll returns fail-safe
             'pending'; swallow so it can't become an unhandled rejection */
        });
      } else if (spec.route === 'trading') {
        const submitted = await this.post('/transaction-builder/submit-transaction', {
          transactionBase64: signedTransactionBase64,
          ...(opts.skipPreflight !== undefined ? { skipPreflight: opts.skipPreflight } : {}),
        });
        if (typeof submitted.signature !== 'string') {
          throw new FlashV2ApiPayloadError('submit-transaction response missing signature', submitted);
        }
        signature = submitted.signature;
        rpc = typeof submitted.rpc === 'string' ? submitted.rpc : undefined;
      } else {
        signature = await this.l1Connection.sendRawTransaction(raw, {
          skipPreflight: opts.skipPreflight ?? false,
        });
      }
      // AUDIT — submit-time marker: record the signature the INSTANT it exists,
      // BEFORE the confirm poll. Otherwise a process kill during the ~13s confirm
      // window (e.g. Ctrl-C on the "confirming…" spinner) would leave a real,
      // on-the-wire (possibly landed) trade with NO audit record at all. The
      // terminal confirmed/failed/submitted record is still written below on the
      // normal path; this guarantees at-least-one record per signed+submitted tx.
      // Best-effort — never block or throw on the money path.
      try {
        guard.logAudit({
          timestamp: new Date().toISOString(),
          type: auditType(name),
          market: tl?.market, collateral: tl?.collateral, leverage: tl?.leverage, sizeUsd: tl?.sizeUsd,
          walletAddress: owner,
          result: 'submitted',
          txSignature: signature,
          reason: 'submit-time marker (pre-confirm)',
        });
      } catch { /* audit best-effort */ }
      tSubmit = Date.now();
      // Confirm the tx actually LANDED before declaring success — a submit that
      // returns a signature can still revert on-chain (slippage / margin /
      // oracle / paused). Fail-safe: 'pending' when we can't confirm in the
      // window; 'failed' is thrown below so no caller can render a success card.
      // Trading route only: funds ops (deposit/withdraw) already render 'pending'
      // cards and run the authoritative verify-withdraw ATA check downstream, so
      // we don't perturb that flow with a second confirmation here.
      //
      // INSTANT MODE (opt-in, MAGIC_INSTANT=1): optimistic UI. Render the trade
      // the instant it's fired ('pending') WITHOUT waiting for the confirm poll,
      // and verify in the BACKGROUND — a reverted tx surfaces as a warning on the
      // next prompt instead of blocking the card. Perceived latency drops to just
      // build+sign+fire (~85ms). Default OFF: the honest confirm-before-success
      // path (below) is unchanged unless the trader explicitly opts in.
      const instant = process.env.MAGIC_INSTANT === '1' && spec.route === 'trading';
      const conf: { status: FlashV2Confirmation; onChainError?: string } =
        instant
          ? { status: 'pending' }
          : spec.route === 'trading'
            ? await this.confirmOnChain(signature, { attempts: opts.confirmAttempts, intervalMs: opts.confirmIntervalMs })
            : { status: 'pending' };
      if (instant) {
        // Background verify: warn (never block) if the optimistically-rendered
        // trade actually reverted on-chain.
        void this.confirmOnChain(signature)
          .then((c) => {
            if (c.status === 'failed') {
              process.stderr.write(`\n⚠  trade ${signature.slice(0, 8)}… reverted on-chain (${c.onChainError ?? 'unknown'}) — re-check your position\n`);
            }
          })
          .catch(() => { /* background best-effort */ });
      }
      if (trace) {
        const now = Date.now();
        process.stderr.write(
          `\n[MAGIC_TRACE] ${name}: build=${tBuild - T0}ms submit=${tSubmit - tBuild}ms ` +
          `confirm=${now - tSubmit}ms (${this.lastConfirmAttempts} polls, ${conf.status}) ` +
          `total=${now - T0}ms · confirmEndpoint=${(this.erConnection ?? this.l1Connection).rpcEndpoint}\n`,
        );
      }
      const auditResult =
        conf.status === 'confirmed' ? 'confirmed' : conf.status === 'failed' ? 'failed' : 'submitted';
      // Audit trail — records the REAL on-chain outcome, not a blanket 'confirmed'.
      try {
        guard.logAudit({
          timestamp: new Date().toISOString(),
          type: auditType(name),
          market: tl?.market,
          collateral: tl?.collateral,
          leverage: tl?.leverage,
          sizeUsd: tl?.sizeUsd,
          walletAddress: owner,
          result: auditResult,
          txSignature: signature,
          ...(conf.onChainError ? { reason: `on-chain error: ${conf.onChainError}` } : {}),
        });
      } catch { /* audit is best-effort; never block on it */ }
      if (conf.status === 'failed') {
        // Reverted on-chain — surface as a failure so no "Position Opened" card
        // is ever rendered for a trade that did not land.
        throw new FlashV2TxRevertedError(signature, conf.onChainError ?? 'unknown');
      }
      const result: FlashV2SignedResult = {
        signature,
        route: spec.route,
        rpc,
        response,
        signedTransactionBase64,
        confirmation: conf.status,
      };
      if (opts.refreshOwner) {
        // FIRE-AND-FORGET: `result.snapshot` is written here and read by NO
        // caller (verified across src/) — every card renders from `response` /
        // `confirmation` / `signature`. Awaiting this owner GET only delayed the
        // success card by a full API round-trip (~50-150ms) on EVERY trade. Kick
        // it off without blocking; `.catch` so a floating rejection can't crash
        // the process. Confirmation is already fully determined above.
        void this.owner(opts.refreshOwner).catch(() => {
          /* best-effort warm; result intentionally unused */
        });
      }
      return result;
    };

    try {
      return await execute();
    } catch (err) {
      // AUDIT (Finding: unlogged signed-but-errored tx): if the tx was already
      // SIGNED before this error — e.g. the submit POST threw AFTER signing, so
      // the in-execute submit-time marker was never reached — record a marker
      // now so a signed tx can never be entirely absent from the audit trail.
      // Skip a REVERT (FlashV2TxRevertedError): its submit-time marker AND
      // terminal 'failed' record were already written inside execute().
      const auditSignedError = (): void => {
        if (!lastSignedSig || err instanceof FlashV2TxRevertedError) return;
        try {
          getSigningGuard().logAudit({
            timestamp: new Date().toISOString(),
            type: auditType(name),
            walletAddress: signers[0]?.publicKey.toBase58() ?? '',
            result: 'submitted',
            txSignature: lastSignedSig,
            reason: 'signed; errored before terminal audit record',
          });
        } catch { /* audit best-effort */ }
      };
      if (!opts.retryExpiredBlockhash || !looksExpiredBlockhash(err)) { auditSignedError(); throw err; }
      // NEVER blind-retry a funds op (deposit / withdraw). A blockhash-expiry
      // error is ambiguous — the original may already have landed — and a
      // second submit could DOUBLE the deposit/withdrawal. Surface it so the
      // user retries deliberately.
      if (spec.route === 'funds') { auditSignedError(); throw err; }
      // Trading route: only rebuild+resubmit if the original signature is
      // provably NOT on chain. If it landed, or we can't confirm its absence,
      // fail safe (don't risk a double-open) and rethrow.
      if (!lastSignedSig) throw err;
      let landed = true; // fail-safe default
      try {
        const st = await this.l1Connection.getSignatureStatus(lastSignedSig, { searchTransactionHistory: true });
        landed = !!st?.value; // present (any status) → it reached the chain
      } catch {
        landed = true; // couldn't check → assume it might have landed
      }
      if (landed) { auditSignedError(); throw err; }
      return execute();
    }
  }
}
