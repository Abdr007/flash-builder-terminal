/**
 * Credit budget + cache + graceful-degradation tests.
 *
 * - Once the session cap trips, ZERO further model calls (hard switch, no
 *   overshoot) and the resolver degrades to regex-only.
 * - Identical normalized inputs bill the model exactly once (cache).
 * - AI disabled / model error → deterministic fallback, never a thrown error,
 *   never a guessed trade.
 */

import { describe, it, expect, vi } from 'vitest';
import { IntentResolver } from '../src/ai/interpret.js';
import { BudgetLedger } from '../src/ai/budget.js';
import { loadAiConfig, type AiConfig } from '../src/ai/config.js';
import type { AiClientResult, AiClientError } from '../src/ai/client.js';
import { parseCommandForTest } from '../src/cli/terminal.js';
import type { MagicConfig } from '../src/types/index.js';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.MAGIC_AI_TELEMETRY_PATH = join(tmpdir(), `ai-telem-bc-${process.pid}.jsonl`);

const CFG = { network: 'mainnet-beta', poolName: 'Pool.0' } as unknown as MagicConfig;
const parse = (l: string) => parseCommandForTest(l, CFG);

function aiCfg(over: Partial<AiConfig> = {}): AiConfig {
  return {
    ...loadAiConfig(false),
    enabled: true,
    disabledReason: null,
    apiKey: 'k',
    sessionTokenCap: 1_000_000,
    dailyTokenCap: 1_000_000,
    logInputs: false,
    logRaw: false,
    ...over,
  };
}
const tmpBudget = (session: number, daily: number) =>
  new BudgetLedger(session, daily, join(tmpdir(), `ai-b-${process.pid}-${Math.round(Math.random() * 1e9)}.json`));

function client(returns: (AiClientResult | AiClientError)[]) {
  let i = 0;
  return vi.fn(async () => returns[Math.min(i++, returns.length - 1)]);
}
const ok = (command: string | null, tokens = 40): AiClientResult => ({
  command,
  inputTokens: Math.round(tokens / 2),
  outputTokens: Math.round(tokens / 2),
  latencyMs: 1,
  model: 'claude-haiku-4-5',
});

const MISS_A = 'ape sol 5x lets gooo';
const MISS_B = 'yolo btc 10x send it';

describe('budget ledger — hard switch, no overshoot', () => {
  it('stops calling the model the instant the session cap is exceeded', async () => {
    const c = client([ok('open SOL long 5 5x', 60), ok('open BTC long 5 10x', 60)]);
    // Cap of 50 tokens; first call spends 60 → next canSpend() is false.
    const resolver = new IntentResolver(aiCfg(), c as never, tmpBudget(50, 1_000_000));

    const r1 = await resolver.resolve(MISS_A, parse);
    expect(c).toHaveBeenCalledTimes(1);
    expect(r1.aiInterpreted).toBe(true);

    const r2 = await resolver.resolve(MISS_B, parse);
    expect(c).toHaveBeenCalledTimes(1); // NOT called again
    expect(r2.command).toBeNull();
    expect(r2.degraded).toBe(true);
    expect(r2.fallbackReason).toBe('budget-exhausted');
    expect(resolver.mode().active).toBe(false);
  });
});

describe('cache — identical normalized input bills once', () => {
  it('re-uses the cached model result for a case/punctuation variant', async () => {
    const c = client([ok('open SOL long 5 5x')]);
    const resolver = new IntentResolver(aiCfg(), c as never, tmpBudget(1e9, 1e9));

    const r1 = await resolver.resolve('ape sol 5x', parse);
    const r2 = await resolver.resolve('Ape SOL 5x!', parse); // normalizes identically

    expect(c).toHaveBeenCalledTimes(1);
    expect(r1.command).toEqual(r2.command);
    expect(resolver.stats().cache.hits).toBe(1);
  });
});

describe('graceful degradation — safe, visible, never guesses', () => {
  it('AI disabled → deterministic fallback, model never called', async () => {
    const c = client([ok('open SOL long 5 5x')]);
    const resolver = new IntentResolver(aiCfg({ enabled: false, disabledReason: 'no key' }), c as never, tmpBudget(1e9, 1e9));
    const r = await resolver.resolve(MISS_A, parse);
    expect(c).not.toHaveBeenCalled();
    expect(r.command).toBeNull();
    expect(r.degraded).toBe(true);
  });

  it('model error → degraded, no throw, no guessed trade', async () => {
    const c = client([{ error: 'network down' } as AiClientError]);
    const resolver = new IntentResolver(aiCfg(), c as never, tmpBudget(1e9, 1e9));
    const r = await resolver.resolve(MISS_A, parse);
    expect(r.command).toBeNull();
    expect(r.degraded).toBe(true);
    expect(r.fallbackReason).toBe('ai-error');
  });

  it('gibberish that is not trade-shaped never spends a credit', async () => {
    const c = client([ok('open SOL long 5 5x')]);
    const resolver = new IntentResolver(aiCfg(), c as never, tmpBudget(1e9, 1e9));
    const r = await resolver.resolve('what is the weather today', parse);
    expect(c).not.toHaveBeenCalled();
    expect(r.command).toBeNull();
    expect(r.degraded).toBe(false); // deterministic unknown-command, not an AI fallback
  });

  it('`ai off` forces regex-only within the session', async () => {
    const c = client([ok('open SOL long 5 5x')]);
    const resolver = new IntentResolver(aiCfg(), c as never, tmpBudget(1e9, 1e9));
    resolver.setSessionDisabled(true);
    const r = await resolver.resolve(MISS_A, parse);
    expect(c).not.toHaveBeenCalled();
    expect(r.degraded).toBe(true);
  });
});
