/**
 * Opt-in corpus accrual for empirical threshold calibration (§4).
 *
 * There is no log of real natural-language inputs today, and fabricating a
 * corpus is forbidden — so we INSTRUMENT and let a REAL corpus accrue from real
 * use. Off by default. When `MAGIC_AI_LOG_INPUTS=1`, each resolved input appends
 * a hash-only record; only when the user ALSO sets `MAGIC_AI_LOG_RAW=1` is the
 * normalized phrasing stored, so a real, user-authorised corpus builds up that a
 * later calibration pass can measure Tier-1 coverage against — never synthetic.
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve, dirname } from 'path';

const CORPUS_PATH = resolve(homedir(), '.magic', 'intent-corpus.jsonl');

export interface IntentCorpusRecord {
  ts: string;
  hash: string;
  len: number;
  /** Tier that resolved it: 0 structured, 1 deterministic-NL, 2 AI, 'none'. */
  tier: 0 | 1 | 2 | 'none';
  tier1Confidence: number;
  aiInterpreted: boolean;
  resolvedAlias: string | null;
  /** Present only under MAGIC_AI_LOG_RAW=1 — a real phrasing the user typed. */
  raw?: string;
}

export function logIntentInput(
  rec: IntentCorpusRecord,
  opts: { logInputs: boolean; logRaw: boolean },
  filePath = process.env.MAGIC_AI_CORPUS_PATH || CORPUS_PATH,
): void {
  if (!opts.logInputs) return;
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const out: IntentCorpusRecord = opts.logRaw ? rec : { ...rec, raw: undefined };
    appendFileSync(filePath, JSON.stringify(out) + '\n', { mode: 0o600 });
  } catch {
    /* corpus accrual is best-effort */
  }
}
