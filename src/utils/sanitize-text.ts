/**
 * Neutralize terminal-control bytes in UNTRUSTED display strings.
 *
 * Strings that originate from the Flash Builder API, RPC responses, oracle
 * feeds, or on-chain token/market registries are rendered into cards the user
 * reads before signing — most critically the trade CONFIRM card. If such a
 * string carries raw ANSI/CSI escapes (e.g. cursor-up + erase-line), a
 * compromised or MITM'd endpoint could REPAINT an already-drawn confirm card —
 * rewrite `Leverage 50x` to look like `2x`, erase an `⚠ AI-interpreted`
 * warning, or forge a green `✔ Position Closed` — defeating the very gate the
 * card exists to be.
 *
 * This strips the C0 controls (0x00–0x1F, includes ESC 0x1B), DEL (0x7F), and
 * the C1 controls (0x80–0x9F, includes the single-byte CSI 0x9B). It leaves ALL
 * printable text — including every legitimate character in a market symbol,
 * price, or human-readable error — untouched, so a real `"SOL"`, `"0.4997"`, or
 * `"Insufficient USDC balance"` renders byte-identically.
 *
 * IMPORTANT: apply this to raw text BEFORE any `chalk`/color wrapping so it can
 * never strip the SGR codes we add ourselves for legitimate styling. It is a
 * safety sanitizer for untrusted content, NOT a width helper — that is
 * `stripAnsi`/`vlen`, which deliberately preserve the ESC byte.
 */
export function sanitizeText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}
