/**
 * Atomic file write for on-disk state (config, wallet registry, session,
 * budget ledger). Writes to a same-directory temp file then `rename(2)`s it
 * over the target. rename is atomic on POSIX, so a crash / kill / full-disk
 * mid-write can never leave a half-written (truncated, unparseable) file — a
 * concurrent or later reader sees either the complete old contents or the
 * complete new contents, never a partial one.
 *
 * A bare `writeFileSync(path, ...)` opens with O_TRUNC and streams bytes, so an
 * interruption between truncate and the final byte corrupts the file; the next
 * load then silently falls back to empty/defaults. This helper closes that gap.
 */
import { writeFileSync, renameSync, unlinkSync, mkdirSync, chmodSync } from 'fs';
import { dirname, basename, join } from 'path';

let seq = 0;

export function atomicWriteFileSync(target: string, data: string | Uint8Array, mode = 0o600): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // PID + monotonic counter → unique temp name without Math.random.
  const tmp = join(dir, `.${basename(target)}.tmp.${process.pid}.${seq++}`);
  try {
    writeFileSync(tmp, data, { mode });
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* temp may not exist */ }
    throw err;
  }
  // rename preserves the temp file's mode; re-assert in case an older file at
  // the target had looser perms and something inspects it mid-flight.
  try { chmodSync(target, mode); } catch { /* best-effort */ }
}
