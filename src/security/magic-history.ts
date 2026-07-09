/**
 * Magic-mode local trade history — append-only JSONL at
 * `~/.magic/magic-history.jsonl`.
 *
 * Every magic trade (open / close / partial / increase / TP / SL / limit / etc.)
 * appends one line so the user can see what happened locally even when the
 * audit log got rotated. Independent of `~/.magic/signing-audit.log`, which
 * is the security audit; this is the user-facing journal.
 *
 * Rotation: at 10 MB, the file is renamed to `.old` (single ring) so the
 * journal can never grow without bound and `readFileSync` can never spike RSS.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

const LOG_PATH = join(homedir(), '.magic', 'magic-history.jsonl');
// Best-effort migration: an earlier version wrote to `~/.flash/magic-history.jsonl`.
// If the new path doesn't exist but the legacy one does, move it in-place so users
// don't lose their journal across the path consolidation.
const LEGACY_PATH = join(homedir(), '.flash', 'magic-history.jsonl');
const ROTATION_LOCK = LOG_PATH + '.rotate.lock';
const MAX_HISTORY_BYTES = 10 * 1024 * 1024;
// PIPE_BUF on Linux is 4096 bytes — POSIX guarantees O_APPEND writes up to
// this size are atomic across processes. We cap each line well under this so
// concurrent CLI sessions can't interleave a single entry's bytes.
const MAX_LINE_BYTES = 2048;
// Per-field cap to keep the line small even with verbose error reasons.
const MAX_FIELD_CHARS = 256;

export interface MagicTradeEntry {
  ts: string; // ISO timestamp
  type:
    | 'open'
    | 'close'
    | 'partial_close'
    | 'increase'
    | 'reverse'
    | 'add_collateral'
    | 'remove_collateral'
    | 'tp'
    | 'sl'
    | 'limit_place'
    | 'limit_cancel'
    | 'trigger_cancel'
    | 'liquidate'
    | 'deposit'
    | 'withdraw'
    | 'settle';
  market?: string;
  side?: 'long' | 'short';
  collateralUsd?: number;
  sizeUsd?: number;
  leverage?: number;
  triggerPriceUsd?: number;
  txSignature: string;
  network: 'mainnet-beta' | 'devnet';
  walletAddress: string;
}

function ensure(): void {
  const dir = dirname(LOG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // One-shot migration from the legacy ~/.flash/magic-history.jsonl path.
  if (!existsSync(LOG_PATH) && existsSync(LEGACY_PATH)) {
    try { renameSync(LEGACY_PATH, LOG_PATH); } catch { /* best-effort */ }
  }
}

/**
 * Rotate atomically across multiple processes. The first process to
 * successfully `open(O_CREAT|O_EXCL)` the lock file wins the rotation; all
 * other concurrent processes skip rotation this round and pick it up on
 * their next call. If the lock file is left behind by a crashed process,
 * its mtime is used to detect staleness — anything older than 60 s is
 * assumed dead and reclaimed.
 */
function rotateIfLarge(): void {
  try {
    if (!existsSync(LOG_PATH)) return;
    const size = statSync(LOG_PATH).size;
    if (size <= MAX_HISTORY_BYTES) return;

    // Reclaim a stale lock so a crashed process can't permanently block rotation.
    if (existsSync(ROTATION_LOCK)) {
      try {
        const lockAge = Date.now() - statSync(ROTATION_LOCK).mtimeMs;
        if (lockAge > 60_000) unlinkSync(ROTATION_LOCK);
      } catch { /* ignore */ }
    }

    let lockFd: number | null = null;
    try {
      // O_EXCL fails if the file already exists — atomic test-and-set.
      // 0o600 so only the owner can hold it.
      lockFd = openSync(ROTATION_LOCK, 'wx', 0o600);
    } catch {
      // Another process holds the lock; skip rotation this round.
      return;
    }
    try {
      const oldPath = LOG_PATH + '.old';
      try { renameSync(LOG_PATH, oldPath); } catch { /* fallthrough */ }
      writeFileSync(LOG_PATH, '', { mode: 0o600 });
    } finally {
      try { closeSync(lockFd); } catch { /* ignore */ }
      try { unlinkSync(ROTATION_LOCK); } catch { /* ignore */ }
    }
  } catch {
    // best-effort — never block trading on a rotation hiccup
  }
}

/**
 * Cap any string field to MAX_FIELD_CHARS so a verbose SDK error reason
 * can't push the JSON line past PIPE_BUF and break atomicity guarantees
 * across concurrent CLI processes.
 */
function truncateForJournal(entry: MagicTradeEntry): MagicTradeEntry {
  const out = { ...entry } as unknown as Record<string, unknown>;
  for (const key of Object.keys(out)) {
    const v = out[key];
    if (typeof v === 'string' && v.length > MAX_FIELD_CHARS) {
      out[key] = v.slice(0, MAX_FIELD_CHARS - 1) + '…';
    }
  }
  return out as unknown as MagicTradeEntry;
}

export function recordMagicTrade(entry: MagicTradeEntry): void {
  try {
    ensure();
    rotateIfLarge();
    let line = JSON.stringify(truncateForJournal(entry)) + '\n';
    // Final defense: if the JSON still exceeds MAX_LINE_BYTES even after
    // per-field truncation, fall back to a minimal but ALWAYS-VALID-JSON
    // stub that preserves the most important forensic fields. Slicing the
    // JSON mid-string would produce an unparseable line and break every
    // downstream reader. The `truncated: true` marker tells operators why
    // the entry is incomplete.
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      line = JSON.stringify({
        ts: entry.ts,
        type: entry.type,
        market: typeof entry.market === 'string' ? entry.market.slice(0, 32) : undefined,
        side: entry.side,
        network: entry.network,
        walletAddress: entry.walletAddress,
        txSignature: typeof entry.txSignature === 'string' ? entry.txSignature.slice(0, 88) : entry.txSignature,
        truncated: true,
      }) + '\n';
    }
    // appendFileSync uses O_APPEND; POSIX guarantees atomicity up to
    // PIPE_BUF (4096 bytes) on regular files for concurrent appenders.
    appendFileSync(LOG_PATH, line, { mode: 0o600 });
  } catch {
    // best-effort — don't crash on log failure
  }
}

/** Read most recent N entries, newest last. */
export function readMagicHistory(limit = 20, walletFilter?: string): MagicTradeEntry[] {
  if (!existsSync(LOG_PATH)) return [];
  try {
    const lines = readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
    const entries: MagicTradeEntry[] = [];
    for (const ln of lines) {
      try {
        const e = JSON.parse(ln) as MagicTradeEntry;
        if (walletFilter && e.walletAddress !== walletFilter) continue;
        entries.push(e);
      } catch {
        /* skip corrupt line */
      }
    }
    return entries.slice(-limit);
  } catch {
    return [];
  }
}
