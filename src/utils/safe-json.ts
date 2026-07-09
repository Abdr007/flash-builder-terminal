/**
 * Safe JSON parsing — prevents crashes from malformed JSON files.
 *
 * Used for all user-editable config/state files that could become
 * corrupted (power loss, concurrent writes, manual edits).
 */

import { getLogger } from './logger.js';

export function safeJsonParse<T>(content: string, fallback: T, context?: string): T {
  try {
    return JSON.parse(content) as T;
  } catch (err: unknown) {
    const where = context ? ` (${context})` : '';
    const detail = err instanceof Error ? err.message : 'unknown error';
    getLogger().warn('CONFIG', `Malformed JSON${where}: ${detail} — using fallback`);
    return fallback;
  }
}
