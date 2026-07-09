/**
 * Welcome banner — figlet ANSI-shadow text rendered with the Flash Trade
 * brand gradient (teal → cyan → yellow), framed by faint divider lines.
 *
 * Renders to a single string so the caller can `console.log` once and avoid
 * any flicker / interleaving with the prompt during startup.
 */

import chalk from 'chalk';
import { createRequire } from 'module';
import { c, BRAND, DIAMOND, BRAND_NAME_UPPER } from './magic-theme.js';

// `figlet` and `gradient-string` are heavy (~30 ms combined). They're
// only used by `renderHero()` which fires once per session. Lazy-load
// them on first use so non-banner code paths (one-shot dispatch,
// NO_DNA, --help, --version, doctor, perf) don't pay for them.
type FigletApi = { textSync: (text: string, opts?: unknown) => string };
type GradientFn = (line: string) => string;
type GradientFactory = (colors: string[]) => GradientFn;
let figletApi: FigletApi | null = null;
let gradientFactory: GradientFactory | null = null;
async function loadFigletDeps(): Promise<void> {
  if (figletApi && gradientFactory) return;
  const [fig, grad] = await Promise.all([
    import('figlet'),
    import('gradient-string'),
  ]);
  figletApi = (fig.default as unknown as FigletApi) ?? (fig as unknown as FigletApi);
  gradientFactory = (grad.default as unknown as GradientFactory) ?? (grad as unknown as GradientFactory);
}

const require = createRequire(import.meta.url);
let BANNER_VERSION = '0.1.0';
try {
  // Read once at import time — package.json is colocated with the build.
  const pkg = require('../../package.json') as { version?: string };
  if (pkg.version) BANNER_VERSION = pkg.version;
} catch {
  // Fallback to literal default.
}

// Honor NO_COLOR + non-TTY (piping/CI) + NO_DNA (agent mode). Crucially also
// gate on `chalk.level === 0` so `FORCE_COLOR=0` (which chalk respects but
// gradient-string ignores) doesn't produce raw ANSI codes for users who
// explicitly turned color off.
const useColor =
  chalk.level > 0 &&
  !process.env.NO_COLOR &&
  !process.env.NO_DNA &&
  process.stdout.isTTY;

export interface BannerInfo {
  network: 'mainnet-beta' | 'devnet';
  pool: string;
  programId: string;
  walletAddress?: string;
  erUrl: string;
}

/**
 * Hero — figlet + brand line, framed by faint dividers. Rendered BEFORE wallet
 * setup so the user is greeted immediately when they type `magic`. No session
 * info here because the wallet hasn't been chosen yet.
 *
 * Async so the heavy `figlet` / `gradient-string` deps can be lazy-loaded
 * on first use — paths that never call this (one-shot dispatch, NO_DNA,
 * doctor, perf) skip ~30 ms of import cost on cold start.
 */
export async function renderHero(): Promise<string> {
  // NO_DNA agent mode: skip the figlet entirely. Agents have no use for
  // multi-line ASCII art and the JSON parsers downstream would only have
  // to filter it out. Emit a single machine-parseable line instead.
  if (process.env.NO_DNA) {
    return JSON.stringify({
      ts: new Date().toISOString(),
      kind: 'banner',
      product: 'flash-magic-terminal',
      version: BANNER_VERSION,
    }) + '\n';
  }
  const cols = process.stdout.columns ?? 80;
  // figlet "FLASH" in ANSI Shadow is ~36 chars wide. Below ~50 cols (mobile, tmux
  // splits, narrow CI logs) it shears across line wraps — fall back to a compact
  // single-line banner so the first impression stays clean.
  const wide = cols >= 60;
  const dividerWidth = Math.max(20, Math.min(72, cols - 2));

  await loadFigletDeps();
  const flashGradient = gradientFactory!([BRAND.teal, BRAND.cyan, BRAND.yellow]);
  const tint = (line: string): string => (useColor ? flashGradient(line) : line);

  let figletLines: string[] = [];
  if (wide) {
    try {
      const flash = figletApi!.textSync('FLASH', {
        font: 'ANSI Shadow',
        horizontalLayout: 'default',
        verticalLayout: 'default',
      });
      figletLines = flash.split('\n').filter((l: string) => l.trim().length > 0);
    } catch {
      // figlet font not bundled (rare but possible on alpine / pkg'd binaries).
      figletLines = [];
    }
  }

  const lines: string[] = [];
  lines.push('');
  lines.push(c.faint('  ' + '━'.repeat(dividerWidth)));
  lines.push('');
  if (figletLines.length > 0) {
    for (const line of figletLines) {
      lines.push('   ' + tint(line));
    }
  } else {
    lines.push(`   ${tint('FLASH')}`);
  }
  lines.push('');
  lines.push(
    `   ${DIAMOND}  ${c.teal.bold(BRAND_NAME_UPPER)}  ${c.muted(`v${BANNER_VERSION}`)}` +
      `            ${c.muted('sub-second perpetuals on MagicBlock ER')}`,
  );
  lines.push('');
  lines.push(c.faint('  ' + '━'.repeat(dividerWidth)));
  lines.push('');
  return lines.join('\n');
}

/**
 * Session panel — shown AFTER wallet connect by `MagicTerminal.start()`. The
 * figlet is intentionally omitted here so the user doesn't see it twice; this
 * panel is the "ready to trade" confirmation.
 */
export function renderSession(info: BannerInfo): string {
  if (process.env.NO_DNA) {
    return JSON.stringify({
      ts: new Date().toISOString(),
      kind: 'session',
      network: info.network,
      pool: info.pool,
      programId: info.programId,
      router: info.erUrl,
      walletAddress: info.walletAddress,
    }) + '\n';
  }
  const lines: string[] = [];
  lines.push('');
  lines.push(c.faint('  ' + '━'.repeat(72)));

  const wallet = info.walletAddress
    ? `${info.walletAddress.slice(0, 4)}…${info.walletAddress.slice(-4)}`
    : c.warn('not loaded');

  const rows: { label: string; value: string }[] = [
    { label: 'Network', value: c.primary(`${info.network} · ${info.pool}`) },
    { label: 'Program', value: c.primary(`${info.programId.slice(0, 8)}…${info.programId.slice(-4)}`) },
    { label: 'Router',  value: c.primary(stripScheme(info.erUrl)) },
    { label: 'Wallet',  value: typeof wallet === 'string' && wallet.startsWith('\x1b') ? wallet : c.primary(wallet) },
  ];
  for (const r of rows) {
    lines.push(`  ${c.muted(r.label.padEnd(10))}${r.value}`);
  }
  lines.push(c.faint('  ' + '━'.repeat(72)));
  lines.push('');
  lines.push(`  ${c.muted("Type")} ${c.cyan('help')} ${c.muted("for the full command list, or jump in:")} ${c.teal.bold('open SOL long 5 2')}`);
  lines.push('');
  return lines.join('\n');
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
