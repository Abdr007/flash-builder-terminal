/**
 * Read + JSON-parse a fetch Response with a HARD response-byte cap.
 *
 * A plain `await res.json()` bounds nothing: `AbortSignal.timeout()` caps *time*
 * but not *bytes*, so a hostile or MITM-with-valid-cert endpoint (or a poisoned
 * API URL) can stream a multi-hundred-MB body within the timeout and OOM the
 * process. This streams the body, aborts the socket the instant the cap is
 * exceeded, and rejects an oversized Content-Length up front. Mirrors the
 * reference reader in `data/fstats-volume.ts`.
 *
 * The default cap (4 MB) comfortably fits any price/market/registry payload this
 * CLI reads while staying far below a memory-exhaustion threshold.
 */
export async function readJsonCapped<T = unknown>(
  res: Response,
  maxBytes = 4_000_000,
): Promise<T> {
  const contentLength = res.headers.get('content-length');
  if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
    throw new Error(`response too large: ${contentLength} bytes > ${maxBytes} cap`);
  }
  const reader = res.body?.getReader();
  // Undici always provides a streamable body; the fallback keeps type-safety if
  // a polyfilled fetch ever doesn't (Content-Length guard above still applies).
  if (!reader) return (await res.json()) as T;
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`response exceeded ${maxBytes} byte cap`);
      }
      text += decoder.decode(value, { stream: true });
    }
  }
  text += decoder.decode();
  return JSON.parse(text) as T;
}
