/**
 * Structured, PII-free telemetry for every AI intent call.
 *
 * One JSON line per call to ~/.magic/ai-telemetry.jsonl — enough to audit spend
 * and mis-parses later. The raw input is NEVER written here (only its hash); the
 * opt-in raw-phrasing corpus lives separately in input-log.ts.
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve, dirname } from 'path';

const TELEMETRY_PATH = resolve(homedir(), '.magic', 'ai-telemetry.jsonl');

export interface AiCallRecord {
  ts: string;
  hash: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  /** Tier-1 deterministic confidence for the input that triggered escalation. */
  tier1Confidence: number;
  cacheHit: boolean;
  /** null on success; otherwise why we fell back to regex-only. */
  fallbackReason: string | null;
  /** The alias the AI string resolved to AFTER re-parsing (firewall), or null. */
  resolvedAlias: string | null;
}

export function recordAiCall(
  rec: AiCallRecord,
  filePath = process.env.MAGIC_AI_TELEMETRY_PATH || TELEMETRY_PATH,
): void {
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(filePath, JSON.stringify(rec) + '\n', { mode: 0o600 });
  } catch {
    /* telemetry must never break the trading loop */
  }
}
