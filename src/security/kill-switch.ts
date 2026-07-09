/**
 * Persisted kill-switch.
 *
 * A flag file at `~/.magic/disabled` is checked at every transaction-signing
 * boundary (`sendErIxs`, `sendL1Ixs`). When present, every signing path
 * throws — across restarts, across processes, until removed.
 *
 * Use cases:
 *   - Panic-stop a runaway script that's chewing through the per-minute
 *     rate limit faster than you can Ctrl-C.
 *   - Disable signing on a shared host while you investigate a possible
 *     compromise without having to revoke RPC credentials.
 *   - Batch maintenance: disable, run admin reads, re-enable.
 *
 * The flag file has no content — its presence is the signal. Reason text
 * (if provided) is written into the file body for forensic context but
 * isn't required.
 *
 * Stat is fast (~5 µs on a warm fs cache); the per-trade overhead is below
 * any meaningful trading-latency budget.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

const FLAG_PATH = join(homedir(), '.magic', 'disabled');

export interface KillSwitchState {
  active: boolean;
  reason?: string;
  setAt?: number; // epoch ms
}

/** Returns true iff the kill-switch flag file is present. */
export function isKilled(): boolean {
  return existsSync(FLAG_PATH);
}

/** Read full state — useful for the UI to render a reason and timestamp. */
export function killSwitchState(): KillSwitchState {
  if (!existsSync(FLAG_PATH)) return { active: false };
  let reason: string | undefined;
  let setAt: number | undefined;
  try {
    // Stat-first: refuse to read pathological-size flag files (would only
    // happen if someone bypassed killSwitchOn and wrote raw to the path).
    const stat = statSync(FLAG_PATH);
    setAt = stat.mtimeMs;
    if (stat.size <= MAX_REASON_BYTES + 64) {
      const raw = readFileSync(FLAG_PATH, 'utf-8').trim();
      if (raw) reason = raw;
    }
  } catch {
    /* best-effort */
  }
  return { active: true, reason, setAt };
}

/**
 * Activate the kill-switch. Idempotent — re-arming overwrites the reason
 * and bumps mtime so `setAt` reflects the most recent kill.
 *
 * Reason text is capped at 1 KiB to defuse a trivial DoS where a user (or
 * compromised script) writes an unbounded reason and the prompt-render
 * path tries to read it on every keystroke.
 */
const MAX_REASON_BYTES = 1024;
export function killSwitchOn(reason = ''): void {
  const dir = dirname(FLAG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safe = reason.length > MAX_REASON_BYTES ? reason.slice(0, MAX_REASON_BYTES) + '…' : reason;
  writeFileSync(FLAG_PATH, safe, { mode: 0o600 });
}

/** Clear the kill-switch. No-op if it isn't currently set. */
export function killSwitchOff(): void {
  if (!existsSync(FLAG_PATH)) return;
  try { unlinkSync(FLAG_PATH); } catch { /* ignore */ }
}

/**
 * Throw a clear error message with the kill-switch's reason / timestamp
 * embedded so the user knows why their trade refused. Callers should run
 * this at the start of any signing path. The error includes a hint to
 * remove the flag via the CLI.
 */
export function assertNotKilled(): void {
  const state = killSwitchState();
  if (!state.active) return;
  const when = state.setAt ? new Date(state.setAt).toISOString() : 'unknown time';
  const why = state.reason ? ` (${state.reason})` : '';
  throw new Error(
    `kill-switch is active${why} since ${when}. ` +
    `Run 'magic resume' or remove ${FLAG_PATH} to re-enable signing.`,
  );
}
