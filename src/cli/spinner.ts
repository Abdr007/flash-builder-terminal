/**
 * Lazy spinner — only shows up if the operation actually takes long enough
 * to be perceived as a hang. Fast ops (cache hit, sub-100 ms RPC) finish
 * before the spinner ever appears, so the user sees zero animation noise
 * on the happy path.
 *
 * Three suppression rules:
 *  1. NO_DNA / non-TTY / NO_COLOR  — agents and piped output get nothing.
 *  2. Sub-threshold ops             — skipped if the work resolves before
 *                                     `delayMs` (default 200ms).
 *  3. Already-finished ops          — `stop()` after `done` is a no-op.
 *
 * Built on `ora` (already a dep). The contract: `withSpinner(label, fn)`
 * is functionally identical to `await fn()` — the spinner is pure UX
 * decoration that vanishes on success or failure.
 */

import ora, { type Ora } from 'ora';
import { c } from './magic-theme.js';

const DEFAULT_DELAY_MS = 200;

export interface SpinnerOptions {
  /** Don't show the spinner if the work resolves within this many ms. */
  delayMs?: number;
  /** Override the auto-suppression (force-show even in non-TTY). Rare. */
  force?: boolean;
}

/**
 * Wrap a Promise-producing function with a deferred spinner. Returns the
 * resolved value (or rethrows the rejection) — no behavior change beyond
 * presentation.
 */
export async function withSpinner<T>(
  label: string,
  fn: () => Promise<T>,
  opts: SpinnerOptions = {},
): Promise<T> {
  const suppress = !opts.force && (
    process.env.NO_DNA ||
    process.env.NO_COLOR ||
    !process.stdout.isTTY
  );
  if (suppress) return fn();

  const delay = opts.delayMs ?? DEFAULT_DELAY_MS;
  // `let` annotated explicitly so TS doesn't widen the initial `null` to `never`.
  let spinner: Ora | null = null;
  // Escalation hints: after 5s and 15s, swap the spinner label to tell the
  // user what's actually happening. Without this, a 90-second tx-confirmation
  // poll on a slow RPC reads as "the CLI is broken" — the user has no idea
  // their RPC is rate-limited and the CLI is waiting on the wire.
  const escalations: ReturnType<typeof setTimeout>[] = [];
  const startSpinner = (): void => {
    spinner = ora({
      text: c.muted(label),
      spinner: 'dots12',
      color: 'cyan',
    }).start();
    escalations.push(setTimeout(() => {
      if (spinner) spinner.text = c.warn(`${label}  ${c.faint('· still waiting on the chain (RPC slow)')}`);
    }, 5_000));
    escalations.push(setTimeout(() => {
      if (spinner) {
        spinner.text =
          c.warn(`${label}  `) +
          c.faint('· hung > 15s — public RPC is rate-limited; ') +
          c.cyan('rpc set <fast-url>') +
          c.faint(' will fix this');
      }
    }, 15_000));
  };
  // Spinner doesn't appear unless the work takes >= delayMs.
  const timer = setTimeout(startSpinner, delay);
  const stop = (): void => {
    clearTimeout(timer);
    for (const t of escalations) clearTimeout(t);
    const s = spinner;
    if (s) s.stop();
  };
  try {
    const result = await fn();
    stop();
    return result;
  } catch (err) {
    stop();
    throw err;
  }
}
