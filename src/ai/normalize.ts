/**
 * Input normalization + hashing for the intent layer.
 *
 * The normalized form is the cache key and the telemetry identity, so it must
 * be deterministic and stable: two phrasings that differ only in casing or
 * whitespace must collapse to the same string (so they never re-bill the AI).
 */

import { createHash } from 'crypto';

/**
 * Canonicalise an input line for caching/telemetry. Mirrors the sanitiser the
 * deterministic interpreter applies (control-char strip + whitespace collapse)
 * plus lowercase and trailing-punctuation strip so "Open SOL long 5 2x!" and
 * "open sol long 5 2x" share a cache entry.
 */
export function normalizeInput(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[.,!?;]+$/, '')
    .trim();
}

/** SHA-256 hex of the normalized input — the PII-free identity used in logs. */
export function hashInput(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}
