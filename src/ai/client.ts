/**
 * Tier-2 AI interpreter — the ONLY place that talks to the model.
 *
 * It returns advisory intent ONLY: a single canonical command STRING (or null),
 * which the resolver re-parses through the deterministic pipeline. This module
 * never touches the order/execution API, never sets risk params, never signs.
 *
 * Zero dependencies: a raw `fetch` to POST /v1/messages with a strict tool that
 * forces structured output. Cheapest capable model (Haiku 4.5), temperature 0,
 * tight max_tokens, minimal system prompt. One retry, then treated as
 * unavailable so the caller falls back to regex-only.
 */

import type { AiConfig } from './config.js';
import { readJsonCapped } from '../utils/fetch-json.js';

export interface AiClientResult {
  /** Canonical command line, or null if the model judged the input non-actionable. */
  command: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  model: string;
}

export interface AiClientError {
  error: string;
}

const SYSTEM_PROMPT =
  'You translate a crypto perps trader\'s message into ONE canonical command for the Flash terminal, ' +
  'or NONE. Respond ONLY by calling the emit_intent tool.\n' +
  'Grammar (emit exactly one line):\n' +
  '  open <MARKET> <long|short> <collateralUSD> <leverage>x [tp <price>] [sl <price>]\n' +
  '  close <MARKET> <long|short>            close all\n' +
  '  reverse <MARKET> <long|short>          increase <MARKET> <long|short> <usd>\n' +
  '  partial <MARKET> <long|short> <usd|percent%>\n' +
  '  add <usd> <MARKET> <long|short>        remove <usd> <MARKET> <long|short>\n' +
  '  limit <MARKET> <long|short> <price> <collateralUSD> <leverage>\n' +
  '  tp <MARKET> <long|short> <price>       sl <MARKET> <long|short> <price>\n' +
  '  deposit <TOKEN> <amount>               withdraw <TOKEN> <amount|max>\n' +
  'Rules: keep the market/token ticker exactly as the user wrote it (do not translate names). ' +
  'buy=long, sell=short. NEVER invent a collateral, leverage, or price the user did not state. ' +
  'If the message is not one of these actions, set command to "NONE".';

interface ToolUseBlock {
  type: string;
  name?: string;
  input?: { command?: unknown };
}
interface MessagesResponse {
  content?: ToolUseBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

const EMIT_TOOL = {
  name: 'emit_intent',
  description: 'Emit exactly one canonical Flash terminal command, or "NONE".',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      command: {
        type: 'string',
        description: 'A single canonical command line, or the literal string "NONE".',
      },
      reason: { type: 'string', description: 'One short clause explaining the mapping.' },
    },
    required: ['command', 'reason'],
  },
} as const;

async function callOnce(line: string, cfg: AiConfig): Promise<AiClientResult | AiClientError> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': cfg.apiVersion,
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        temperature: cfg.temperature,
        system: SYSTEM_PROMPT,
        tools: [EMIT_TOOL],
        tool_choice: { type: 'tool', name: 'emit_intent' },
        messages: [{ role: 'user', content: line }],
      }),
      signal: ctrl.signal,
    });
    const latencyMs = Date.now() - t0;
    if (res.status === 429 || res.status >= 500) return { error: `http ${res.status}` };
    // Byte-cap the read: the AI endpoint is user-configurable (AI_ENDPOINT), so
    // a hostile/misbehaving endpoint must not be able to stream an unbounded
    // body within the timeout and OOM the REPL. A real intent response is tiny.
    const j = await readJsonCapped<MessagesResponse>(res);
    if (!res.ok || j.error) return { error: j.error?.message ?? `http ${res.status}` };
    const block = (j.content ?? []).find((b) => b.type === 'tool_use' && b.name === 'emit_intent');
    const raw = block?.input?.command;
    if (typeof raw !== 'string') return { error: 'no tool output' };
    const trimmed = raw.trim();
    const command = trimmed === '' || /^none$/i.test(trimmed) ? null : trimmed;
    return {
      command,
      inputTokens: j.usage?.input_tokens ?? 0,
      outputTokens: j.usage?.output_tokens ?? 0,
      latencyMs,
      model: cfg.model,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** One retry on transient failure, then give up (→ caller falls back to regex-only). */
export async function callAiInterpreter(line: string, cfg: AiConfig): Promise<AiClientResult | AiClientError> {
  const first = await callOnce(line, cfg);
  if (!('error' in first)) return first;
  return callOnce(line, cfg);
}
