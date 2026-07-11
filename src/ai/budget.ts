/**
 * Credit / cost ledger for the AI intent layer.
 *
 * Tracks token spend per SESSION (in-memory) and per rolling UTC DAY (persisted
 * to ~/.magic/ai-budget.json). Configurable caps; when either is hit, `canSpend`
 * returns false and the resolver HARD-switches to regex-only — no overshoot,
 * because the cap is checked BEFORE every call, never after.
 *
 * Cost is derived from the model's published per-MTok price so `/ai stats` can
 * show a real dollar estimate rather than a black box.
 */

import { existsSync, readFileSync } from 'fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { homedir } from 'os';
import { resolve } from 'path';
import { MODEL_PRICES } from './config.js';

interface DayState {
  date: string; // YYYY-MM-DD (UTC)
  tokens: number;
  costUsd: number;
  calls: number;
}

interface Counters {
  tokens: number;
  costUsd: number;
  calls: number;
}

function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function estCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICES[model] ?? MODEL_PRICES['claude-haiku-4-5'];
  return (inputTokens / 1e6) * p.inUsdPerMTok + (outputTokens / 1e6) * p.outUsdPerMTok;
}

export class BudgetLedger {
  private session: Counters = { tokens: 0, costUsd: 0, calls: 0 };
  private day: DayState;
  /** True once a cap trips this session — surfaces "budget exhausted" in status. */
  private tripped = false;

  constructor(
    private readonly sessionTokenCap: number,
    private readonly dailyTokenCap: number,
    private readonly filePath = resolve(homedir(), '.magic', 'ai-budget.json'),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.day = this.load();
  }

  private load(): DayState {
    const today = utcDate(this.now());
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<DayState>;
        if (parsed && parsed.date === today) {
          return {
            date: today,
            tokens: Number(parsed.tokens) || 0,
            costUsd: Number(parsed.costUsd) || 0,
            calls: Number(parsed.calls) || 0,
          };
        }
      }
    } catch {
      /* fall through to a fresh day */
    }
    return { date: today, tokens: 0, costUsd: 0, calls: 0 };
  }

  private persist(): void {
    try {
      atomicWriteFileSync(this.filePath, JSON.stringify(this.day), 0o600);
    } catch {
      /* best-effort — never let telemetry I/O break trading */
    }
  }

  /** Roll the persisted day over if the UTC date changed mid-session. */
  private rollDay(): void {
    const today = utcDate(this.now());
    if (this.day.date !== today) this.day = { date: today, tokens: 0, costUsd: 0, calls: 0 };
  }

  /** Check BEFORE calling the model. Caps are hard — no overshoot. */
  canSpend(): boolean {
    this.rollDay();
    const sessionOk = this.sessionTokenCap <= 0 || this.session.tokens < this.sessionTokenCap;
    const dayOk = this.dailyTokenCap <= 0 || this.day.tokens < this.dailyTokenCap;
    if (!sessionOk || !dayOk) this.tripped = true;
    return sessionOk && dayOk;
  }

  /** Record actual spend AFTER a successful call. */
  record(model: string, inputTokens: number, outputTokens: number): void {
    this.rollDay();
    const tokens = inputTokens + outputTokens;
    const cost = estCostUsd(model, inputTokens, outputTokens);
    this.session.tokens += tokens;
    this.session.costUsd += cost;
    this.session.calls += 1;
    this.day.tokens += tokens;
    this.day.costUsd += cost;
    this.day.calls += 1;
    this.persist();
  }

  get capTripped(): boolean {
    return this.tripped;
  }

  stats(): {
    session: Counters & { remainingTokens: number };
    day: DayState & { remainingTokens: number };
    sessionCap: number;
    dailyCap: number;
  } {
    this.rollDay();
    return {
      session: {
        ...this.session,
        remainingTokens: this.sessionTokenCap <= 0 ? Infinity : Math.max(0, this.sessionTokenCap - this.session.tokens),
      },
      day: {
        ...this.day,
        remainingTokens: this.dailyTokenCap <= 0 ? Infinity : Math.max(0, this.dailyTokenCap - this.day.tokens),
      },
      sessionCap: this.sessionTokenCap,
      dailyCap: this.dailyTokenCap,
    };
  }
}
