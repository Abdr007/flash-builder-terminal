/**
 * Typed env getters.
 *
 * - `safeEnvNumber` — returns a finite number or fallback.
 * - `safeEnvBool`   — accepts `1/0/true/false/yes/no/on/off`.
 * - `safeEnvString` — returns the trimmed value or fallback.
 */

export function safeEnvNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function safeEnvBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return fallback;
}

/**
 * Strict variant — refuses unrecognised values for safety-critical flags
 * (e.g. `MAGIC_AUTO_CONFIRM`). Throws so the user gets an immediate, loud
 * failure instead of silently falling back to the default. The default
 * was the pain point: a typo like `MAGIC_AUTO_CONFIRM=disable` would let
 * the CLI auto-sign even though the user intended to disable that.
 */
export function safeEnvBoolStrict(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  throw new Error(
    `${key}=${raw} is not a recognised boolean. Accepted: 1/0, true/false, yes/no, on/off.`,
  );
}

export function safeEnvString(key: string, fallback: string): string {
  const raw = process.env[key];
  if (raw === undefined || raw === null) return fallback;
  const v = raw.trim();
  return v.length > 0 ? v : fallback;
}
