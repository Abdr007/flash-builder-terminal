/**
 * SDK error mapper.
 *
 * Translates raw on-chain / SDK errors into actionable user-facing strings,
 * grounded in the Magic Trade IDL's `errors` array (codes 6000-6111) plus
 * Anchor's framework codes (3000-series). Includes setup hints when the
 * account chain isn't initialized.
 */

import idl from '@flash_trade/magic-trade-client/dist/idl/magic_trade.json' with { type: 'json' };
import { TradingError } from '../utils/errors.js';

interface IdlError {
  code: number;
  name: string;
  msg?: string;
}

const ERR_BY_CODE = new Map<number, IdlError>();
for (const e of (idl as { errors?: IdlError[] }).errors ?? []) {
  ERR_BY_CODE.set(e.code, e);
}

// Anchor framework errors we care about.
const ANCHOR_ERRORS: Record<number, { name: string; hint?: string }> = {
  3001: {
    name: 'InstructionFallbackNotFound',
    hint: 'SDK sent an instruction the program does not recognize — likely an SDK / IDL version mismatch. Try `npm update @flash_trade/magic-trade-client`.',
  },
  3002: {
    name: 'InstructionDidNotDeserialize',
    hint: 'Instruction args did not deserialize. Usually an SDK version mismatch with the on-chain IDL.',
  },
  3007: {
    name: 'AccountOwnedByWrongProgram',
    hint:
      'A custody/basket account is currently delegated to MagicBlock ER (owned by ' +
      'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh) and cannot be settled on L1 right now. ' +
      'This typically resolves on its own within a few minutes — try again. If it persists ' +
      'across multiple sessions, the pool needs the protocol authority to commit and undelegate ' +
      'the custody on L1 (a user-side action cannot resolve this).',
  },
  3010: {
    name: 'AccountDiscriminatorMismatch',
    hint: 'On-chain account exists but is the wrong type — likely program/IDL drift. Verify program id and SDK version.',
  },
  3012: {
    name: 'AccountNotInitialized',
    hint:
      'On-chain account not initialized. Run `setup` to create your basket + user-deposit-ledger, ' +
      'then `deposit USDC <amount>` to fund the vault before trading.',
  },
  3014: {
    name: 'AccountNotMutable',
    hint: 'Tried to write to an immutable account — usually a sysvar mistakenly used as writable. SDK bug.',
  },
  6000: { name: 'CustomError' },
};

/**
 * Map IDL error names to user-actionable hints. Only the high-frequency
 * trading paths get explicit hints; the rest fall through to the IDL's own
 * `msg` field via mapSdkError, which is already pretty readable.
 *
 * Keep these short — single-line, imperative, with the next-step the user
 * should take. The `{ctx}` is added by the caller.
 */
const NAMED_ERROR_HINTS: Record<string, string> = {
  // Insufficient resources
  InsufficientAvailableBalance:
    'Insufficient available basket balance (deposits minus obligations). Run `vault` to see balances; you may need to `settle` pending obligations or `deposit` more USDC.',
  InsufficientCollateral:
    'Insufficient collateral for this position. Try a smaller size or higher collateral.',
  InsufficientBalance:
    'Insufficient balance. Run `vault` or `wallet tokens` to see what you have, then `deposit` more.',
  InsufficientCustodyLiquidity:
    'Pool is out of free liquidity for this market. Try a smaller size or wait for the pool to refill.',
  InsufficientLockedAmount:
    'Position has less locked than the operation needs. Reduce the close/decrease size.',
  InsufficientPositionSize:
    'Decrease size is larger than the open position. Reduce the size or use `close` for a full close.',

  // Leverage / sizing
  MaxLeverage: 'Leverage exceeds the market cap. Run `markets` to see per-market leverage limits.',
  MaxInitLeverage: 'Leverage exceeds the initial-leverage cap for this market. Reduce leverage.',
  MinLeverage: 'Leverage is below the market minimum (typically 1.1x).',
  MinInitLeverage: 'Leverage is below the initial-leverage minimum for this market.',
  MaxPositionSize: 'Position would exceed the market max size. Reduce collateral or leverage.',
  PositionAmountLimit: 'Position would exceed the market max size. Reduce collateral or leverage.',
  MinCollateral: 'Collateral is below the market minimum. Add more collateral and retry.',
  MaxExposure: 'Pool exposure cap reached for this market. Try a smaller size or different market.',
  CustodyAmountLimit: 'Pool exposure cap reached for this market. Try a smaller size or different market.',
  ExposureLimitExceeded: 'Per-market exposure cap reached. Try a smaller size or different market.',

  // Slippage / price
  MaxPriceSlippage: 'Price slippage exceeded; the market moved while submitting. Retry the trade.',
  StaleOraclePrice: 'Oracle price is stale or invalid. Retry in a few seconds — typically self-recovers.',
  InvalidOraclePrice: 'Oracle price is invalid. Retry in a few seconds.',
  InvalidOracleState: 'Oracle is in an invalid state. Retry in a few seconds.',
  OracleDivergenceTooHigh:
    'Oracle prices diverged too far between sources — the program is refusing to trade until they reconcile. Retry in a few seconds.',
  OracleConfidenceTooWide:
    'Oracle confidence interval is too wide right now (high uncertainty / low liquidity feed). Retry in a few seconds or after the next pyth update.',
  StaleBackupOraclePrice: 'Backup oracle price is too stale. Retry in a few seconds.',

  // Triggers / limits
  InvalidStopLossPrice: 'Stop-loss price is on the wrong side of mark for this side. Long SL must be below mark; short SL must be above mark.',
  InvalidTakeProfitPrice: 'Take-profit price is on the wrong side of mark for this side. Long TP must be above mark; short TP must be below mark.',
  InvalidLimitPrice: 'Limit price is invalid for this side. Long limit must be below mark; short limit must be above.',
  InvalidTriggerPrice: 'Trigger price is invalid (typically on the wrong side of mark).',
  LimitPriceNotMet: 'Limit order condition not met — mark has not crossed your price yet.',
  TriggerPriceNotMet: 'Trigger order condition not met — mark has not crossed your trigger.',
  MaxStopLossOrders: 'Reached the max stop-loss orders for this position. `cancel-trigger` an existing one before adding another.',
  MaxTakeProfitOrders: 'Reached the max take-profit orders for this position. `cancel-trigger` an existing one before adding another.',
  MaxOpenOrder: 'Reached the open-order limit for this market. `cancel <N>` an existing one before adding another.',
  MaxOrdersReached: 'Reached the open-order limit. Run `orders` and cancel one before adding another.',
  OrderNotFound: 'Order id does not exist (or was already cancelled). Run `orders` to see live ids.',
  InvalidOrderIndex: 'Order index is out of range. Run `orders` to see valid ids.',

  // Pool pauses / mode
  CloseOnlyMode: 'This market is in close-only mode (typically during deleveraging). Existing positions can be closed; new opens are disabled.',
  TradeInitDisabled: 'New trades are disabled on this market. Existing positions can still be closed.',
  TradeMaintDisabled: 'Position maintenance (add/remove collateral, increase) is disabled for this market.',
  TradeLiquidationDisabled: 'Liquidations are disabled for this market right now.',
  UserDepositDisabled: 'Deposits are disabled. Wait for the protocol to re-enable.',
  UserWithdrawDisabled: 'Withdrawals are disabled. Wait for the protocol to re-enable.',
  LiquidityAddDisabled: 'Adding liquidity is currently disabled.',
  LiquidityRemoveDisabled: 'Removing liquidity is currently disabled.',
  InstructionNotAllowed: 'This instruction is not allowed at the moment (protocol paused or wrong context).',
  MaxUtilization: 'Token utilization limit reached on the pool. Try a smaller size or wait.',
  MaxDepostsReached: 'Vault has reached its max deposits cap. Wait for outflows or use a smaller deposit.',

  // Deposits / withdrawals lifecycle
  PendingDepositNotClaimed: "Your previous deposit hasn't been claimed yet. Run `status` then retry shortly.",
  NoDepositsToClaim: 'Nothing to claim — basket has no pending deposits.',
  NoWithdrawalPending: 'No withdrawal is pending. Run `withdraw <token> <amount>` to start one.',

  // Auth / config
  Unauthorized: 'Signer is not the position owner or an authorized delegate.',
  InvalidAccess: 'Only NFT holders or referred users can trade on this surface (program-side gate).',
  InvalidValidatorKey: 'ER validator key is invalid — the closest-validator lookup may have failed. Retry once.',

  // Math / sanity
  MathOverflow: 'Internal math overflow — usually triggered by extreme leverage or near-zero prices. Reduce size or wait.',
  ExponentMismatch: 'Oracle exponent mismatch between operands — typically a program/IDL drift signal.',
};

interface ParsedCustom {
  code: number;
  name?: string;
  msg?: string;
  hint?: string;
}

/** Extract a numeric `Custom: N` from an SDK / RPC error. */
function extractCustom(err: unknown): ParsedCustom | null {
  if (!err) return null;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : String((err as { message?: unknown }).message ?? '');
  const logs = (err as { logs?: string[]; transactionLogs?: string[] }).logs ?? (err as { transactionLogs?: string[] }).transactionLogs;

  // Pattern 1: `{ InstructionError: [N, { Custom: M }] }` in the message.
  const customMatch = message.match(/Custom['"]?\s*:\s*(\d+)/);
  if (customMatch) {
    const code = parseInt(customMatch[1], 10);
    return resolveCustom(code, logs);
  }

  // Pattern 2: `0xNNN` hex code in message (Anchor formatting).
  const hexMatch = message.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (hexMatch) {
    const code = parseInt(hexMatch[1], 16);
    return resolveCustom(code, logs);
  }

  // Pattern 3: parse the program logs themselves (`Error Number: NNNN`).
  if (logs && logs.length > 0) {
    for (const line of logs) {
      const m = line.match(/Error Number:\s*(\d+)/);
      if (m) {
        const code = parseInt(m[1], 10);
        return resolveCustom(code, logs);
      }
    }
  }

  return null;
}

function resolveCustom(code: number, logs?: string[]): ParsedCustom {
  const idlEntry = ERR_BY_CODE.get(code);
  if (idlEntry) return { code, name: idlEntry.name, msg: idlEntry.msg };
  const anchor = ANCHOR_ERRORS[code];
  if (anchor) return { code, name: anchor.name, hint: anchor.hint };
  // 0xbc4 is decimal 3012 (AccountNotInitialized).
  if (logs && logs.some((l) => /AccountNotInitialized/.test(l))) {
    return { code, name: 'AccountNotInitialized', hint: ANCHOR_ERRORS[3012].hint };
  }
  return { code };
}

/**
 * Map any SDK / on-chain error into a user-friendly single-line string.
 * If we can't recognise the error, fall back to the original message but
 * still surface the parsed program code when available.
 */
export function mapSdkError(err: unknown, context?: string): string {
  const parsed = extractCustom(err);
  const ctx = context ? `[${context}] ` : '';

  if (parsed) {
    if (parsed.name === 'AccountNotInitialized') {
      return `${ctx}${ANCHOR_ERRORS[3012].hint!}`;
    }
    // Named-error hint table — covers ~50 high-frequency program errors.
    if (parsed.name && NAMED_ERROR_HINTS[parsed.name]) {
      return `${ctx}${NAMED_ERROR_HINTS[parsed.name]}`;
    }
    if (parsed.hint) return `${ctx}${parsed.hint}`;
    if (parsed.msg) return `${ctx}${parsed.msg} (${parsed.name ?? `code ${parsed.code}`})`;
    if (parsed.name) return `${ctx}${parsed.name} (code ${parsed.code})`;
    return `${ctx}program error ${parsed.code}`;
  }

  // No on-chain code found — return the raw message (may already be helpful).
  return `${ctx}${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Wrap an unknown SDK / on-chain error in a `TradingError` so call sites can
 * `throw toTradingError(err, 'context')` without losing the original error
 * (kept as `cause`) AND without losing the parsed Anchor code/name. Pre-fix,
 * each site did `throw new Error(mapSdkError(...))` — that flattened the
 * stack to a string and made post-mortem debugging in NO_DNA pipelines a
 * nightmare because the agent saw the friendly hint but no chain context.
 */
export function toTradingError(err: unknown, context?: string): TradingError {
  const friendly = mapSdkError(err, context);
  const parsed = extractCustom(err);
  return new TradingError(friendly, {
    cause: err,
    anchorCode: parsed?.code,
    anchorName: parsed?.name,
    context: context ? { context } : undefined,
  });
}
