/**
 * Typed env getters.
 *
 * - `safeEnvNumber` — returns a finite number or fallback.
 * - `safeEnvBool`   — accepts `1/0/true/false/yes/no/on/off`.
 * - `safeEnvString` — returns the trimmed value or fallback.
 */

export function safeEnvNumber(
  key: string,
  fallback: number,
  opts?: { min?: number; max?: number },
): number {
  // Fail LOUD on out-of-range values for BOUNDED settings — and validate the
  // fallback too, not just the env var. The fallback is frequently sourced from
  // config.json (e.g. `file.max_leverage ?? 0`), which is a semi-trusted,
  // hand-editable file. A silent clamp or an unchecked fallback is exactly how a
  // mistyped cap (`"max_leverage": -1`) or a non-number quietly turned the guard
  // OFF — the `> 0` gate reads a negative / NaN as "disabled". Bounding only the
  // env path (as before) left the config path fail-OPEN.
  const validate = (n: number, source: string): number => {
    if (!Number.isFinite(n)) {
      throw new Error(`${source} value "${n}" is not a finite number.`);
    }
    if (opts?.min !== undefined && n < opts.min) {
      throw new Error(`${source}=${n} is below the minimum ${opts.min}.`);
    }
    if (opts?.max !== undefined && n > opts.max) {
      throw new Error(`${source}=${n} is above the maximum ${opts.max}.`);
    }
    return n;
  };
  const raw = process.env[key];
  let candidate: number;
  let source: string;
  if (raw === undefined || raw === null || raw === '') {
    // No env override → use the fallback (may carry an untrusted config.json value).
    candidate = Number(fallback);
    source = `${key} (config.json)`;
  } else {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      // Garbage env value → ignore it and use the fallback (lenient, unchanged),
      // but the fallback is still validated below when the setting is bounded.
      candidate = Number(fallback);
      source = `${key} (config.json)`;
    } else {
      candidate = n;
      source = key;
    }
  }
  // Only bounded settings (opts present) are validated — this is where a bad
  // value silently disables a safety cap. Unbounded settings keep prior leniency.
  return opts ? validate(candidate, source) : candidate;
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
