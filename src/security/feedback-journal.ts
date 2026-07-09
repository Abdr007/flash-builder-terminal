/**
 * Local feedback journal — `magic feedback "thing broke"` writes a
 * structured record to `~/.magic/feedback.jsonl` so users can capture
 * issues in-context with the env they hit them from. Append-only
 * NDJSON, mode 0600, never includes secret material.
 *
 * Why a local journal and not a webhook?
 *   - Privacy: nothing leaves the user's machine without explicit
 *     opt-in (and we don't ship any opt-in path right now — POST is on
 *     the user's roadmap, not ours).
 *   - Self-serve diagnostics: when a user reports "trade failed", they
 *     can attach `~/.magic/feedback.jsonl` and we have full env
 *     fingerprint (version, network, pool, RPC host) without asking 5
 *     follow-up questions.
 *   - Privacy of secrets: ALL URL credentials are masked through the
 *     same `maskRpcUrl` the audit log uses, so a user uploading the
 *     journal can't accidentally leak their Helius key.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { dirname, resolve } from 'path';
import { homedir } from 'os';
import { maskRpcUrl } from '../network/rpc-manager.js';

const JOURNAL_PATH = resolve(homedir(), '.magic', 'feedback.jsonl');
const MAX_LINE_BYTES = 4096; // PIPE_BUF safe; far above any realistic message
const MAX_BYTES = 5 * 1024 * 1024; // 5 MiB cap; older lines purged on rotate

export interface FeedbackEntry {
  ts: string;
  /** Free-form user message — truncated to 1 KiB. */
  message: string;
  /** Optional category — `bug`, `feature`, `praise`, `confusion`. */
  kind?: 'bug' | 'feature' | 'praise' | 'confusion' | 'other';
  /** Env fingerprint at capture time. NEVER includes raw RPC URL. */
  env: {
    version: string;
    node: string;
    platform: string;
    network: string;
    pool: string;
    rpcHost: string;
    walletConnected: boolean;
  };
  /** Optional last-error context the user wants attached. */
  lastError?: string;
}

/**
 * Build the env-fingerprint section of a feedback entry. Centralises
 * the masking rules so a future addition (e.g. SDK version) flows
 * through one place.
 */
export function buildEnvFingerprint(opts: {
  version: string;
  network: string;
  pool: string;
  l1RpcUrl: string;
  walletConnected: boolean;
}): FeedbackEntry['env'] {
  let rpcHost = '<unset>';
  try {
    rpcHost = new URL(opts.l1RpcUrl).hostname;
  } catch {
    // maskRpcUrl handles the credential-bearing case; we just want host.
    rpcHost = maskRpcUrl(opts.l1RpcUrl);
  }
  return {
    version: opts.version,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    network: opts.network,
    pool: opts.pool,
    rpcHost,
    walletConnected: opts.walletConnected,
  };
}

/**
 * Append a feedback entry to the journal. Best-effort — any I/O error
 * here gets swallowed so a stuck disk can't break the user's CLI flow.
 * Returns the path written to (or null on swallowed failure).
 */
export function recordFeedback(entry: FeedbackEntry): string | null {
  try {
    const dir = dirname(JOURNAL_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Truncate user-controllable strings so a 100 MB message can't fill
    // the journal in one write.
    const safe: FeedbackEntry = {
      ...entry,
      message: entry.message.slice(0, 1024),
      lastError: entry.lastError ? entry.lastError.slice(0, 1024) : undefined,
    };
    const line = JSON.stringify(safe);
    if (Buffer.byteLength(line, 'utf-8') > MAX_LINE_BYTES) return null;
    // Soft size cap — refuse to append once the file gets unwieldy.
    if (existsSync(JOURNAL_PATH)) {
      try {
        const size = statSync(JOURNAL_PATH).size;
        if (size > MAX_BYTES) return null;
      } catch { /* stat failure → still try to write */ }
    }
    appendFileSync(JOURNAL_PATH, line + '\n', { mode: 0o600 });
    return JOURNAL_PATH;
  } catch {
    return null;
  }
}

/** Read the last `limit` feedback entries (newest first). Used by `feedback list`. */
export function readFeedback(limit = 10): FeedbackEntry[] {
  try {
    if (!existsSync(JOURNAL_PATH)) return [];
    const lines = readFileSync(JOURNAL_PATH, 'utf-8').split('\n').filter(Boolean);
    const out: FeedbackEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]) as FeedbackEntry);
      } catch { /* skip corrupt line */ }
    }
    return out;
  } catch {
    return [];
  }
}
