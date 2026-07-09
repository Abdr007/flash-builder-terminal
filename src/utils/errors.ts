/**
 * Typed error hierarchy for the Flash Magic Terminal.
 *
 * Every thrown error in this codebase should be one of these — or wrap the
 * original via `cause` if it came from outside (SDK, RPC, fs). Reasoning:
 *
 *   1. `instanceof` lets call sites branch on category (validation vs
 *      network vs trading) without parsing string messages.
 *   2. `.cause` (ES2022 Error.cause) preserves the original error for
 *      forensics — `console.error(err)` walks the chain automatically.
 *   3. A stable `code` field makes errors greppable in logs without
 *      relying on free-form messages that drift over time.
 *
 * Usage:
 *
 *   if (!Number.isFinite(collateral)) {
 *     throw new ValidationError('invalid collateral', { field: 'collateral', value: collateral });
 *   }
 *
 *   try {
 *     await rpc.send(tx);
 *   } catch (err) {
 *     throw new NetworkError('rpc send failed', { cause: err });
 *   }
 *
 * Catch sites that need a string message should use `getErrorMessage(err)`
 * from `utils/retry.ts` rather than `(err as Error).message` — the former
 * survives non-Error throws (strings, plain objects, undefined) which are
 * legal in JS and occur in some SDK code paths.
 */

/**
 * Base class. Never thrown directly — concrete subclasses below carry the
 * categorical meaning. Implements the ES2022 `cause` constructor option so
 * `Error.cause` chains work with `console.error` / structured loggers.
 */
export class FlashError extends Error {
  /** Stable, machine-greppable code. Subclasses override the default. */
  public readonly code: string;
  /** Free-form structured context — operation, params, hints. */
  public readonly context: Record<string, unknown>;

  constructor(
    message: string,
    options: { code?: string; cause?: unknown; context?: Record<string, unknown> } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.code = options.code ?? this.constructor.name;
    this.context = options.context ?? {};
    // V8: capture stack trace excluding the constructor frame itself.
    if (typeof (Error as unknown as { captureStackTrace?: (t: object, c: unknown) => void }).captureStackTrace === 'function') {
      (Error as unknown as { captureStackTrace: (t: object, c: unknown) => void })
        .captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * The user supplied input that failed validation. Always safe to render
 * directly to the user — never wraps a system error.
 *
 * Examples: NaN collateral, negative leverage, unknown market symbol,
 * malformed wallet path, ambiguous fuzzy match.
 */
export class ValidationError extends FlashError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { code: 'VALIDATION', context });
  }
}

/**
 * Configuration is missing or malformed. Distinct from ValidationError
 * because it usually means the env / config file needs editing, not the
 * command needs retyping.
 *
 * Examples: empty MAGIC_RPC_URL, malformed config.json, missing wallet
 * keypair file.
 */
export class ConfigError extends FlashError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { code: 'CONFIG', context });
  }
}

/**
 * The user-supplied or persistent state is correct, but the network /
 * external service failed. Retry-friendly.
 *
 * Examples: RPC timeout, Hermes 502, ER router down, fetch aborted.
 */
export class NetworkError extends FlashError {
  constructor(message: string, options: { cause?: unknown; context?: Record<string, unknown> } = {}) {
    super(message, { code: 'NETWORK', cause: options.cause, context: options.context });
  }
}

/**
 * On-chain or SDK-level trading failure. The trade was attempted but the
 * program / SDK rejected it. Subclass of TradingError carries the parsed
 * Anchor code where available so call sites can match without string-grep.
 *
 * Examples: AccountNotInitialized, InsufficientCollateral, MaxLeverage,
 * InvalidStopLossPrice, CloseOnlyMode.
 */
export class TradingError extends FlashError {
  /** Numeric on-chain error code (Anchor `Error Number: NNNN`), if parsed. */
  public readonly anchorCode?: number;
  /** Named on-chain error (`AccountNotInitialized`, etc.), if parsed. */
  public readonly anchorName?: string;
  constructor(
    message: string,
    options: { cause?: unknown; anchorCode?: number; anchorName?: string; context?: Record<string, unknown> } = {},
  ) {
    super(message, { code: 'TRADING', cause: options.cause, context: options.context });
    this.anchorCode = options.anchorCode;
    this.anchorName = options.anchorName;
  }
}

/**
 * A safety guard refused to sign — rate limit, position cap, kill switch,
 * keypair integrity check, program allowlist. NOT a system error: this
 * means the system worked correctly and the user/script must wait or
 * re-configure.
 */
export class GuardError extends FlashError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { code: 'GUARD', context });
  }
}

/**
 * Internal invariant violation — a "this should never happen" error. Any
 * AssertionError surfacing means there's a bug. Distinct category so log
 * pipelines can page on it.
 */
export class AssertionError extends FlashError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { code: 'ASSERTION', context });
  }
}

/**
 * Type guard for the categories above. Returns the typed instance or
 * null. Useful when you want to render different UI for different
 * categories without a switch on `.code`.
 */
export function asFlashError(err: unknown): FlashError | null {
  return err instanceof FlashError ? err : null;
}

/**
 * Walk the `Error.cause` chain and return all messages joined with " ← ".
 * Mirrors what `console.error` prints but produces a single line for log
 * lines that need to fit on one row.
 */
export function describeErrorChain(err: unknown, max = 4): string {
  const parts: string[] = [];
  let cur: unknown = err;
  let depth = 0;
  while (cur && depth < max) {
    if (cur instanceof Error) {
      parts.push(cur.message || cur.name);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      break;
    }
    depth++;
  }
  return parts.join(' ← ');
}
