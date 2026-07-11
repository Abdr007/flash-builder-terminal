/**
 * Tiered intent resolver — deterministic-first, AI last, firewall always.
 *
 *   Tier 0  structured / known-verb grammar   → deterministic, zero AI
 *   Tier 1  regex/grammar natural-language    → deterministic, zero AI
 *   Tier 2  AI interpreter                     → advisory string, RE-PARSED
 *
 * THE FIREWALL: the AI never produces the final command. It emits a canonical
 * command STRING which is fed back through the SAME deterministic `parse`
 * function a typed command goes through. If the model emits anything the
 * grammar rejects (a bogus market, an injection, a malformed line), `parse`
 * returns null and we refuse. The resulting command is then subject to the same
 * mandatory confirmation, risk checks, and market resolution as any typed one.
 *
 * Tier 2 is reached ONLY when the deterministic parser fails AND the input
 * looks like a trade attempt AND AI is enabled, in-budget, and reachable — so
 * the overwhelming majority of inputs never touch the model. If AI is disabled
 * or exhausted, the resolver degrades silently to the deterministic result and
 * never guesses a trade.
 */

import type { ParsedCommand } from '../cli/interpreter.js';
import type { AiConfig } from './config.js';
import { IntentCache } from './cache.js';
import { BudgetLedger } from './budget.js';
import { normalizeInput, hashInput } from './normalize.js';
import { callAiInterpreter, type AiClientResult, type AiClientError } from './client.js';
import { recordAiCall } from './telemetry.js';
import { logIntentInput } from './input-log.js';

export type Tier = 0 | 1 | 2 | 'none';

export interface ResolveResult {
  /** The validated command, or null (deterministic "unknown command"). */
  command: ParsedCommand | null;
  tier: Tier;
  confidence: number;
  /** True iff the command came from the model (forces a confirm + "AI" badge). */
  aiInterpreted: boolean;
  /** The canonical string the model emitted, when aiInterpreted. */
  aiSource?: string;
  /** True when AI was wanted but unavailable/exhausted/failed (visible fallback). */
  degraded: boolean;
  /** Why we fell back, when relevant (null on a clean deterministic result). */
  fallbackReason: string | null;
}

/** A parse function bound to the caller's live config (may throw on ambiguity). */
export type ParseFn = (line: string) => ParsedCommand | null;
type ClientFn = (line: string, cfg: AiConfig) => Promise<AiClientResult | AiClientError>;

const STRUCTURED_LEAD =
  /^(?:open|close|long|short|buy|sell|limit|reverse|flip|increase|partial|add|remove|tp|sl|set|trigger|cancel|deposit|withdraw|price|markets?|portfolio|positions?|close-?all)\b/;

const INTENT_WORDS =
  /\b(?:long|short|buy|sell|open|close|deposit|withdraw|flip|reverse|limit|leverage|lever|position|margin|collateral|tp|sl|profit|stop|add|remove|increase|size|fund)\b/;

/** Deterministic confidence for a SUCCESSFUL parse (informational; never gates). */
function classify(line: string): { tier: Tier; confidence: number } {
  return STRUCTURED_LEAD.test(line.trim().toLowerCase())
    ? { tier: 0, confidence: 1 }
    : { tier: 1, confidence: 0.8 };
}

/**
 * Reject inputs shaped like key material (base58/hex private key, JSON byte
 * array, BIP39 mnemonic) so a pasted secret is NEVER sent to the model or
 * written to the corpus log. Runs on the normalized (lowercased) form — the
 * same string that would be transmitted/logged. Lowercasing already mangles a
 * base58 key, but suppressing the request entirely is the real fix.
 */
export function looksLikeSecret(normalized: string): boolean {
  const s = normalized.trim();
  // Single long base58/hex-ish token with no spaces → likely a private key
  // (Phantom base58 ≈ 87-88 chars; hex 64/128). No legit command is one 40+
  // char token.
  if (!s.includes(' ') && /^[a-z0-9]{40,100}$/.test(s)) return true;
  // JSON byte-array keypair: a long run of comma-separated small integers.
  if (/(?:\d{1,3}\s*,\s*){15,}\d{1,3}/.test(s)) return true;
  // BIP39-style mnemonic: 12+ space-separated lowercase alpha words.
  const words = s.split(/\s+/);
  if (words.length >= 12 && words.every((w) => /^[a-z]{3,8}$/.test(w))) return true;
  return false;
}

/** Gate before spending a single credit: is this plausibly a trade instruction? */
export function looksLikeIntent(normalized: string): boolean {
  const len = normalized.length;
  if (len < 2 || len > 120) return false;
  // Never transmit or log secret-shaped input, even if it superficially passes
  // the digit/intent-word test below (a base58 key always contains digits).
  if (looksLikeSecret(normalized)) return false;
  if (normalized.split(' ').length > 24) return false;
  return /\d/.test(normalized) || INTENT_WORDS.test(normalized);
}

export class IntentResolver {
  private readonly cache: IntentCache<string | null>;
  readonly budget: BudgetLedger;
  /** Session override: `ai off` flips this without restarting. */
  private sessionDisabled = false;
  private fallbackCount = 0;

  constructor(
    private readonly cfg: AiConfig,
    private readonly callClient: ClientFn = callAiInterpreter,
    budget?: BudgetLedger,
  ) {
    this.cache = new IntentCache<string | null>(cfg.cacheMax, cfg.cacheTtlMs);
    this.budget = budget ?? new BudgetLedger(cfg.sessionTokenCap, cfg.dailyTokenCap);
  }

  /** Whether the model may be consulted right now. */
  get aiActive(): boolean {
    return this.cfg.enabled && !this.sessionDisabled;
  }

  /** True when AI was configured (key present) but is currently suppressed. */
  get regexOnly(): boolean {
    return this.cfg.enabled && !this.mode().active;
  }

  setSessionDisabled(off: boolean): void {
    this.sessionDisabled = off;
  }

  /** Human-readable mode for the status indicator. */
  mode(): { active: boolean; reason: string | null } {
    if (!this.cfg.enabled) return { active: false, reason: this.cfg.disabledReason };
    if (this.sessionDisabled) return { active: false, reason: 'disabled this session (`ai on` to re-enable)' };
    if (this.budget.capTripped) return { active: false, reason: 'budget cap reached — regex-only' };
    return { active: true, reason: null };
  }

  async resolve(rawLine: string, parse: ParseFn): Promise<ResolveResult> {
    const normalized = normalizeInput(rawLine);

    // ── Tier 0/1: deterministic. The hot path. No AI, ever. ──────────────
    const det = parse(rawLine);
    if (det) {
      const { tier, confidence } = classify(rawLine);
      this.logCorpus(normalized, tier, confidence, false, det.alias);
      return { command: det, tier, confidence, aiInterpreted: false, degraded: false, fallbackReason: null };
    }

    // ── Deterministic miss. Decide whether Tier 2 is even worth it. ──────
    const confidence = 0;
    if (!looksLikeIntent(normalized)) {
      // Not a plausible trade — deterministic "unknown command", no AI spend.
      return { command: null, tier: 'none', confidence, aiInterpreted: false, degraded: false, fallbackReason: null };
    }
    if (!this.aiActive) {
      return this.degrade(normalized, confidence, this.mode().reason ?? 'ai-disabled');
    }

    // ── Cache lookup (bypasses the model for repeat phrasings). ──────────
    const hash = hashInput(normalized);
    const cached = this.cache.get(hash);
    let aiString: string | null;
    let cacheHit = false;
    let model = this.cfg.model;
    let tokensIn = 0;
    let tokensOut = 0;
    let latencyMs = 0;

    if (cached !== undefined) {
      aiString = cached;
      cacheHit = true;
    } else {
      // Budget is HARD — checked before the call, so no overshoot.
      if (!this.budget.canSpend()) {
        return this.degrade(normalized, confidence, 'budget-exhausted');
      }
      const r = await this.callClient(normalized, this.cfg);
      if ('error' in r) {
        recordAiCall({
          ts: new Date().toISOString(), hash, model, tokensIn: 0, tokensOut: 0,
          latencyMs: 0, tier1Confidence: confidence, cacheHit: false,
          fallbackReason: `ai-error:${r.error}`, resolvedAlias: null,
        });
        return this.degrade(normalized, confidence, `ai-error`);
      }
      aiString = r.command;
      model = r.model;
      tokensIn = r.inputTokens;
      tokensOut = r.outputTokens;
      latencyMs = r.latencyMs;
      this.budget.record(model, tokensIn, tokensOut);
      this.cache.set(hash, aiString);
    }

    // ── THE FIREWALL: re-parse the model's string deterministically. ─────
    let command: ParsedCommand | null = null;
    let fallbackReason: string | null = null;
    if (aiString === null) {
      fallbackReason = 'ai-none';
    } else {
      try {
        command = parse(aiString);
      } catch {
        // Ambiguous fuzzy match on model-invented text → refuse, never guess.
        command = null;
      }
      if (command === null) fallbackReason = 'ai-unparseable';
    }

    recordAiCall({
      ts: new Date().toISOString(), hash, model, tokensIn, tokensOut, latencyMs,
      tier1Confidence: confidence, cacheHit, fallbackReason,
      resolvedAlias: command?.alias ?? null,
    });
    this.logCorpus(normalized, command ? 2 : 'none', confidence, command !== null, command?.alias ?? null);
    if (command === null) this.fallbackCount++;

    return {
      command,
      tier: command ? 2 : 'none',
      confidence,
      aiInterpreted: command !== null,
      aiSource: command ? (aiString ?? undefined) : undefined,
      degraded: command === null,
      fallbackReason,
    };
  }

  private degrade(normalized: string, confidence: number, reason: string): ResolveResult {
    this.fallbackCount++;
    this.logCorpus(normalized, 'none', confidence, false, null);
    return { command: null, tier: 'none', confidence, aiInterpreted: false, degraded: true, fallbackReason: reason };
  }

  private logCorpus(normalized: string, tier: Tier, confidence: number, aiInterpreted: boolean, alias: string | null): void {
    logIntentInput(
      {
        ts: new Date().toISOString(),
        hash: hashInput(normalized),
        len: normalized.length,
        tier,
        tier1Confidence: confidence,
        aiInterpreted,
        resolvedAlias: alias,
        raw: normalized,
      },
      { logInputs: this.cfg.logInputs, logRaw: this.cfg.logRaw },
    );
  }

  /** `/ai stats` payload — makes cost + fallbacks observable, not a black box. */
  stats(): {
    mode: { active: boolean; reason: string | null };
    budget: ReturnType<BudgetLedger['stats']>;
    cache: ReturnType<IntentCache<string | null>['stats']>;
    fallbacks: number;
    model: string;
    confidenceThreshold: number;
  } {
    return {
      mode: this.mode(),
      budget: this.budget.stats(),
      cache: this.cache.stats(),
      fallbacks: this.fallbackCount,
      model: this.cfg.model,
      confidenceThreshold: this.cfg.confidenceThreshold,
    };
  }
}
