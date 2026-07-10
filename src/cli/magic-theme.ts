/**
 * Visual theme — uses the exact Flash Trade brand palette.
 *
 * Colors (extracted from flash-ui/src/app/globals.css):
 *   --color-brand-teal      #33c9a1  primary brand
 *   --color-brand-cyan      #3affe1  accent
 *   --color-brand-yellow    #ffeb00  highlight
 *   --color-accent-long     #00d26a  long / positive
 *   --color-accent-short    #ff4d4d  short / negative
 *   --color-accent-warn     #f5a623  warning
 *   --color-accent-blue     #3b82f6  info
 *   --color-accent-purple   #8b5cf6
 *   --color-accent-lime     #c8f547
 *   --color-text-primary    #e8ecf3
 *   --color-text-secondary  #7b8da3
 *   --color-text-tertiary   #3e5068
 *
 * Visual language:
 *   - Vertical accent bar (▌) on the left of every card, color-tinted by tone.
 *   - Brand teal for "magic" identity, brand cyan for actions, yellow for accents.
 *   - Single accent color per card — never a rainbow.
 */

import chalk from 'chalk';

// ─── Brand palette ────────────────────────────────────────────────────────────
export const BRAND = {
  teal:    '#33c9a1',
  cyan:    '#3affe1',
  yellow:  '#ffeb00',
  long:    '#00d26a',
  short:   '#ff4d4d',
  warn:    '#f5a623',
  blue:    '#3b82f6',
  purple:  '#8b5cf6',
  lime:    '#c8f547',
  primary: '#e8ecf3',
  muted:   '#7b8da3',
  faint:   '#3e5068',
} as const;

export const c = {
  teal:    chalk.hex(BRAND.teal),
  cyan:    chalk.hex(BRAND.cyan),
  yellow:  chalk.hex(BRAND.yellow),
  long:    chalk.hex(BRAND.long),
  short:   chalk.hex(BRAND.short),
  warn:    chalk.hex(BRAND.warn),
  blue:    chalk.hex(BRAND.blue),
  purple:  chalk.hex(BRAND.purple),
  lime:    chalk.hex(BRAND.lime),
  primary: chalk.hex(BRAND.primary),
  muted:   chalk.hex(BRAND.muted),
  faint:   chalk.hex(BRAND.faint),
} as const;

// ─── Sigils ───────────────────────────────────────────────────────────────────
export const SPARK   = c.cyan('✦');
export const BOLT    = c.yellow('⚡');
export const DIAMOND = c.teal('◆');
export const ARROW   = c.muted('→');
export const DOT     = c.muted('·');

// ─── Brand identity ───────────────────────────────────────────────────────────
// Single source of truth — every banner / header / monitor title goes through
// this constant so the app never shipped with five different brand strings
// across one session ("MAGIC TERMINAL" / "FLASH MAGIC" / "Flash Magic" /
// "FLASH MAGIC TERMINAL" / "Flash Magic Terminal").
export const BRAND_NAME       = 'Flash Magic Terminal';
export const BRAND_NAME_UPPER = 'FLASH MAGIC TERMINAL';
export const BRAND_NAME_SHORT = 'Flash Magic';

// ─── String width helpers ─────────────────────────────────────────────────────
export function vlen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}
export function pad(s: string, target: number): string {
  const need = target - vlen(s);
  return need > 0 ? s + ' '.repeat(need) : s;
}
export function truncate(s: string, max: number): string {
  return vlen(s) <= max ? s : s.slice(0, Math.max(1, max - 1)) + '…';
}

/**
 * Truncate a long URL by middle-eliding while preserving host + tail.
 * Strips ANSI before measuring/slicing so a chalk-wrapped URL doesn't
 * get cut mid-escape (which would corrupt downstream rendering).
 */
export function compactUrl(url: string, max = 60): string {
  // eslint-disable-next-line no-control-regex
  const plain = url.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  if (plain.length <= max) return plain;
  const head = plain.slice(0, Math.floor(max * 0.55));
  const tail = plain.slice(-Math.floor(max * 0.35));
  return `${head}…${tail}`;
}

// ─── Tagged labels ────────────────────────────────────────────────────────────
export function sideLabel(side: string): string {
  return side === 'short' ? c.short.bold('SHORT') : c.long.bold('LONG');
}

export function marketHeader(symbol: string, side: string, leverage?: number): string {
  const parts = [c.primary.bold(symbol.toUpperCase()), sideLabel(side)];
  if (leverage !== undefined && Number.isFinite(leverage) && leverage > 0) {
    // Format leverage cleanly:
    //   integer → `2x`     (no decimals when it's a whole number)
    //   else    → `2.5x`   (1 decimal max)
    // Float drift from `sizeUsd / collateralUsd` (e.g. `2.000001000876…`)
    // collapses to `2x`. Above 100x we drop the decimal entirely; users
    // setting >100x leverage care about the integer.
    const rounded = Math.round(leverage * 10) / 10;
    const lev = Number.isInteger(rounded) || leverage >= 100
      ? Math.round(leverage).toString()
      : rounded.toFixed(1);
    parts.push(c.muted(`${lev}x`));
  }
  return parts.join(' ' + DOT + ' ');
}

/**
 * Latency pill — four-tier color + ms/s format that matches user perception:
 *  - <500ms  green       fast (cache hit, ER confirm)
 *  - <2s     yellow      acceptable
 *  - <10s    red         slow but landed
 *  - ≥10s    red bold + "(slow)" suffix      something is wrong (RPC timing out)
 *
 * All values render as decimal seconds (`0.34s`, `1.28s`, `12.4s`) for a
 * consistent unit. Older `47ms` style was easier to read at the low end
 * but mixed units across rows in dashboards and surprised users who
 * expected one scale. 2 decimals up to 10 s; 1 decimal beyond that.
 */
export function latencyPill(ms: number): string {
  const seconds = ms / 1000;
  const text = ms < 10_000 ? `${seconds.toFixed(2)}s` : `${seconds.toFixed(1)}s`;
  if (ms < 500) return `${c.long('⚡')} ${c.long(text)}`;
  if (ms < 2_000) return `${c.warn('⚡')} ${c.warn(text)}`;
  if (ms < 10_000) return `${c.short('⚡')} ${c.short(text)}`;
  return `${c.short.bold('⚡')} ${c.short.bold(text)} ${c.short.bold('(slow)')}`;
}

/** Horizontal utilization bar — green→yellow→red as ratio climbs. */
export function bar(value: number, max: number, width = 18): string {
  const ratio = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  const filled = Math.round(ratio * width);
  let color = c.long;
  if (ratio > 0.85) color = c.short;
  else if (ratio > 0.6) color = c.warn;
  return color('█'.repeat(filled)) + c.faint('·'.repeat(width - filled));
}

// ─── Card layout ──────────────────────────────────────────────────────────────
export type Tone = 'open' | 'close' | 'info' | 'warn' | 'error';
const TONE_COLOR: Record<Tone, (s: string) => string> = {
  open:  c.long,
  close: c.cyan,
  info:  c.teal,
  warn:  c.warn,
  error: c.short,
};

export interface KV { label: string; value: string }

export interface CardOpts {
  status: string;
  subtitle?: string;
  rows: KV[];
  /** Explorer URL for the tx (rendered as `→ <url>` under the card). */
  url?: string;
  latencyMs?: number;
  tone?: Tone;
  /** Force single-column layout. Default auto: 2-col if rows ≥ 4 AND every value fits half-card. */
  columns?: 1 | 2;
}

const INNER = 70;
const LABEL_W = 14;
const COL_GAP = 4;

export function renderCard(opts: CardOpts): string {
  const tone = opts.tone ?? 'info';
  const tc = TONE_COLOR[tone];
  const accentBar = tc('▌');
  const lines: string[] = [];

  const headerLeft = tc.bind(null)(opts.status.toUpperCase());
  const headerLeftBold = chalk.bold(headerLeft);
  const headerRight = opts.subtitle ?? '';
  const headerPad = INNER - vlen(headerLeftBold) - vlen(headerRight);
  lines.push('');
  lines.push(`  ${accentBar}  ${headerLeftBold}${' '.repeat(Math.max(headerPad, 2))}${headerRight}`);
  lines.push(`  ${accentBar}`);

  const halfWidth = Math.floor((INNER - COL_GAP) / 2);
  const cellWidth = (r: KV) => LABEL_W + vlen(r.value);
  const fitsHalf = opts.rows.every((r) => cellWidth(r) <= halfWidth);
  const useTwoCols = opts.columns === 2 || (opts.columns !== 1 && opts.rows.length >= 4 && fitsHalf);

  if (useTwoCols) {
    const renderCell = (r: KV | undefined): string => {
      if (!r) return '';
      return c.muted(pad(r.label, LABEL_W)) + r.value;
    };
    for (let i = 0; i < opts.rows.length; i += 2) {
      const left = renderCell(opts.rows[i]);
      const right = renderCell(opts.rows[i + 1]);
      const leftPadded = pad(left, halfWidth + COL_GAP);
      lines.push(`  ${accentBar}  ${leftPadded}${right}`);
    }
  } else {
    for (const r of opts.rows) {
      // Empty label → no 14-char gutter. Free-form content (tables, JSON,
      // status lines) sits directly after the accent bar instead of being
      // pushed right by a phantom label column.
      if (r.label === '') {
        lines.push(`  ${accentBar}  ${r.value}`);
        continue;
      }
      const labelStr = c.muted(pad(r.label, LABEL_W));
      lines.push(`  ${accentBar}  ${labelStr}${r.value}`);
    }
  }

  if (opts.latencyMs !== undefined) {
    lines.push(`  ${accentBar}`);
    lines.push(`  ${accentBar}  ${latencyPill(opts.latencyMs)}`);
  }

  lines.push('');
  if (opts.url) {
    lines.push(`     ${c.cyan('→')} ${c.muted(opts.url)}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Two-column key/value block (no card frame). For status / dashboard. */
export function kvBlock(rows: KV[]): string {
  const labelW = 16;
  return rows.map((r) => `  ${c.muted(pad(r.label, labelW))}${r.value}`).join('\n');
}

export function divider(title?: string): string {
  if (!title) return c.faint('  ' + '─'.repeat(INNER));
  const padded = ` ${title.toUpperCase()} `;
  const remaining = INNER - vlen(padded);
  return `  ${c.faint('─'.repeat(2))}${c.teal.bold(padded)}${c.faint('─'.repeat(Math.max(remaining - 2, 1)))}`;
}

export function liqDistanceBar(distance: number, width = 12): string {
  const ratio = Math.max(0, Math.min(1, distance));
  const filled = Math.round(ratio * width);
  let color = c.long;
  if (ratio < 0.15) color = c.short;
  else if (ratio < 0.30) color = c.warn;
  return color('█'.repeat(filled)) + c.faint('·'.repeat(width - filled));
}

/** Compact one-line banner used once at startup; the full figlet banner lives in cli/banner.ts. */
export function magicBanner(): string {
  const left = `${DIAMOND}  ${c.teal.bold(BRAND_NAME_UPPER)}  ${c.muted('v2')}`;
  const right = c.muted('MagicBlock ER · sub-second confirms');
  const padBetween = INNER - vlen(left) - vlen(right);
  return [
    '',
    `  ${left}${' '.repeat(Math.max(padBetween, 4))}${right}`,
    `  ${c.faint('━'.repeat(INNER + 4))}`,
    '',
  ].join('\n');
}
