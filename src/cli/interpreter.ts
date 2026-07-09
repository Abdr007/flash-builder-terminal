/**
 * Flash Magic Terminal — natural-language command interpreter.
 *
 * Ported from bolt-terminal's v1 interpreter (`src/ai/interpreter.ts`).
 * Same regex grammar, same tolerance, same flexibility — adapted to emit
 * v2 `{alias, params}` shapes instead of v1 `ParsedIntent` enums.
 *
 * Pipeline:
 *   1. Sanitise control chars + collapse whitespace
 *   2. Expand short command aliases (o → open, c → close, m → monitor, …)
 *   3. Normalise number-words (ten → 10, twenty-five → 25, two thousand → 2000)
 *   4. Normalise asset aliases (solana → sol, crude oil → crudeoil)
 *   5. Lowercase
 *   6. Fixed regex parsers in priority order (limit beats open, …)
 *   7. flexParseOpen — order-agnostic side/market/leverage/collateral extractor
 *   8. Fuzzy correction fallback (Levenshtein ≤ 1) for typos
 *
 * Returning `null` means "no match; try elsewhere or fail with unknown command."
 */

import type { MagicConfig } from '../types/index.js';

export interface ParsedCommand {
  alias: string;
  params: Record<string, unknown>;
}

// ─── Asset alias registry ─────────────────────────────────────────────────────
// Loaded from PoolConfig at runtime. Mirrors v1's market-resolver.

let _symbolSet: Set<string> | null = null;
let _aliasMap: Map<string, string> | null = null;

export function configureSymbols(symbols: Iterable<string>, aliases: Iterable<[string, string]>): void {
  _symbolSet = new Set([...symbols].map((s) => s.toUpperCase()));
  _aliasMap = new Map([...aliases].map(([a, s]) => [a.toLowerCase(), s.toUpperCase()]));
  rebuildAliasRules();
}

function isKnownMarket(sym: string): boolean {
  return !!_symbolSet && _symbolSet.has(sym.toUpperCase());
}
function knownMarkets(): string[] {
  return _symbolSet ? [..._symbolSet] : [];
}

/** "solana" → "SOL", "crude oil" → "CRUDEOIL", "btc" → "BTC". */
export function resolveMarket(input: string): string {
  if (!input) return '';
  const trimmed = input.trim();
  const upper = trimmed.toUpperCase();
  const collapsed = upper.replace(/\s+/g, '');
  if (isKnownMarket(upper)) return upper;
  if (isKnownMarket(collapsed)) return collapsed;
  // Strip "-perp" / "perpetual" suffixes.
  const stripped = trimmed.toLowerCase().replace(/[-\s]?perp(?:etual)?$/i, '').trim();
  if (stripped && stripped !== trimmed.toLowerCase()) {
    const r = resolveMarket(stripped);
    if (r && isKnownMarket(r)) return r;
  }
  // Alias lookup (lowercase, then space-collapsed).
  if (_aliasMap) {
    const aliased = _aliasMap.get(trimmed.toLowerCase()) ?? _aliasMap.get(trimmed.toLowerCase().replace(/\s+/g, ''));
    if (aliased && isKnownMarket(aliased)) return aliased;
  }
  return collapsed;
}

// Alias regex cache — built once per `configureSymbols` call (which fires at
// startup and on pool change), reused on every `interpretCommand`. Previously
// each call rebuilt N RegExps from scratch via `new RegExp(escapeRe(alias))`,
// which is measurable on the dispatch hot path with ~30 aliases.
type AliasRule = { re: RegExp; replacement: string };
let _multiWordRules: AliasRule[] = [];
let _singleWordRules: AliasRule[] = [];

function rebuildAliasRules(): void {
  _multiWordRules = [];
  _singleWordRules = [];
  if (!_aliasMap) return;
  const multiWord = [..._aliasMap.entries()].filter(([a]) => a.includes(' ')).sort((a, b) => b[0].length - a[0].length);
  for (const [alias, sym] of multiWord) {
    _multiWordRules.push({ re: new RegExp(escapeRe(alias), 'gi'), replacement: sym.toLowerCase() });
  }
  for (const [alias, sym] of _aliasMap.entries()) {
    if (alias.includes(' ')) continue;
    _singleWordRules.push({ re: new RegExp(`\\b${escapeRe(alias)}\\b`, 'gi'), replacement: sym.toLowerCase() });
  }
}

function normalizeAssetText(text: string): string {
  if (!_aliasMap) return text;
  let out = text;
  for (const r of _multiWordRules) out = out.replace(r.re, r.replacement);
  for (const r of _singleWordRules) out = out.replace(r.re, r.replacement);
  return out;
}
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ─── Number word normalisation ────────────────────────────────────────────────

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
};

function numberWordValue(tok: string): number | undefined {
  return NUMBER_WORDS[tok.toLowerCase()];
}

/**
 * Convert spelled-out numbers to digits, COMPOSITIONALLY — a maximal run of
 * adjacent number-words folds into one value using the standard algorithm
 * (ones/teens/tens accumulate; `hundred`/`thousand` are multipliers). So
 * "two hundred fifty" → 250, "one thousand five hundred" → 1500,
 * "twenty five" → 25. The previous regex approach converted only the leading
 * factor and left the remainder as a SEPARATE number ("two hundred fifty" →
 * "200 50"), which the open-parser then read as collateral 200 @ 50x — a trade
 * the user never asked for. Non-number tokens pass through untouched.
 */
function normalizeNumberWords(text: string): string {
  // Fold a hyphen between two number-words ("twenty-five") into a space so the
  // token walk sees them separately; leave hyphens in ordinary tokens
  // (e.g. `close-all`, `add-collateral`) alone.
  const dehyph = text.replace(
    /\b([a-z]+)-([a-z]+)\b/gi,
    (m, a: string, b: string) => (numberWordValue(a) !== undefined && numberWordValue(b) !== undefined ? `${a} ${b}` : m),
  );
  const toks = dehyph.split(/\s+/);
  const out: string[] = [];
  let i = 0;
  while (i < toks.length) {
    if (numberWordValue(toks[i]) === undefined) {
      out.push(toks[i]);
      i++;
      continue;
    }
    // Fold a maximal run of number-words into a single value.
    let result = 0;
    let current = 0;
    while (i < toks.length) {
      const v = numberWordValue(toks[i]);
      if (v === undefined) break;
      if (v === 1000) {
        result += (current === 0 ? 1 : current) * 1000;
        current = 0;
      } else if (v === 100) {
        current = (current === 0 ? 1 : current) * 100;
      } else {
        current += v;
      }
      i++;
    }
    out.push(String(result + current));
  }
  return out.join(' ');
}

// ─── Command aliases (single-letter shortcuts at the start of input) ─────────

export const COMMAND_ALIASES: Record<string, string> = {
  // Single-letter verbs — the muscle-memory set advertised in the header.
  o: 'open',
  c: 'close',
  p: 'portfolio',
  m: 'monitor',
  w: 'wallet',
  d: 'dashboard',
  b: 'portfolio',
  // Short mnemonics.
  pos: 'portfolio',
  bal: 'portfolio',
  mkt: 'markets',
  mkts: 'markets',
  px: 'price',
  ca: 'close-all',
  // Natural-language synonyms.
  buy: 'open',
  sell: 'close',
  flip: 'reverse',
};
function expandCommandAlias(input: string): string {
  const sp = input.indexOf(' ');
  const head = sp === -1 ? input : input.slice(0, sp);
  const rest = sp === -1 ? '' : input.slice(sp);
  const expanded = COMMAND_ALIASES[head.toLowerCase()];
  return expanded ? expanded + rest : input;
}

// ─── Side helpers ─────────────────────────────────────────────────────────────

function parseSide(raw: string): 'long' | 'short' | null {
  const v = raw.toLowerCase();
  if (v === 'long' || v === 'buy') return 'long';
  if (v === 'short' || v === 'sell') return 'short';
  return null;
}

// ─── Levenshtein for fuzzy correction ────────────────────────────────────────

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > 3) return 4;
  const m: number[][] = [];
  for (let i = 0; i <= a.length; i++) m[i] = [i];
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + cost);
    }
  }
  return m[a.length][b.length];
}

function fuzzySide(tok: string): string | null {
  if (tok === 'long' || tok === 'short') return tok;
  for (const s of ['long', 'short']) if (editDistance(tok, s) <= 1) return s;
  return null;
}

/**
 * Result of a fuzzy market lookup.
 *  - `match`   — exactly one candidate, ready to use.
 *  - `ambiguous` — two or more candidates at the same minimum distance;
 *    caller MUST refuse the trade and ask the user to disambiguate. The
 *    array is sorted alphabetically and capped at 5 for readable error.
 *  - `null`    — no candidate found.
 *
 * The previous version silently picked the first hit, which was a real bug:
 * with two markets at distance ≤ 2 from a typo, the user could end up
 * routing a trade to the wrong asset. With auto-confirm on, there's no
 * preview step to catch it.
 */
type FuzzyMatch = { kind: 'match'; symbol: string } | { kind: 'ambiguous'; candidates: string[] } | null;

function fuzzyMarketDetailed(tok: string): FuzzyMatch {
  const direct = resolveMarket(tok);
  if (isKnownMarket(direct)) return { kind: 'match', symbol: direct };

  // Collect every candidate with its edit distance, then return the one
  // with the smallest distance — but ONLY if it's unambiguous (i.e. no
  // other candidate at the same distance).
  const hits: Array<{ symbol: string; distance: number }> = [];
  for (const m of knownMarkets()) {
    const max = m.length <= 3 ? 1 : 2;
    const d = editDistance(tok, m.toLowerCase());
    if (d <= max) hits.push({ symbol: m, distance: d });
  }
  if (_aliasMap) {
    for (const [alias, sym] of _aliasMap.entries()) {
      const d = editDistance(tok, alias);
      if (d <= 1 && !hits.some((h) => h.symbol === sym)) {
        hits.push({ symbol: sym, distance: d });
      }
    }
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.distance - b.distance);
  const minDist = hits[0].distance;
  const tied = hits.filter((h) => h.distance === minDist);
  if (tied.length === 1) return { kind: 'match', symbol: tied[0].symbol };
  // Multiple candidates at the same minimum distance — refuse.
  const candidates = Array.from(new Set(tied.map((h) => h.symbol))).sort().slice(0, 5);
  return { kind: 'ambiguous', candidates };
}

function fuzzyMarket(tok: string): string | null {
  const r = fuzzyMarketDetailed(tok);
  return r && r.kind === 'match' ? r.symbol : null;
}

/**
 * Used by trade-routing call sites that need to surface ambiguity to the
 * user. Returns null if no candidate exists, throws an Error with a
 * disambiguation hint if multiple candidates tie.
 */
export function resolveMarketStrict(tok: string): string | null {
  const r = fuzzyMarketDetailed(tok);
  if (!r) return null;
  if (r.kind === 'ambiguous') {
    throw new Error(
      `'${tok}' could mean any of: ${r.candidates.join(', ')}. ` +
      `Type the full ticker to disambiguate.`,
    );
  }
  return r.symbol;
}

function fuzzyCorrect(input: string): string {
  return input.split(/\s+/).map((t) => {
    const s = fuzzySide(t); if (s && t !== s) return s;
    if (/^[a-z]+$/.test(t) && t.length >= 3) {
      const m = fuzzyMarket(t); if (m) return m.toLowerCase();
    }
    return t;
  }).join(' ');
}

// ─── TP/SL suffix extractor ──────────────────────────────────────────────────

function extractTpSl(text: string): { tp?: number; sl?: number; rest: string } {
  let rest = text;
  let tp: number | undefined;
  let sl: number | undefined;
  rest = rest.replace(/\b(?:take[\s-]?profit|tp)\s+(?:to\s+|at\s+|@\s*)?\$?(\d+(?:\.\d+)?)/gi,
    (_m, n: string) => { tp = parseFloat(n); return ' '; });
  rest = rest.replace(/\b(?:stop[\s-]?loss|sl)\s+(?:to\s+|at\s+|@\s*)?\$?(\d+(?:\.\d+)?)/gi,
    (_m, n: string) => { sl = parseFloat(n); return ' '; });
  rest = rest.replace(/\s+/g, ' ').trim();
  return { tp, sl, rest };
}

// ─── Limit order parser ──────────────────────────────────────────────────────

function parseLimitOrder(input: string): ParsedCommand | null {
  if (!/^limit\b/.test(input)) return null;
  let body = input.replace(/^limit\s+(?:order\s+)?/, '');

  // TP/SL extraction first (so they don't trip up the price extractor).
  const { tp, sl, rest } = extractTpSl(body);
  body = rest;

  // Price: "@ $82" / "at 82" — required, anchored to end.
  const priceM = body.match(/(?:@|at)\s+\$?(\d+(?:\.\d+)?)\s*$/);
  if (!priceM) return null;
  const limitPrice = parseFloat(priceM[1]);
  body = body.slice(0, priceM.index).trim();

  // Side
  const sideM = body.match(/\b(long|short|buy|sell)\b/);
  if (!sideM) return null;
  const side = parseSide(sideM[1]);
  if (!side) return null;
  body = body.replace(/\b(long|short|buy|sell)\b/, ' ').replace(/\s+/g, ' ').trim();

  // Leverage
  const levM = body.match(/\b(\d+(?:\.\d+)?)\s*x\b/i);
  if (!levM) return null;
  const leverage = parseFloat(levM[1]);
  body = body.replace(/\b\d+(?:\.\d+)?\s*x\b/i, ' ').replace(/\s+/g, ' ').trim();

  // Collateral: "$100" / "100" / "for 100 dollars"
  const colM = body.match(/(?:(?:for|with)\s+)?\$?(\d+(?:\.\d+)?)\s*(?:dollars?|usd|usdc)?/);
  if (!colM) return null;
  const collateral = parseFloat(colM[1]);
  body = body.replace(colM[0], ' ').replace(/\s+/g, ' ').trim();

  // Market = whatever's left
  const marketRaw = body.replace(/\b(for|with|on|a|an|the|order|position)\b/g, '').replace(/\s+/g, ' ').trim();
  if (!marketRaw || marketRaw.length > 20) return null;
  const market = resolveMarket(marketRaw);
  if (!isKnownMarket(market)) return null;

  if (!Number.isFinite(limitPrice) || limitPrice <= 0) return null;
  if (!Number.isFinite(collateral) || collateral <= 0) return null;
  if (!Number.isFinite(leverage) || leverage < 1) return null;

  return {
    alias: 'place-limit',
    params: {
      market, side, limitPrice, collateral, leverage,
      ...(tp !== undefined ? { tp } : {}),
      ...(sl !== undefined ? { sl } : {}),
    },
  };
}

// ─── Flexible open parser ────────────────────────────────────────────────────

function flexParseOpen(input: string): ParsedCommand | null {
  // TP/SL split first
  const { tp, sl, rest: mainPart } = extractTpSl(input);
  let body = mainPart;

  // Strip greeting / verb prefixes (iteratively for chains).
  for (let i = 0; i < 3; i++) {
    const before = body;
    body = body.replace(/^(?:yo|hey|please|pls|ok|okay|i\s+want\s+to|let\s+me|let\s+us|can\s+you|go|just|i\s+wanna)\s+/, '');
    body = body.replace(/^(?:open|buy|enter|go\s+long|go\s+short)\s+(?:a\s+)?/, '');
    body = body.replace(/^(?:a|an|the)\s+/, '');
    if (body === before) break;
  }
  body = body.replace(/@\$?(\d)/g, '$$$1');
  body = body.replace(/\b(?:with|for|on|at|to|in|of|using|and|the|a|an|my|position|collateral|dollars?|bucks?|usd|usdc)\b/g, ' ');
  body = body.replace(/\bleverage\s+(\d+(?:\.\d+)?)\b/g, '$1x');
  body = body.replace(/\s+/g, ' ').trim();

  // Side
  let side: 'long' | 'short' | null = null;
  const sideM = body.match(/\b(long|short|buy|sell)\b/);
  if (sideM) {
    side = parseSide(sideM[1]);
    body = body.replace(/\b(long|short|buy|sell)\b/, ' ').replace(/\s+/g, ' ').trim();
  }
  if (!side) {
    if (input.startsWith('long') || input.startsWith('buy')) side = 'long';
    else if (input.startsWith('short') || input.startsWith('sell')) side = 'short';
    else if (input.startsWith('open') || input.startsWith('enter')) side = 'long';
  }
  if (!side) return null;

  // Leverage
  let leverage: number | null = null;
  const levM = body.match(/\b(\d+(?:\.\d+)?)\s*x\b/i);
  if (levM) {
    leverage = parseFloat(levM[1]);
    body = body.replace(/\b\d+(?:\.\d+)?\s*x\b/i, ' ').replace(/\s+/g, ' ').trim();
  }

  // Collateral — "$10" first, else find numbers
  let collateral: number | null = null;
  const dollarM = body.match(/\$(\d+(?:\.\d+)?)/);
  if (dollarM) {
    collateral = parseFloat(dollarM[1]);
    body = body.replace(/\$\d+(?:\.\d+)?/, ' ').replace(/\s+/g, ' ').trim();
  } else {
    const nums = [...body.matchAll(/\b(\d+(?:\.\d+)?)\b/g)].map((m) => parseFloat(m[1]));
    if (nums.length === 1) {
      collateral = nums[0];
      body = body.replace(/\b\d+(?:\.\d+)?\b/, ' ').replace(/\s+/g, ' ').trim();
    } else if (nums.length >= 2 && !leverage) {
      // Positional per the documented grammar (help: "long SOL 5 2x → collateral
      // 5, 2x"): first bare number = collateral, second = leverage. Previously
      // these were magnitude-SORTED (min=leverage, max=collateral), which
      // silently inverted "$5 at 50x" into "$50 at 5x" — a materially different
      // trade. Explicit `x` still wins (leverage is already set above).
      collateral = nums[0];
      leverage = nums[1];
      body = body.replace(/\b\d+(?:\.\d+)?\b/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  // Market = remainder
  body = body.replace(/\b(?:the|a|an|my|with|for|on)\b/g, '').replace(/\s+/g, ' ').trim();
  if (!body) return null;
  let market = resolveMarket(body);
  if (!isKnownMarket(market)) {
    // Use the strict resolver — if the typo could match more than one
    // ticker, throw a disambiguation error rather than silently picking.
    // Routing a trade to the wrong asset would be a real money-loss bug.
    const strict = resolveMarketStrict(body);
    if (strict) market = strict;
    else return null;
  }

  if (!collateral || !Number.isFinite(collateral) || collateral <= 0) return null;
  if (!leverage) leverage = 2; // default 2x
  if (!Number.isFinite(leverage) || leverage < 1) return null;

  return {
    alias: 'open',
    params: {
      market, side, collateral, leverage,
      ...(tp !== undefined ? { tp } : {}),
      ...(sl !== undefined ? { sl } : {}),
    },
  };
}

// ─── Main interpreter ────────────────────────────────────────────────────────

export function interpretCommand(rawInput: string, _config?: MagicConfig): ParsedCommand | null {
  const sanitised = rawInput
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sanitised) return null;

  const aliased = expandCommandAlias(sanitised);
  // tolerate `magic <verb>` prefix
  const stripped = aliased.replace(/^magic\s+/i, '');
  const normalized = normalizeAssetText(normalizeNumberWords(stripped));
  const lower = normalized.toLowerCase();

  // ─── Limit order (must run BEFORE open since both can start with side) ───
  if (/^limit\b/.test(lower)) {
    const r = parseLimitOrder(lower);
    if (r) return r;
  }

  // ─── Set TP/SL with explicit market+side ────────────────────────────────
  // "set tp SOL long $95", "set sl BTC short to 60000"
  {
    const m = lower.match(/^set\s+(tp|sl)\s+([a-z]+)\s+(long|short|buy|sell)\s+(?:to\s+|at\s+|@\s*)?\$?(\d+(?:\.\d+)?)$/);
    if (m) {
      const side = parseSide(m[3]);
      if (side) {
        return {
          alias: 'trigger-order',
          params: {
            market: resolveMarket(m[2]),
            side,
            isStopLoss: m[1] === 'sl',
            price: parseFloat(m[4]),
          },
        };
      }
    }
  }
  // "set tp 95 for SOL long", "set sl $80 on btc short"
  {
    const m = lower.match(/^set\s+(tp|sl)\s+\$?(\d+(?:\.\d+)?)\s+(?:for|on|to)?\s*([a-z]+)\s+(long|short|buy|sell)$/);
    if (m) {
      const side = parseSide(m[4]);
      if (side) {
        return {
          alias: 'trigger-order',
          params: {
            market: resolveMarket(m[3]),
            side,
            isStopLoss: m[1] === 'sl',
            price: parseFloat(m[2]),
          },
        };
      }
    }
  }
  // "set SOL long tp 100 sl 70" — combined (both triggers)
  // "set tp 100 sl 70 sol long" — combined
  if (/^set\b/.test(lower)) {
    const after = lower.replace(/^set\s+/, '');
    const { tp, sl, rest } = extractTpSl(after);
    if (tp !== undefined || sl !== undefined) {
      // Find market + side in the remaining tokens.
      const sideM = rest.match(/\b(long|short|buy|sell)\b/);
      const side = sideM ? parseSide(sideM[1]) : null;
      const remainder = rest.replace(/\b(long|short|buy|sell)\b/, ' ')
        .replace(/\b(set|for|on|to|and|the|a|an|my|position)\b/g, '')
        .replace(/\s+/g, ' ').trim();
      if (side && remainder) {
        const market = resolveMarket(remainder);
        if (isKnownMarket(market)) {
          return {
            alias: 'set-triggers',
            params: { market, side, ...(tp !== undefined ? { tp } : {}), ...(sl !== undefined ? { sl } : {}) },
          };
        }
      }
    }
  }

  // ─── TP/SL shortcut: "tp sol 100", "sl btc 60000" (side auto-detected) ──
  {
    const m = lower.match(/^(tp|sl)\s+([a-z]+)\s+(long|short|buy|sell)?\s*\$?(\d+(?:\.\d+)?)$/);
    if (m) {
      const market = resolveMarket(m[2]);
      const sideStr = m[3] ? parseSide(m[3]) : null;
      const price = parseFloat(m[4]);
      if (isKnownMarket(market) && Number.isFinite(price) && price > 0) {
        return {
          alias: 'trigger-order',
          params: {
            market,
            ...(sideStr ? { side: sideStr } : {}),
            isStopLoss: m[1] === 'sl',
            price,
          },
        };
      }
    }
  }

  // ─── Remove TP/SL: "remove tp SOL long" ──────────────────────────────────
  {
    const m = lower.match(/^(?:remove|cancel)\s+(tp|sl)\s+([a-z]+)(?:\s+(long|short|buy|sell))?$/);
    if (m) {
      const market = resolveMarket(m[2]);
      if (isKnownMarket(market)) {
        return {
          alias: 'cancel-trigger',
          params: { market, isStopLoss: m[1] === 'sl' },
        };
      }
    }
  }

  // ─── Positions / Portfolio (natural variants) ────────────────────────────
  if (/^(?:my\s+positions?|show\s+positions?|open\s+positions?|positions?|holdings?)$/.test(lower)) {
    return { alias: 'portfolio', params: {} };
  }

  // ─── Deposit / Withdraw natural forms ─────────────────────────────────────
  // "deposit 50 USDC", "deposit USDC 50", "fund 50 USDC", "add 50 USDC to vault"
  {
    const m = lower.match(/^(?:deposit|fund)\s+\$?(\d+(?:\.\d+)?)\s+([a-z]+)$/);
    if (m) {
      const token = m[2].toUpperCase();
      return { alias: 'deposit', params: { token, amount: parseFloat(m[1]) } };
    }
  }
  {
    const m = lower.match(/^(?:deposit|fund)\s+([a-z]+)\s+\$?(\d+(?:\.\d+)?)$/);
    if (m) {
      const token = m[1].toUpperCase();
      return { alias: 'deposit', params: { token, amount: parseFloat(m[2]) } };
    }
  }
  {
    // `withdraw status` — pre-flight check, no signing.
    if (/^withdraw\s+status$/.test(lower)) {
      return { alias: 'withdraw-status', params: {} };
    }
    // `withdraw watch` — background poll for delegation flips.
    if (/^withdraw\s+watch$/.test(lower)) {
      return { alias: 'withdraw-watch', params: {} };
    }
  }
  {
    // `withdraw 25 USDC` / `withdraw $25 USDC`
    const m = lower.match(/^withdraw\s+\$?(\d+(?:\.\d+)?)\s+([a-z]+)$/);
    if (m) {
      const token = m[2].toUpperCase();
      return { alias: 'withdraw', params: { token, amount: parseFloat(m[1]) } };
    }
  }
  {
    // `withdraw USDC 25` / `withdraw USDC $25`
    const m = lower.match(/^withdraw\s+([a-z]+)\s+\$?(\d+(?:\.\d+)?)$/);
    if (m) {
      const token = m[1].toUpperCase();
      return { alias: 'withdraw', params: { token, amount: parseFloat(m[2]) } };
    }
  }
  {
    // `withdraw USDC max` / `withdraw USDC all` / `withdraw USDC 100%`
    // — pull the full available basket balance for that token.
    const m = lower.match(/^withdraw\s+([a-z]+)\s+(max|all|100\s*%)$/);
    if (m) {
      const token = m[1].toUpperCase();
      return { alias: 'withdraw', params: { token, amount: 'max' } };
    }
  }
  {
    // Symmetry with the number forms — accept `withdraw max USDC` too.
    const m = lower.match(/^withdraw\s+(max|all|100\s*%)\s+([a-z]+)$/);
    if (m) {
      const token = m[2].toUpperCase();
      return { alias: 'withdraw', params: { token, amount: 'max' } };
    }
  }

  // ─── Increase variants: "size up", "grow", "increase", "scale" ───────────
  {
    const m = lower.match(/^(?:increase|size\s+up|grow|scale|add\s+size)\s+([a-z]+)\s+(long|short|buy|sell)\s+\$?(\d+(?:\.\d+)?)$/);
    if (m) {
      const side = parseSide(m[2]);
      const market = resolveMarket(m[1]);
      if (side && isKnownMarket(market)) {
        return { alias: 'increase', params: { market, side, sizeUsd: parseFloat(m[3]) } };
      }
    }
  }

  // ─── Reverse / Flip ──────────────────────────────────────────────────────
  {
    const m = lower.match(/^(?:reverse|flip)\s+(?:position\s+)?([a-z]+)(?:\s+(long|short|buy|sell))?$/);
    if (m) {
      const market = resolveMarket(m[1]);
      if (isKnownMarket(market)) {
        const side = m[2] ? parseSide(m[2]) : 'long';
        return { alias: 'reverse', params: { market, side: side ?? 'long' } };
      }
    }
  }

  // ─── Close all ───────────────────────────────────────────────────────────
  if (/^(?:close\s+all|close-all|closeall|exit\s+all)(?:\s+positions?)?$/.test(lower)) {
    return { alias: 'close-all', params: {} };
  }

  // ─── Close with partial percent: "close 50% of SOL long" ────────────────
  {
    const m = lower.match(/^(?:close|exit|sell)\s+(\d+(?:\.\d+)?)\s*(?:%|percent)\s+(?:of\s+)?(?:my\s+)?([a-z]+)\s+(long|short|buy|sell)$/);
    if (m) {
      const side = parseSide(m[3]);
      const market = resolveMarket(m[2]);
      if (side && isKnownMarket(market)) {
        return {
          alias: 'partial-close',
          params: { market, side, sizePercent: parseFloat(m[1]) },
        };
      }
    }
  }
  // ─── Close with partial $ amount: "close $20 of SOL long" ───────────────
  {
    const m = lower.match(/^(?:close|exit|sell)\s+\$?(\d+(?:\.\d+)?)\s+(?:of\s+|from\s+)?(?:my\s+)?([a-z]+)\s+(long|short|buy|sell)$/);
    if (m) {
      const side = parseSide(m[3]);
      const market = resolveMarket(m[2]);
      if (side && isKnownMarket(market)) {
        return {
          alias: 'partial-close',
          params: { market, side, sizeUsd: parseFloat(m[1]) },
        };
      }
    }
  }
  // ─── Close with optional partial suffix: "close SOL long 50%" / "$20" ───
  {
    const m = lower.match(/^(?:close|exit|sell)\s+(?:my\s+)?([a-z]+)\s+(long|short|buy|sell)(?:\s+position)?\s*(.*)$/);
    if (m) {
      const side = parseSide(m[2]);
      const market = resolveMarket(m[1]);
      if (side && isKnownMarket(market)) {
        const suffix = m[3].trim();
        if (suffix) {
          const pctM = suffix.match(/^(\d+(?:\.\d+)?)\s*(?:%|percent)$/);
          const amtM = suffix.match(/^\$?(\d+(?:\.\d+)?)$/);
          if (pctM) return { alias: 'partial-close', params: { market, side, sizePercent: parseFloat(pctM[1]) } };
          if (amtM) return { alias: 'partial-close', params: { market, side, sizeUsd: parseFloat(amtM[1]) } };
        }
        return { alias: 'close', params: { market, side } };
      }
    }
  }
  // Close without side — let the tool auto-detect
  {
    const m = lower.match(/^(?:close|exit|sell)\s+(?:my\s+)?([a-z]+)(?:\s+position)?$/);
    if (m) {
      const market = resolveMarket(m[1]);
      if (isKnownMarket(market)) return { alias: 'close', params: { market } };
    }
  }

  // ─── Add collateral: "add $50 to SOL long" / no side ────────────────────
  {
    const m = lower.match(/^add\s+(?:collateral\s+(?:of\s+)?)?\$?(\d+(?:\.\d+)?)\s+(?:dollars?\s+)?(?:collateral\s+)?(?:to\s+|on\s+)?(?:my\s+)?([a-z]+)\s+(long|short|buy|sell)$/);
    if (m) {
      const side = parseSide(m[3]);
      const market = resolveMarket(m[2]);
      if (side && isKnownMarket(market)) {
        return { alias: 'add-collateral', params: { market, side, amount: parseFloat(m[1]) } };
      }
    }
  }
  {
    const m = lower.match(/^add\s+(?:collateral\s+(?:of\s+)?)?\$?(\d+(?:\.\d+)?)\s+(?:dollars?\s+)?(?:collateral\s+)?(?:to\s+|on\s+)?(?:my\s+)?([a-z]+)$/);
    if (m) {
      const market = resolveMarket(m[2]);
      if (isKnownMarket(market)) return { alias: 'add-collateral', params: { market, amount: parseFloat(m[1]) } };
    }
  }
  // ─── Remove collateral: "remove $20 from SOL long" / no side ────────────
  {
    const m = lower.match(/^remove\s+\$?(\d+(?:\.\d+)?)\s+(?:dollars?\s+)?(?:collateral\s+)?(?:from\s+|on\s+)?(?:my\s+)?([a-z]+)\s+(long|short|buy|sell)$/);
    if (m) {
      const side = parseSide(m[3]);
      const market = resolveMarket(m[2]);
      if (side && isKnownMarket(market)) {
        return { alias: 'remove-collateral', params: { market, side, amount: parseFloat(m[1]) } };
      }
    }
  }
  {
    const m = lower.match(/^remove\s+\$?(\d+(?:\.\d+)?)\s+(?:dollars?\s+)?(?:collateral\s+)?(?:from\s+|on\s+)?(?:my\s+)?([a-z]+)$/);
    if (m) {
      const market = resolveMarket(m[2]);
      if (isKnownMarket(market)) return { alias: 'remove-collateral', params: { market, amount: parseFloat(m[1]) } };
    }
  }

  // ─── Increase: "increase SOL long 10" / "size up SOL 5" ─────────────────
  {
    const m = lower.match(/^(?:increase|size\s+up|grow)\s+([a-z]+)\s+(long|short|buy|sell)\s+\$?(\d+(?:\.\d+)?)$/);
    if (m) {
      const side = parseSide(m[2]);
      const market = resolveMarket(m[1]);
      if (side && isKnownMarket(market)) {
        return { alias: 'increase', params: { market, side, sizeUsd: parseFloat(m[3]) } };
      }
    }
  }

  // ─── Cancel limit by index (delegated alias parser handles this too) ────
  if (/^cancel\s+(?:order\s+)?(?:#)?(?:order-)?(\d+)$/.test(lower)) {
    const m = lower.match(/^cancel\s+(?:order\s+)?(?:#)?(?:order-)?(\d+)$/);
    if (m) return { alias: 'cancel', params: { target: m[1] } };
  }
  if (/^cancel\s+all$/.test(lower)) return { alias: 'cancel', params: { target: 'all' } };

  // ─── Price: "price of SOL", "SOL price", "btc" alone ────────────────────
  {
    if (/^all\s+markets$/.test(lower)) return { alias: 'markets', params: {} };
    const m = lower.match(/^(?:price\s+of\s+)?([a-z\s]+?)\s*(?:price)?$/);
    if (m) {
      const market = resolveMarket(m[1].trim());
      if (isKnownMarket(market)) return { alias: 'price', params: { market } };
    }
  }

  // ─── Flexible OPEN — last attempt before fuzzy fallback ─────────────────
  {
    const hasSide = /\b(long|short|buy|sell)\b/.test(lower);
    const hasNumbers = /\d/.test(lower);
    const openPrefixes = /^(?:open|enter|long|short|buy|sell|please|pls|yo|hey|ok|okay|i|just|let|can|go)\b/.test(lower);
    const marketSidePattern = /^[a-z]+\s+(?:long|short|buy|sell)\b/.test(lower);
    const numberFirst = /^\d/.test(lower);
    const hasLevPattern = /\d+\s*x\b/i.test(lower);

    if (hasNumbers && (openPrefixes || marketSidePattern || (numberFirst && hasSide) || hasLevPattern)) {
      const r = flexParseOpen(lower);
      if (r) return r;
      const corrected = fuzzyCorrect(lower);
      if (corrected !== lower) {
        const r2 = flexParseOpen(corrected);
        if (r2) return r2;
      }
    }
    if (hasNumbers && !hasSide) {
      const corrected = fuzzyCorrect(lower);
      if (corrected !== lower) {
        const r = flexParseOpen(corrected);
        if (r) return r;
      }
    }
  }

  return null;
}
