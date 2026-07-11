import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { assertNotKilled } from '../security/kill-switch.js';
import { getSigningGuard, type SigningAuditEntry } from '../security/signing-guard.js';
import { validateVersionedTxPrograms, assertRequiredSigners } from '../security/validate-programs.js';

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

// Derive trade-limit params from the outbound body for builders that carry the
// needed fields (openPosition has collateral + leverage in the request). Used
// to enforce MAX_LEVERAGE / MAX_COLLATERAL_PER_TRADE / MAX_POSITION_SIZE at the
// sign boundary. Returns null when the op isn't a size-bearing trade or a
// caller-supplied override is expected instead.
function deriveTradeLimits(name: string, body: JsonObject): TradeLimitParams | null {
  if (name === 'openPosition') {
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

export interface FlashV2SignedResult {
  signature: string;
  route: FlashV2Route;
  rpc?: string;
  response: JsonObject;
  signedTransactionBase64: string;
  snapshot?: JsonObject;
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

  constructor(opts: { baseUrl?: string; l1Connection: Connection }) {
    this.baseUrl = opts.baseUrl ?? FLASH_V2_API_URL;
    this.l1Connection = opts.l1Connection;
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
    const text = await res.text();
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
    opts: { skipPreflight?: boolean; refreshOwner?: string; retryExpiredBlockhash?: boolean; tradeLimits?: TradeLimitParams } = {},
  ): Promise<FlashV2BuilderResult> {
    const spec = FLASH_V2_BUILDERS[name];
    // Signature of the most recently signed tx (set just before submit) so the
    // retry path can check whether the original already landed.
    let lastSignedSig: string | null = null;
    const execute = async (): Promise<FlashV2BuilderResult> => {
      const response = await this.build(name, body);
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

      tx.sign(signers);
      const raw = tx.serialize();
      lastSignedSig = tx.signatures[0] && tx.signatures[0].length === 64 ? bs58.encode(tx.signatures[0]) : null;
      const signedTransactionBase64 = Buffer.from(raw).toString('base64');
      let signature: string;
      let rpc: string | undefined;
      if (spec.route === 'trading') {
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
      // Audit trail — every signed+submitted tx is recorded (best-effort).
      try {
        guard.logAudit({
          timestamp: new Date().toISOString(),
          type: auditType(name),
          market: tl?.market,
          collateral: tl?.collateral,
          leverage: tl?.leverage,
          sizeUsd: tl?.sizeUsd,
          walletAddress: owner,
          result: 'confirmed',
          txSignature: signature,
        });
      } catch { /* audit is best-effort; never block a completed trade */ }
      const result: FlashV2SignedResult = {
        signature,
        route: spec.route,
        rpc,
        response,
        signedTransactionBase64,
      };
      if (opts.refreshOwner) {
        try {
          result.snapshot = await this.owner(opts.refreshOwner);
        } catch {
          // Write responses are not final state. Snapshot refresh is best-effort;
          // commands surface this rule in their user-facing cards.
        }
      }
      return result;
    };

    try {
      return await execute();
    } catch (err) {
      if (!opts.retryExpiredBlockhash || !looksExpiredBlockhash(err)) throw err;
      // NEVER blind-retry a funds op (deposit / withdraw). A blockhash-expiry
      // error is ambiguous — the original may already have landed — and a
      // second submit could DOUBLE the deposit/withdrawal. Surface it so the
      // user retries deliberately.
      if (spec.route === 'funds') throw err;
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
      if (landed) throw err;
      return execute();
    }
  }
}
