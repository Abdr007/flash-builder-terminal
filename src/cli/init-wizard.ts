/**
 * First-run setup wizard.
 *
 * Inspired by `gh auth login`, `vercel`, `bun install`, `supabase init` —
 * the rule is: ask ONE question max, auto-detect everything else, end
 * with ONE next command.
 *
 * Default flow (zero / one prompt):
 *
 *   $ magic init
 *   ◆  Flash Magic Terminal — first-run setup
 *
 *   ✔ Wallet detected: ABDR (Dvvz…LfmK)
 *   ? RPC URL (paste Helius/QuickNode/Triton, or enter for public): _
 *   ✔ RPC reachable: api.mainnet-beta.solana.com  slot 418006681  (102 ms)
 *   ✔ Wrote ~/.magic/.env
 *
 *   Ready. Run `magic` to start.
 *
 * Power users get `magic init --quick` for zero prompts (auto-detected
 * wallet, public RPC, default caps). Everything else can be tweaked
 * later via `rpc set`, `MAX_*` env vars, or the `~/.magic/.env` file.
 *
 * NO_DNA mode skips the wizard and emits a one-shot template — agents
 * shouldn't be prompted, ever.
 */

import { createInterface, Interface } from 'readline';
import { existsSync, mkdirSync, statSync } from 'fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { homedir } from 'os';
import { resolve, dirname } from 'path';
import chalk from 'chalk';
import { c, DIAMOND } from './magic-theme.js';
import { userEnvFilePath, validateRpcUrl } from '../config/index.js';

interface WizardAnswers {
  network: 'mainnet-beta' | 'devnet';
  l1RpcUrl: string;
  walletPath: string | null;
}

interface WizardOptions {
  /**
   * Skip all prompts. Uses the public RPC, auto-detects the wallet (or
   * leaves it unset), applies sensible default caps. Designed for
   * scripted onboarding (`magic init --quick`) and CI smoke runs.
   */
  quick?: boolean;
  /** Override network (`mainnet-beta` default). */
  network?: 'mainnet-beta' | 'devnet';
  /**
   * Reuse an already-open readline interface instead of creating a new one.
   *
   * CRITICAL: when `init` runs from inside the REPL the terminal already owns
   * a `terminal:true` readline on `process.stdin`. Opening a SECOND interface
   * here makes BOTH echo every keystroke — the user sees `hhttttppss::…`. The
   * fix is to prompt on the caller's existing interface. When omitted (the
   * pre-REPL auto-wizard / one-shot `magic init`) we own the interface and
   * create + close it ourselves.
   */
  rl?: Interface;
  /**
   * Mask the RPC keystrokes as the user types (the URL usually embeds a
   * paid-provider API key). Off by default so the pre-REPL path still echoes
   * normally; the REPL onboarding turns it on.
   */
  maskRpc?: boolean;
}

/** Auto-detect a Solana CLI keypair. Returns the path iff readable + valid. */
function autoDetectWallet(): string | null {
  const cliWallet = resolve(homedir(), '.config/solana/id.json');
  if (!existsSync(cliWallet)) return null;
  try {
    const st = statSync(cliWallet);
    if (!st.isFile()) return null;
    return cliWallet;
  } catch {
    return null;
  }
}

/**
 * Probe the RPC URL with a `getSlot`. Returns the slot + RTT on success,
 * throws otherwise. Used to verify the user's RPC choice actually works.
 */
async function probeRpc(url: string, timeoutMs = 5000): Promise<{ slot: number; ms: number }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { result?: number; error?: { message: string } };
    if (j.error) throw new Error(j.error.message);
    if (typeof j.result !== 'number') throw new Error('no slot in response');
    return { slot: j.result, ms: Date.now() - t0 };
  } finally {
    clearTimeout(t);
  }
}

/** One-line prompt with `[enter] = default`. Returns the trimmed input or default. */
async function promptOne(rl: Interface, line: string, defaultValue: string): Promise<string> {
  return new Promise((res) => {
    rl.question(line, (answer) => res(answer.trim() || defaultValue));
  });
}

/**
 * Like `promptOne`, but the user's keystrokes are hidden (password-style) —
 * the RPC URL usually carries a paid-provider API key that shouldn't be echoed
 * to a scrollback buffer or a shared screen.
 *
 * Implemented with the documented readline trick: swap `_writeToOutput` so the
 * query itself prints, then every subsequent keystroke is swallowed (newlines
 * still pass through so Enter advances the line). Restored on completion so the
 * caller's interface — which may be the live REPL's — echoes normally again.
 */
async function promptMasked(rl: Interface, line: string, defaultValue: string): Promise<string> {
  return new Promise((res) => {
    const rlAny = rl as unknown as {
      _writeToOutput: (s: string) => void;
      output: NodeJS.WritableStream;
      _muted?: boolean;
    };
    const original = rlAny._writeToOutput.bind(rlAny);
    const out = rlAny.output ?? process.stdout;
    rlAny._muted = false;
    rlAny._writeToOutput = (s: string): void => {
      if (rlAny._muted) {
        // Preserve line breaks so Enter still moves the cursor down; hide
        // everything else (the pasted / typed URL, backspace redraws, …).
        if (s.includes('\n')) out.write('\n');
        return;
      }
      original(s);
    };
    rl.question(line, (answer) => {
      rlAny._muted = false;
      rlAny._writeToOutput = original;
      res(answer.trim() || defaultValue);
    });
    // The query printed while unmuted; from here on, mask input.
    rlAny._muted = true;
  });
}

/** Pretty-print the running wallet pubkey + a 4…4 short address. */
function shortenPubkey(p: string): string {
  return p.length <= 12 ? p : `${p.slice(0, 4)}…${p.slice(-4)}`;
}

/**
 * Read the wallet's pubkey for display. Best-effort — failure here doesn't
 * block the wizard, we just show "(detected)" instead of the address.
 */
async function tryReadPubkey(walletPath: string): Promise<string | null> {
  try {
    const { readFileSync } = await import('fs');
    const { Keypair } = await import('@solana/web3.js');
    const raw = readFileSync(walletPath, 'utf-8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== 64) return null;
    // Scrub the retained secret buffer after deriving the address — we only
    // want the pubkey here, not to leave 64 key bytes lingering in the heap.
    const keyBytes = Uint8Array.from(arr);
    if (Array.isArray(arr)) arr.fill(0);
    const kp = Keypair.fromSecretKey(keyBytes);
    const pubkey = kp.publicKey.toBase58();
    try { keyBytes.fill(0); } catch { /* best-effort */ }
    return pubkey;
  } catch {
    return null;
  }
}

/**
 * Render the .env file from the wizard's answers. Active values for
 * the user's choices — no commented-out template lines that the user
 * would otherwise have to uncomment.
 */
function renderEnv(a: WizardAnswers): string {
  const lines: string[] = [];
  lines.push('# Flash Magic Terminal — generated by `magic init`.');
  lines.push('# Edit by hand to tweak; process env always wins. `rpc set`');
  lines.push('# writes to ~/.magic/config.json which overrides this file.');
  lines.push('');
  lines.push(`MAGIC_NETWORK=${a.network}`);
  lines.push(`MAGIC_POOL_NAME=${a.network === 'devnet' ? 'Pool.1' : 'Pool.0'}`);
  lines.push(`MAGIC_L1_RPC_URL=${a.l1RpcUrl}`);
  lines.push('');
  if (a.walletPath) {
    lines.push(`MAGIC_WALLET_PATH=${a.walletPath}`);
  } else {
    lines.push('# MAGIC_WALLET_PATH=/abs/path/to/keypair.json');
  }
  lines.push('');
  lines.push('# Risk caps — 0 = unlimited. Edit if you need different limits.');
  lines.push('MAX_COLLATERAL_PER_TRADE=100');
  lines.push('MAX_POSITION_SIZE=0');
  lines.push('MAX_LEVERAGE=20');
  lines.push('MAX_TRADES_PER_MINUTE=10');
  lines.push('MIN_DELAY_BETWEEN_TRADES_MS=0');
  lines.push('');
  lines.push('# UX — set to true ONLY if you fully trust your prompts.');
  lines.push('MAGIC_AUTO_CONFIRM=false');
  lines.push('MAGIC_FAST_CONFIRM=true');
  lines.push('MAGIC_LOG_LEVEL=info');
  lines.push('');
  return lines.join('\n');
}

/**
 * Run the wizard. Returns the env path written, or `cancelled: true` if
 * the user bailed. Quick mode skips all prompts.
 */
export async function runInitWizard(
  opts: WizardOptions = {},
): Promise<{ envPath: string; cancelled: boolean; l1RpcUrl: string }> {
  const network = opts.network ?? 'mainnet-beta';
  const publicRpc = network === 'devnet'
    ? 'https://api.devnet.solana.com'
    : 'https://api.mainnet-beta.solana.com';

  const envPath = userEnvFilePath();
  const dir = dirname(envPath);

  // Auto-detect wallet up-front so the prompt phase can show the user
  // exactly what we found.
  const walletPath = autoDetectWallet();
  const walletPubkey = walletPath ? await tryReadPubkey(walletPath) : null;

  // ── Banner ─────────────────────────────────────────────────────────
  process.stdout.write('\n');
  process.stdout.write(`  ${DIAMOND}  ${c.teal.bold('Flash Magic Terminal')}  ${c.muted('— first-run setup')}\n`);
  process.stdout.write('\n');

  // ── Wallet auto-detect line ────────────────────────────────────────
  if (walletPath) {
    const display = walletPubkey ? shortenPubkey(walletPubkey) : '(detected)';
    process.stdout.write(`  ${c.long('✔')}  ${c.muted('Wallet detected:')} ${c.cyan(display)}  ${c.faint(walletPath)}\n`);
  } else {
    process.stdout.write(`  ${c.warn('!')}  ${c.muted('No wallet at')} ${c.faint('~/.config/solana/id.json')}  ${c.muted('(import one later in the REPL)')}\n`);
  }

  // ── Confirmation gate for overwrites ───────────────────────────────
  if (existsSync(envPath) && !opts.quick) {
    process.stdout.write(`  ${c.warn('!')}  ${c.muted('Existing config at')} ${c.cyan(envPath)} ${c.muted('— will overwrite')}\n`);
  }

  // ── RPC: zero prompts in quick mode, exactly ONE prompt otherwise ──
  let l1RpcUrl: string;
  if (opts.quick) {
    l1RpcUrl = publicRpc;
    process.stdout.write(`  ${c.long('✔')}  ${c.muted('RPC:')} ${c.faint(publicRpc)} ${c.muted('(public — quick mode)')}\n`);
  } else {
    // Reuse the caller's readline when given one (the REPL already owns
    // stdin — opening a second interface double-echoes every keystroke).
    // Only own + close the interface when nobody handed us one.
    const rl = opts.rl ?? createInterface({ input: process.stdin, output: process.stdout });
    const ownRl = !opts.rl;
    const onSigint = (): void => {
      process.stdout.write('\n  ' + c.muted('cancelled — no changes written') + '\n');
      rl.close();
      process.exit(130);
    };
    if (ownRl) rl.on('SIGINT', onSigint);

    process.stdout.write('\n');
    const hint = opts.maskRpc
      ? `  ${c.faint('RPC URL — paste Helius / QuickNode / Triton (hidden), or')} ${c.cyan('[enter]')} ${c.faint('for public')}\n`
      : `  ${c.faint('RPC URL — paste Helius / QuickNode / Triton, or')} ${c.cyan('[enter]')} ${c.faint('for public')}\n`;
    process.stdout.write(hint);

    let ok = false;
    while (!ok) {
      const ask = opts.maskRpc ? promptMasked : promptOne;
      const raw = await ask(rl, `  ${c.muted('>')} `, publicRpc);
      try {
        l1RpcUrl = validateRpcUrl(raw, 'L1 RPC');
        ok = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write(c.short(`  ${msg}\n`));
        process.stdout.write(c.faint(`  try again, or [enter] for the public one\n`));
      }
    }
    if (ownRl) {
      rl.removeListener('SIGINT', onSigint);
      rl.close();
    }
    l1RpcUrl ??= publicRpc;
  }

  // ── Probe the RPC with a tiny spinner-style line ───────────────────
  process.stdout.write(`  ${c.muted('…')}  ${c.muted('Probing RPC')}`);
  let probeLine: string;
  try {
    const { slot, ms } = await probeRpc(l1RpcUrl, 5000);
    const host = (() => {
      try { return new URL(l1RpcUrl).hostname; } catch { return l1RpcUrl; }
    })();
    probeLine = `\r  ${c.long('✔')}  ${c.muted('RPC reachable:')} ${c.cyan(host)}  ${c.muted('slot')} ${slot}  ${c.faint(`(${ms} ms)`)}\n`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    probeLine = `\r  ${c.warn('!')}  ${c.muted('RPC probe failed:')} ${c.short(msg)}  ${c.faint('(saving anyway — fix later with `rpc set`)')}\n`;
  }
  process.stdout.write(probeLine);

  // ── Write the env file ─────────────────────────────────────────────
  const answers: WizardAnswers = { network, l1RpcUrl: l1RpcUrl!, walletPath };
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(envPath, renderEnv(answers), 0o600);
  process.stdout.write(`  ${c.long('✔')}  ${c.muted('Wrote')} ${c.cyan(envPath)}\n`);

  // ── Next step. ─────────────────────────────────────────────────────
  // When we own the interface (pre-REPL / one-shot) the next move is to
  // launch the terminal. When the REPL handed us its interface it drives the
  // guided continuation (live RPC swap → setup → deposit) itself, so we stay
  // quiet here rather than telling the user to "run magic" from inside magic.
  if (!opts.rl) {
    process.stdout.write('\n');
    process.stdout.write(`  ${c.teal.bold('Ready.')}  ${c.muted('Run')} ${c.teal.bold('magic')} ${c.muted('to start.')}\n`);
    process.stdout.write('\n');
  }

  // Reference unused chalk import (kept available for future use).
  void chalk;

  return { envPath, cancelled: false, l1RpcUrl: l1RpcUrl! };
}
