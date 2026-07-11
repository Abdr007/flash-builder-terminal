/**
 * AI intent-layer configuration.
 *
 * THE TRADING FIREWALL (see src/ai/interpret.ts): AI is an INTERPRETER, never
 * an EXECUTOR. Everything here only decides WHETHER and HOW to consult the
 * model for natural-language understanding. The model's output is always
 * re-parsed through the same deterministic pipeline + confirmation as a typed
 * command, so if AI is fully disabled the terminal remains 100% capable of
 * trading. Nothing on the trading path depends on any value in this file.
 *
 * Cheap-by-default: the runtime model is Haiku 4.5 (the cheapest capable
 * Claude model), temperature 0, tight max_tokens, minimal prompt. AI is only
 * ever reached when the deterministic parser fails — see interpret.ts.
 */

/** Per-1M-token USD prices for the runtime models we may call. */
export const MODEL_PRICES: Record<string, { inUsdPerMTok: number; outUsdPerMTok: number }> = {
  'claude-haiku-4-5': { inUsdPerMTok: 1, outUsdPerMTok: 5 },
  'claude-sonnet-5': { inUsdPerMTok: 3, outUsdPerMTok: 15 },
  'claude-opus-4-8': { inUsdPerMTok: 5, outUsdPerMTok: 25 },
};

export interface AiConfig {
  /** Master switch. False → the whole Tier-2 path is skipped; regex-only mode. */
  enabled: boolean;
  /** Why AI is off, when `enabled` is false (for the status indicator). */
  disabledReason: string | null;
  apiKey: string;
  endpoint: string;
  apiVersion: string;
  /** Cheap classifier/parse model. */
  model: string;
  /** Stronger model, reserved for genuinely-ambiguous inputs (configurable). */
  escalationModel: string;
  temperature: number;
  maxTokens: number;
  /** Per-call wall-clock budget before we treat the API as unavailable. */
  timeoutMs: number;
  /**
   * Tier-1 confidence below which an input is AI-worthy. Deterministic parses
   * score at or above this by construction, so a successful parse never
   * escalates. DEFAULT IS CONSERVATIVE + UNCALIBRATED — there is no corpus of
   * real phrasings to tune it against yet (see input-log.ts). Recalibrate on
   * real telemetry before lowering it.
   */
  confidenceThreshold: number;
  /** Hard token caps → on hit, HARD switch to regex-only for the window. */
  sessionTokenCap: number;
  dailyTokenCap: number;
  cacheMax: number;
  cacheTtlMs: number;
  /** Opt-in: accrue a REAL corpus of inputs for later §4 calibration. */
  logInputs: boolean;
  /** Opt-in: store the raw normalized phrasing (not just its hash). */
  logRaw: boolean;
}

function envNum(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function envFlag(name: string): boolean {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Explicit off switch: `MAGIC_AI=0/false/off` or the `--no-ai` CLI flag. */
function isForcedOff(noAiFlag: boolean): boolean {
  if (noAiFlag) return true;
  const v = (process.env.MAGIC_AI ?? '').trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

/**
 * Build the AI config from env + the `--no-ai` flag. Pure — no I/O, no network.
 * The terminal boots and trades identically whether this returns enabled or not.
 */
export function loadAiConfig(noAiFlag = false): AiConfig {
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim();
  let disabledReason: string | null = null;
  if (noAiFlag || isForcedOff(noAiFlag)) disabledReason = 'disabled (--no-ai / MAGIC_AI=0)';
  else if (!apiKey) disabledReason = 'no ANTHROPIC_API_KEY';
  const enabled = disabledReason === null;

  const model = (process.env.MAGIC_AI_MODEL ?? '').trim() || 'claude-haiku-4-5';
  const escalationModel = (process.env.MAGIC_AI_ESCALATION_MODEL ?? '').trim() || 'claude-sonnet-5';

  return {
    enabled,
    disabledReason,
    apiKey,
    endpoint: (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/messages',
    apiVersion: '2023-06-01',
    model,
    escalationModel,
    temperature: 0,
    maxTokens: Math.round(envNum('MAGIC_AI_MAX_TOKENS', 150)),
    timeoutMs: Math.round(envNum('MAGIC_AI_TIMEOUT_MS', 4000)),
    confidenceThreshold: envNum('MAGIC_AI_CONFIDENCE_THRESHOLD', 0.75),
    sessionTokenCap: Math.round(envNum('MAGIC_AI_SESSION_TOKEN_CAP', 60_000)),
    dailyTokenCap: Math.round(envNum('MAGIC_AI_DAILY_TOKEN_CAP', 250_000)),
    cacheMax: Math.round(envNum('MAGIC_AI_CACHE_MAX', 256)),
    cacheTtlMs: Math.round(envNum('MAGIC_AI_CACHE_TTL_MS', 30 * 60_000)),
    logInputs: envFlag('MAGIC_AI_LOG_INPUTS'),
    logRaw: envFlag('MAGIC_AI_LOG_RAW'),
  };
}
