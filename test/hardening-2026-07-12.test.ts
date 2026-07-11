/**
 * Extreme-hardening pass (2026-07-12) — regression tests for the additive,
 * fail-safe fixes from the 6-surface adversarial + latency audit.
 *
 * Covered here (the unit-testable ones):
 *  - Terminal-render injection: sanitizeText strips control/ANSI bytes from
 *    untrusted display strings while leaving legitimate text byte-identical, and
 *    getErrorMessage (the central boundary for the confirm-card fallback row and
 *    every error card) applies it.
 *  - DoS: readTextCapped enforces a hard response-byte cap (Content-Length and
 *    streamed), the exact OOM vector on the money-path API client.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeText } from '../src/utils/sanitize-text.js';
import { getErrorMessage } from '../src/utils/retry.js';
import { readTextCapped } from '../src/utils/fetch-json.js';

describe('render-injection: sanitizeText', () => {
  it('strips ESC / CSI / C0 / DEL / C1 control bytes', () => {
    // Cursor-up + erase-line — the confirm-card repaint attack. The ESC bytes
    // are removed; the (now-inert) printable remnants stay.
    expect(sanitizeText('SOL\x1b[1A\x1b[2K$999')).toBe('SOL[1A[2K$999');
    expect(sanitizeText('a\x00b\x07c\x7fd')).toBe('abcd');
    expect(sanitizeText('x\x9bAy')).toBe('xAy'); // U+009B single-byte CSI
    // No ESC byte survives.
    expect(sanitizeText('\x1b[31mred\x1b[0m')).not.toContain('\x1b');
  });

  it('leaves legitimate content byte-identical (no false positives)', () => {
    for (const s of ['SOL', 'BTC-PERP', '0.4997', '$1,234.56', 'Insufficient USDC balance. Run `vault`.', '50x', '⚠ warning', '✔ done']) {
      expect(sanitizeText(s)).toBe(s);
    }
  });

  it('never throws and preserves length for control-free input', () => {
    const s = 'a'.repeat(500);
    expect(sanitizeText(s)).toHaveLength(500);
    expect(() => sanitizeText('')).not.toThrow();
  });

  it('getErrorMessage strips control bytes (confirm-card fallback + error cards)', () => {
    const evil = new Error('preview failed\x1b[2J\x1b[H✔ Position Opened');
    const out = getErrorMessage(evil);
    expect(out).not.toContain('\x1b');
    expect(out).toContain('preview failed'); // legit prose preserved
    expect(out).toContain('Position Opened'); // text kept, only escapes gone
  });
});

describe('DoS: readTextCapped byte cap', () => {
  const mkRes = (body: string, contentLength?: number): Response => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    const headers = new Headers();
    if (contentLength !== undefined) headers.set('content-length', String(contentLength));
    return new Response(stream, { headers });
  };

  it('rejects an oversized Content-Length up front', async () => {
    await expect(readTextCapped(mkRes('x', 10_000_000), 8_000_000)).rejects.toThrow(/too large/i);
  });

  it('aborts a stream that exceeds the cap even without Content-Length', async () => {
    const big = 'y'.repeat(200_000);
    await expect(readTextCapped(mkRes(big), 100_000)).rejects.toThrow(/cap/i);
  });

  it('returns the body unchanged when within cap', async () => {
    expect(await readTextCapped(mkRes('{"ok":true}'), 8_000_000)).toBe('{"ok":true}');
  });
});
