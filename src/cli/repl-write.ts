/**
 * REPL-safe stdout helper.
 *
 * Background tickers (RPC failover, ER-tx post-confirm warnings, alert
 * dispatches) need to print to stdout WITHOUT corrupting the line the user
 * is currently typing on. The naïve `process.stdout.write('\n  msg\n')`
 * inserts the message in the middle of the user's in-flight prompt buffer,
 * leaving "  msgflash › open SOL lo" stuck on screen until the user redraws.
 *
 * The fix is the standard readline-friendly dance:
 *   1. clear the current line + cursor-to-start with `\r\x1b[2K`
 *   2. write the message
 *   3. ask readline to re-render its prompt + the buffered input
 *
 * The active readline interface is registered once at terminal startup so
 * background callers don't need to plumb a reference; if no interface is
 * registered (running before/after the REPL is up) we just write directly.
 *
 * NOT a queue — calls are immediate. The point isn't ordering, it's prompt
 * preservation.
 */

import type { Interface } from 'readline';

let _rl: Interface | null = null;

/** Register the active readline interface so background writers can find it. */
export function bindReadline(rl: Interface): void {
  _rl = rl;
}

/** Forget the readline interface (called on shutdown). */
export function unbindReadline(): void {
  _rl = null;
}

/**
 * Write a line of output without corrupting the active prompt. Always
 * appends a trailing newline so the prompt redraws on its own line.
 *
 * If stdout is closed (post-shutdown background tick), the write is silently
 * dropped — propagating EPIPE here would crash the unhandledException path.
 */
export function replSafeWrite(text: string): void {
  // Normalise CRLF → LF before deciding to append a newline. A Windows-style
  // payload ending in `\r\n` would otherwise satisfy `endsWith('\n')` while
  // also containing an embedded CR that lands the prompt redraw on top of
  // the user's input.
  const normalised = text.replace(/\r\n/g, '\n').replace(/\r/g, '');
  const out = normalised.endsWith('\n') ? normalised : normalised + '\n';
  try {
    if (!_rl) {
      process.stdout.write(out);
      return;
    }
    // Clear the current line + carriage-return so the message lands at
    // column 0, then write the message, then ask readline to redraw the
    // prompt + the user's in-progress input.
    process.stdout.write('\r\x1b[2K' + out);
    // `_rl.prompt(true)` preserves the input buffer; without `true` the
    // user's typing-in-progress vanishes.
    _rl.prompt(true);
  } catch {
    // stdout closed (post-shutdown) — drop silently.
  }
}
