/**
 * Wallet UI flows — bolt-terminal parity, single-mode (magic) variant.
 *
 * `setupWallet()` runs at startup BEFORE the banner. Behaviour:
 *  - 0 saved wallets → first-time setup (create / import / connect file).
 *  - 1+ saved wallets + a default → "Saved Wallets" menu.
 *  - 1+ saved wallets + no default → wallet picker.
 *
 * Registry: ~/.flash/wallets.json (shared with bolt-terminal — existing
 * wallets work without re-import). Last-used wallet recorded in
 * ~/.flash/session.json. No key material is stored anywhere by Flash.
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import chalk from 'chalk';
import { WalletManager } from '../wallet/walletManager.js';
import { WalletStore } from '../wallet/wallet-store.js';
import { getLastWallet, updateLastWallet } from '../wallet/session.js';
import { shortAddress } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import { c, DIAMOND, vlen } from './magic-theme.js';

export interface WalletFlowDeps {
  ask: (question: string) => Promise<string>;
  walletManager: WalletManager;
}

const MENU_WIDTH = 64;

/** Card-style menu header with accent bar, brand-teal title, and a subtitle on the right. */
function menuHeader(title: string, subtitle?: string): string[] {
  const accent = c.teal('▌');
  const left = c.teal.bold(title.toUpperCase());
  const right = subtitle ? `${DIAMOND}  ${c.muted(subtitle)}` : '';
  const gap = MENU_WIDTH - vlen(left) - vlen(right);
  return [
    '',
    `  ${accent}  ${left}${' '.repeat(Math.max(gap, 4))}${right}`,
    `  ${accent}`,
  ];
}

/** Single menu row — `key` (cyan), label (primary), optional right-aligned meta (muted). */
function menuRow(key: string, label: string, meta?: string): string {
  const accent = c.teal('▌');
  const keyStr = c.cyan.bold(key);
  const left = `${keyStr}   ${c.primary(label)}`;
  if (!meta) return `  ${accent}   ${left}`;
  const gap = MENU_WIDTH - vlen(left) - vlen(meta) - 4;
  return `  ${accent}   ${left}${' '.repeat(Math.max(gap, 2))}${c.muted(meta)}`;
}

function menuFoot(): string {
  return `  ${c.teal('▌')}`;
}

/** Cyan chevron prompt. */
const PROMPT = `  ${c.cyan('❯')} `;

/** Try to connect a wallet from a file path. Returns info on success, null on failure. */
export function tryConnectWallet(walletManager: WalletManager, path: string): { address: string } | null {
  try {
    const result = walletManager.loadFromFile(path);
    return { address: result.address };
  } catch (error: unknown) {
    console.log(chalk.red(`  Failed to load wallet: ${getErrorMessage(error)}`));
    return null;
  }
}

/**
 * Top-level startup flow. Picks/creates a wallet and connects it via
 * `walletManager`. Returns `{address, name}` on success, `null` on user exit.
 */
export async function setupWallet(deps: WalletFlowDeps): Promise<{ address: string; name: string } | null> {
  const store = new WalletStore();
  const wallets = store.listWallets();
  let defaultWallet = store.getDefault();
  const sessionWallet = getLastWallet();

  if (wallets.length === 0) {
    return showFirstTimeWalletSetup(deps, store);
  }

  if (!defaultWallet && wallets.length === 1) {
    store.setDefault(wallets[0]);
    defaultWallet = wallets[0];
  }

  const targetWallet = defaultWallet ?? sessionWallet;

  if (targetWallet && wallets.includes(targetWallet)) {
    return showSavedWalletsMenu(deps, store, wallets, targetWallet);
  }

  return showWalletPicker(deps, store, wallets);
}

// ─── Saved wallets menu ───────────────────────────────────────────────────────

export async function showSavedWalletsMenu(
  deps: WalletFlowDeps,
  store: WalletStore,
  wallets: string[],
  targetWallet: string,
): Promise<{ address: string; name: string } | null> {
  let preview: string | undefined;
  try {
    preview = shortAddress(store.getAddress(targetWallet));
  } catch {
    /* address unreadable — render row without preview */
  }

  for (const line of menuHeader('Wallet', 'Continue, switch, or add a key')) console.log(line);
  console.log(menuRow('1', `Continue as ${targetWallet}`, preview));
  console.log(menuRow('2', 'Switch to another wallet'));
  console.log(menuRow('3', 'Import a keypair'));
  console.log(menuRow('4', 'Create a new wallet'));
  console.log(menuFoot());
  console.log('');

  while (true) {
    const choice = (await deps.ask(PROMPT)).trim();
    switch (choice) {
      case '':
      case '1': {
        try {
          const walletPath = store.getWalletPath(targetWallet);
          const info = tryConnectWallet(deps.walletManager, walletPath);
          if (info && deps.walletManager.isConnected) {
            console.log(`\n  ${c.long('✔')} ${c.primary('Connected')}  ${c.muted(`as ${targetWallet}`)}`);
            updateLastWallet(targetWallet);
            return { ...info, name: targetWallet };
          }
        } catch {
          console.log(`  ${c.muted(`Wallet "${targetWallet}" could not be loaded.`)}`);
        }
        return showWalletPicker(deps, store, wallets);
      }
      case '2':
        return showWalletPicker(deps, store, wallets);
      case '3': {
        const importedName = await handleWalletImportFlow(deps, store);
        if (importedName) return { address: deps.walletManager.address!, name: importedName };
        continue;
      }
      case '4': {
        const created = await handleWalletCreateFlow(deps, store);
        if (created) return created;
        continue;
      }
      default:
        console.log(`  ${c.muted('enter 1, 2, 3, or 4')}`);
        continue;
    }
  }
}

// ─── Wallet picker ────────────────────────────────────────────────────────────

export async function showWalletPicker(
  deps: WalletFlowDeps,
  store: WalletStore,
  wallets: string[],
): Promise<{ address: string; name: string } | null> {
  const defaultWallet = store.getDefault();
  const subtitle = `${wallets.length} saved ${wallets.length === 1 ? 'wallet' : 'wallets'}`;

  for (const line of menuHeader('Select wallet', subtitle)) console.log(line);
  for (let i = 0; i < wallets.length; i++) {
    let preview: string | undefined;
    try {
      preview = shortAddress(store.getAddress(wallets[i]));
    } catch {
      /* address unreadable */
    }
    const meta = wallets[i] === defaultWallet
      ? `${preview ?? ''}${preview ? '   ' : ''}${c.yellow('★ default')}`
      : preview;
    console.log(menuRow(String(i + 1), wallets[i], meta));
  }
  console.log(menuFoot());
  console.log(menuRow('i', 'Import a keypair'));
  console.log(menuRow('c', 'Create a new wallet'));
  console.log(menuRow('q', 'Exit'));
  console.log(menuFoot());
  console.log('');

  while (true) {
    const choice = (await deps.ask(PROMPT)).trim().toLowerCase();
    if (choice === 'q') return null;
    if (choice === 'i') {
      const importedName = await handleWalletImportFlow(deps, store);
      if (importedName) return { address: deps.walletManager.address!, name: importedName };
      continue;
    }
    if (choice === 'c') {
      const created = await handleWalletCreateFlow(deps, store);
      if (created) return created;
      continue;
    }
    const idx = parseInt(choice, 10) - 1;
    if (idx >= 0 && idx < wallets.length) {
      try {
        const walletPath = store.getWalletPath(wallets[idx]);
        const info = tryConnectWallet(deps.walletManager, walletPath);
        if (info) {
          store.setDefault(wallets[idx]);
          updateLastWallet(wallets[idx]);
          console.log(`\n  ${c.long('✔')} ${c.primary('Connected')}  ${c.muted(`as ${wallets[idx]}`)}`);
          return { ...info, name: wallets[idx] };
        }
      } catch (error: unknown) {
        console.log(`  ${c.short('✖')} ${c.muted(getErrorMessage(error))}`);
      }
    } else {
      console.log(`  ${c.muted(`enter 1–${wallets.length}, i, c, or q`)}`);
    }
  }
}

// ─── First-time wallet setup ──────────────────────────────────────────────────

export async function showFirstTimeWalletSetup(
  deps: WalletFlowDeps,
  store: WalletStore,
): Promise<{ address: string; name: string } | null> {
  // First-run hint: surface the env file location so npm-installed users
  // know exactly where their persistent settings live before they import
  // a wallet. Cheap stat — runs once per cold-start.
  try {
    const { userEnvFilePath } = await import('../config/index.js');
    const { existsSync } = await import('fs');
    const envPath = userEnvFilePath();
    if (!existsSync(envPath)) {
      console.log('');
      console.log(`  ${c.muted('First time? Run')} ${c.teal.bold('magic init')} ${c.muted('to create')} ${c.cyan(envPath)}`);
      console.log(`  ${c.muted('then edit it to set your preferred RPC + caps. (You can also do this after.)')}`);
    }
  } catch { /* best-effort hint; never block setup */ }

  for (const line of menuHeader('Welcome', 'A wallet is required to trade')) console.log(line);
  console.log(menuRow('1', 'Create a new wallet'));
  console.log(menuRow('2', 'Import a wallet file'));
  console.log(menuRow('3', 'Connect an existing keypair'));
  console.log(menuFoot());
  console.log('');

  while (true) {
    const choice = (await deps.ask(PROMPT)).trim();
    switch (choice) {
      case '1': {
        const created = await handleWalletCreateFlow(deps, store);
        if (created) return created;
        continue;
      }
      case '2': {
        const importedName = await handleWalletImportFlow(deps, store);
        if (importedName) return { address: deps.walletManager.address!, name: importedName };
        continue;
      }
      case '3': {
        const connected = await handleWalletConnectFlow(deps);
        if (connected) return { address: deps.walletManager.address!, name: 'wallet' };
        continue;
      }
      default:
        console.log(`  ${c.muted('enter 1, 2, or 3')}`);
        continue;
    }
  }
}

// ─── Create flow ──────────────────────────────────────────────────────────────

export async function handleWalletCreateFlow(
  deps: WalletFlowDeps,
  store: WalletStore,
): Promise<{ address: string; name: string } | null> {
  console.log('');
  const name = (await deps.ask(`  ${chalk.yellow('Wallet name:')} `)).trim();
  if (!name) {
    console.log(chalk.red('  Wallet name cannot be empty.'));
    return null;
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    console.log(chalk.red('  Name must be 1-64 alphanumeric/hyphen/underscore characters.'));
    return null;
  }

  const defaultPath = join(homedir(), '.config', 'solana', `${name}.json`);
  console.log('');
  console.log(chalk.dim(`  Where should the keypair be saved?`));
  console.log(chalk.dim(`  Default: ${defaultPath}`));
  const rawSavePath = (await deps.ask(`  ${chalk.yellow('Save path:')} `)).trim();
  const savePath = rawSavePath || defaultPath;
  const expandedPath = savePath.startsWith('~') ? join(homedir(), savePath.slice(1)) : resolve(savePath);

  // Pre-validate: never write a freshly-generated keypair outside the home
  // directory. Without this check a user could type `/tmp/leak.json` and
  // we'd write the secret to a world-accessible directory before the
  // post-write `store.registerWallet()` would reject the path.
  const { isPathInsideHome } = await import('../wallet/wallet-store.js');
  const inside = isPathInsideHome(expandedPath);
  if (!inside.ok) {
    console.log(chalk.red(`  ${inside.reason}`));
    console.log(chalk.dim(`  Suggested: ${defaultPath}`));
    return null;
  }

  try {
    const { Keypair } = await import('@solana/web3.js');
    const { writeFileSync, mkdirSync } = await import('fs');
    const { dirname } = await import('path');

    const dir = dirname(expandedPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

    if (existsSync(expandedPath)) {
      console.log(chalk.red(`  File already exists: ${expandedPath}`));
      return null;
    }

    const keypair = Keypair.generate();
    const secretKeyArray = Array.from(keypair.secretKey);
    const address = keypair.publicKey.toBase58();

    writeFileSync(expandedPath, JSON.stringify(secretKeyArray), { mode: 0o600 });
    secretKeyArray.fill(0);

    const result = store.registerWallet(name, expandedPath);
    store.setDefault(name);
    deps.walletManager.loadFromFile(result.path);
    updateLastWallet(name);

    console.log('');
    console.log(chalk.green(`  Wallet "${name}" created successfully`));
    console.log('');
    console.log(`  ${chalk.bold('Name:')}    ${name}`);
    console.log(`  ${chalk.bold('Address:')} ${chalk.cyan(address)}`);
    console.log(`  ${chalk.bold('Saved to:')} ${chalk.dim(expandedPath)}`);
    console.log('');
    console.log(chalk.yellow.bold('  Security'));
    console.log(chalk.dim('    Back up this file securely'));
    console.log(chalk.dim('    Loss of this file means permanent loss of funds'));
    console.log(chalk.dim('    Flash Terminal does not store a copy of this key'));
    console.log('');
    console.log(chalk.dim('  Fund this wallet with SOL (for fees) and USDC (for collateral).'));
    console.log('');

    return { address, name };
  } catch (error: unknown) {
    console.log(chalk.red(`  Create failed: ${getErrorMessage(error)}`));
    return null;
  }
}

// ─── Import flow ──────────────────────────────────────────────────────────────

export async function handleWalletImportFlow(deps: WalletFlowDeps, store: WalletStore): Promise<string | null> {
  console.log('');
  const name = (await deps.ask(`  ${chalk.yellow('Wallet name:')} `)).trim();
  if (!name) {
    console.log(chalk.red('  Wallet name cannot be empty.'));
    return null;
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    console.log(chalk.red('  Name must be 1-64 alphanumeric/hyphen/underscore characters.'));
    return null;
  }

  console.log('');
  console.log(chalk.dim('  Enter path to your Solana wallet JSON file'));
  console.log(chalk.dim('  Example: ~/.config/solana/id.json'));
  const rawPath = (await deps.ask(`  ${chalk.yellow('Path:')} `)).trim();
  if (!rawPath) {
    console.log(chalk.red('  No path provided.'));
    return null;
  }

  try {
    const result = store.registerWallet(name, rawPath);
    store.setDefault(name);
    deps.walletManager.loadFromFile(result.path);

    console.log('');
    console.log(chalk.green(`  Wallet "${name}" imported successfully`));
    console.log('');
    console.log(`  ${chalk.bold('Name:')}    ${name}`);
    console.log(`  ${chalk.bold('Path:')}    ${chalk.dim(result.path)}`);
    console.log(`  ${chalk.bold('Address:')} ${chalk.cyan(result.address)}`);
    console.log('');
    console.log(chalk.dim('  No key material stored by Flash Terminal.'));
    console.log(chalk.dim('  Your private key remains only in its original file.'));
    console.log('');
    return name;
  } catch (error: unknown) {
    console.log(chalk.red(`  Import failed: ${getErrorMessage(error)}`));
    return null;
  }
}

// ─── Connect (one-shot) ───────────────────────────────────────────────────────

export async function handleWalletConnectFlow(deps: WalletFlowDeps): Promise<boolean> {
  console.log('');
  console.log(chalk.dim('  Enter path to your Solana wallet JSON file'));
  console.log(chalk.dim('  Example: ~/.config/solana/id.json'));
  const rawPath = (await deps.ask(`  ${chalk.yellow('Path:')} `)).trim();
  if (!rawPath) {
    console.log(chalk.red('  No path provided.'));
    return false;
  }

  const expandedPath = rawPath.startsWith('~') ? join(homedir(), rawPath.slice(1)) : resolve(rawPath);
  if (!existsSync(expandedPath)) {
    console.log(chalk.red(`  File not found: ${expandedPath}`));
    return false;
  }

  const info = tryConnectWallet(deps.walletManager, expandedPath);
  if (!info) return false;

  console.log(chalk.green(`  Connected: ${info.address}`));
  try {
    const bal = await deps.walletManager.getBalance();
    console.log(`  Balance: ${chalk.green(bal.toFixed(4))} SOL`);
  } catch {
    /* best-effort */
  }
  console.log('');
  return true;
}
