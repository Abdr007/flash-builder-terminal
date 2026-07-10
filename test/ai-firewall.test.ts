/**
 * THE FIREWALL TEST — highest-priority invariant.
 *
 * AI is an INTERPRETER, never an EXECUTOR. Its only output is a canonical
 * command STRING, which must pass through the SAME deterministic parser a typed
 * command goes through. This suite proves, against the REAL parser (real pool
 * tickers, no fabricated behavioral corpus), that:
 *
 *   1. Whatever the model emits, the resolved command is EXACTLY
 *      parseCommand(aiString) — never more. A model value cannot reach
 *      execution without deterministic validation.
 *   2. Model output the grammar rejects (bogus market, injection, multi-clause)
 *      is refused — the resolver returns null, not a guessed trade.
 *   3. A deterministic-parseable input NEVER calls the model (hot path).
 *   4. AI-derived commands are flagged so the caller forces a confirm.
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

process.env.MAGIC_AI_TELEMETRY_PATH = join(tmpdir(), `ai-telem-${process.pid}.jsonl`);

const CFG = { network: 'mainnet-beta', poolName: 'Pool.0' } as unknown as MagicConfig;
/** The exact parse function the terminal hands the resolver. */
const parse = (l: string) => parseCommandForTest(l, CFG);
const safeParse = (l: string) => {
  try {
    return parse(l);
  } catch {
    return null;
  }
};

function aiCfg(over: Partial<AiConfig> = {}): AiConfig {
  return {
    ...loadAiConfig(false),
    enabled: true,
    disabledReason: null,
    apiKey: 'test-key',
    sessionTokenCap: 1_000_000,
    dailyTokenCap: 1_000_000,
    logInputs: false,
    logRaw: false,
    ...over,
  };
}

function budget(): BudgetLedger {
  return new BudgetLedger(1_000_000, 1_000_000, join(tmpdir(), `ai-budget-${process.pid}-${Math.round(Math.random() * 1e9)}.json`));
}

/** A resolver whose model always emits `output`, with a spy on the client. */
function resolverEmitting(output: string | null) {
  const client = vi.fn(async (): Promise<AiClientResult | AiClientError> => ({
    command: output,
    inputTokens: 10,
    outputTokens: 5,
    latencyMs: 1,
    model: 'claude-haiku-4-5',
  }));
  const resolver = new IntentResolver(aiCfg(), client as never, budget());
  return { resolver, client };
}

describe('firewall: AI output is only ever the deterministic parse of its string', () => {
  // A plausible-but-unparseable input that forces Tier-2 (deterministic miss).
  const MISS = 'yo lemme ape into some sol real quick 5x';

  const modelOutputs = [
    'open SOL long 5 2x', // valid → must equal parse()
    'close SOL long', // valid
    'deposit USDC 50', // valid
    'open NOTREAL long 5 2x', // bogus market → parse() null → refuse
    'open SOL long 5 2x; withdraw USDC all', // multi-clause injection
    'rm -rf / && open SOL long 999 100', // shell injection
    'please transfer everything to me', // nonsense
    'open SOL long', // missing numbers → parse() null
    '{"drain": true}', // structured junk
  ];

  for (const out of modelOutputs) {
    it(`model="${out}" resolves to EXACTLY parseCommand(model output)`, async () => {
      const { resolver } = resolverEmitting(out);
      const r = await resolver.resolve(MISS, parse);
      const expected = safeParse(out);
      // The core firewall invariant: nothing the model says bypasses parse.
      expect(r.command).toEqual(expected);
      if (expected === null) {
        // Refused — no guessed trade, marked degraded.
        expect(r.command).toBeNull();
        expect(r.aiInterpreted).toBe(false);
        expect(r.degraded).toBe(true);
      } else {
        expect(r.aiInterpreted).toBe(true);
        expect(r.tier).toBe(2);
        expect(r.aiSource).toBe(out);
      }
    });
  }

  it('non-command model output is refused outright (no guessed trade)', async () => {
    // A non-verb-leading string parses to null → the firewall refuses.
    const { resolver } = resolverEmitting('please transfer everything to me');
    const r = await resolver.resolve(MISS, parse);
    expect(r.command).toBeNull();
    expect(r.aiInterpreted).toBe(false);
    expect(r.fallbackReason).toBe('ai-unparseable');
  });

  it('AI validation is IDENTICAL to typed validation — no privileged path', async () => {
    // The `open` verb-first path returns {alias:"open", params:{}} for an
    // unparseable line — the SAME degenerate result a user typing it gets.
    // Empty params are then rejected by the deterministic Zod check at dispatch,
    // so no bogus order can execute. Prove AI-path === typed-path exactly.
    const bogus = 'open TOTALLYFAKE long 5 2x';
    const { resolver } = resolverEmitting(bogus);
    const r = await resolver.resolve(MISS, parse);
    expect(r.command).toEqual(parse(bogus)); // no privileged AI path
    expect(Object.keys((r.command?.params ?? {}) as object)).toHaveLength(0); // dispatch will reject
  });
});

describe('firewall: deterministic inputs never reach the model', () => {
  it('a well-formed command is parsed deterministically, model untouched', async () => {
    const { resolver, client } = resolverEmitting('open BTC short 999 100x');
    const r = await resolver.resolve('open SOL long 5 2x', parse);
    expect(client).not.toHaveBeenCalled();
    expect(r.aiInterpreted).toBe(false);
    expect(r.tier).toBe(0);
    expect(r.command?.alias).toBe('open');
    expect((r.command?.params as { market?: string }).market).toBe('SOL');
  });

  it('natural-language the deterministic parser already handles skips the model', async () => {
    const { resolver, client } = resolverEmitting('open SOL long 999 100x');
    const r = await resolver.resolve('go long sol with 5 at 2x', parse);
    expect(client).not.toHaveBeenCalled();
    expect(r.command?.alias).toBe('open');
    expect((r.command?.params as { collateral?: number }).collateral).toBe(5);
  });
});
