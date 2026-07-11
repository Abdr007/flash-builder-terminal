/**
 * Retry helper with exponential backoff + jitter, global retry budget,
 * and Retry-After parsing. Used wherever an RPC / SDK call may fail
 * transiently.
 */

import { getLogger } from './logger.js';
import { redactCommonSecrets } from '../security/redact-secrets.js';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5000,
};

const BUDGET_WINDOW_MS = 60_000;
const MAX_RETRIES_PER_WINDOW = 50;
const retryTimestamps: number[] = [];

const THROTTLE_WINDOW_MS = 30_000;
const errorThrottle = new Map<string, { firstAt: number; count: number; lastLogged: number }>();

function consumeRetryBudget(): boolean {
  const now = Date.now();
  while (retryTimestamps.length > 0 && retryTimestamps[0] < now - BUDGET_WINDOW_MS) {
    retryTimestamps.shift();
  }
  if (retryTimestamps.length >= MAX_RETRIES_PER_WINDOW) return false;
  retryTimestamps.push(now);
  return true;
}

function extractRateLimitDelay(error: Error): number {
  const msg = error.message ?? '';
  if (!msg.includes('429') && !msg.toLowerCase().includes('rate limit') && !msg.toLowerCase().includes('too many requests')) {
    return 0;
  }
  const m = msg.match(/[Rr]etry-?[Aa]fter[:\s]+(\d+)/);
  if (m) {
    const seconds = parseInt(m[1], 10);
    if (Number.isFinite(seconds) && seconds > 0 && seconds <= 300) return seconds * 1000;
  }
  return 2000;
}

export async function withRetry<T>(fn: () => Promise<T>, label: string, opts: Partial<RetryOptions> = {}): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs } = { ...DEFAULT_RETRY, ...opts };
  const logger = getLogger();
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt >= maxAttempts) break;

      if (!consumeRetryBudget()) {
        logger.warn('RETRY', `${label} retry budget exhausted (${MAX_RETRIES_PER_WINDOW} retries / ${BUDGET_WINDOW_MS / 1000}s) — failing fast`);
        break;
      }

      const rateDelay = extractRateLimitDelay(lastError);
      const delay = rateDelay > 0
        ? Math.min(rateDelay, maxDelayMs)
        : Math.min(baseDelayMs * 2 ** (attempt - 1) + Math.random() * baseDelayMs * 0.5, maxDelayMs);

      logger.info('RETRY', `${label} attempt ${attempt}/${maxAttempts} failed → retrying in ${Math.round(delay)}ms`, { error: lastError.message });
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  const now = Date.now();
  const t = errorThrottle.get(label);
  if (t && now - t.firstAt < THROTTLE_WINDOW_MS) {
    t.count++;
    if (t.count % 10 === 0 || now - t.lastLogged > 15_000) {
      logger.error('RETRY', `${label} failed after ${maxAttempts} attempts (${t.count} failures in ${Math.round((now - t.firstAt) / 1000)}s)`, { error: lastError?.message ?? 'unknown' });
      t.lastLogged = now;
    }
  } else {
    errorThrottle.set(label, { firstAt: now, count: 1, lastLogged: now });
    logger.error('RETRY', `${label} failed after ${maxAttempts} attempts`, { error: lastError?.message ?? 'unknown' });
    for (const [k, v] of errorThrottle) {
      if (now - v.firstAt > THROTTLE_WINDOW_MS * 2) errorThrottle.delete(k);
    }
  }

  throw lastError;
}

export function getErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  // Scrub credentials centrally. Many call sites do `console.log(getErrorMessage
  // (e))`, which bypasses the logger's own scrubber — an SDK/RPC error string
  // that embeds a path- or query-token RPC URL would otherwise leak a paid
  // credential into stdout or a screenshot. Redaction only strips credential
  // shapes, so error-type keywords used for control flow are untouched.
  return redactCommonSecrets(msg);
}
