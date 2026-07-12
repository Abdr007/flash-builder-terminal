/**
 * Atomic file write for on-disk state (config, wallet registry, session,
 * budget ledger). Writes to a same-directory temp file, fsyncs it, then
 * `rename(2)`s it over the target and fsyncs the directory. rename is atomic on
 * POSIX, so a crash / kill / full-disk mid-write can never leave a half-written
 * (truncated, unparseable) file — a concurrent or later reader sees either the
 * complete old contents or the complete new contents, never a partial one.
 *
 * The fsync of the temp fd (before rename) and of the directory (after) makes
 * the write durable across POWER LOSS too — without them, some filesystems
 * (e.g. ext4 `data=writeback`) can surface a zero-length target after a crash
 * that lands between the rename and the delayed data writeback. Directory fsync
 * is best-effort (unsupported on some platforms, e.g. Windows).
 *
 * A bare `writeFileSync(path, ...)` opens with O_TRUNC and streams bytes, so an
 * interruption between truncate and the final byte corrupts the file; the next
 * load then silently falls back to empty/defaults. This helper closes that gap.
 */
import { writeFileSync, renameSync, unlinkSync, mkdirSync, chmodSync, openSync, fsyncSync, closeSync } from 'fs';
import { dirname, basename, join } from 'path';
import { randomBytes } from 'crypto';

let seq = 0;

export function atomicWriteFileSync(target: string, data: string | Uint8Array, mode = 0o600): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Temp file lives in the TARGET's own (0700) directory — never the shared OS
  // temp dir — and its name mixes PID + counter + a cryptographically-random
  // suffix so it is UNPREDICTABLE (no symlink/TOCTOU pre-creation attack) and
  // never collides across processes.
  const tmp = join(dir, `.${basename(target)}.tmp.${process.pid}.${seq++}.${randomBytes(8).toString('hex')}`);
  try {
    // Write + fsync the temp file so its bytes are durably on disk BEFORE the
    // rename, then fsync the directory so the rename entry itself is durable.
    // `wx` = O_CREAT|O_EXCL: fail (not follow) if the path already exists, so a
    // pre-planted symlink at `tmp` can never redirect the write.
    const fd = openSync(tmp, 'wx', mode);
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
    try {
      const dfd = openSync(dir, 'r');
      try { fsyncSync(dfd); } finally { closeSync(dfd); }
    } catch { /* directory fsync unsupported on some platforms — best-effort */ }
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* temp may not exist */ }
    throw err;
  }
  // rename preserves the temp file's mode; re-assert in case an older file at
  // the target had looser perms and something inspects it mid-flight.
  try { chmodSync(target, mode); } catch { /* best-effort */ }
}
