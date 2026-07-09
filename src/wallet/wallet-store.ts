import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  realpathSync,
  statSync,
  lstatSync,
  readdirSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Keypair } from '@solana/web3.js';
import { safeJsonParse } from '../utils/safe-json.js';

const FLASH_DIR = join(homedir(), '.flash');
const REGISTRY_FILE = join(FLASH_DIR, 'wallets.json');

// Legacy paths — used only for migration detection
const LEGACY_WALLETS_DIR = join(FLASH_DIR, 'wallets');
const LEGACY_CONFIG_FILE = join(FLASH_DIR, 'config.json');

interface WalletEntry {
  name: string;
  path: string;
  address: string;
}

interface WalletRegistry {
  wallets: WalletEntry[];
  defaultWallet?: string;
}

/**
 * Resolve a user-supplied path (~ expansion, normalisation) and check whether
 * it would land inside the user's home directory. Does NOT require the file
 * to exist — callable BEFORE writing a new wallet to validate the target.
 *
 * Symlink escapes can only be detected once the file exists; callers that
 * also want symlink-safety should call `validateWalletPath` after the file
 * is created. This helper is the pre-write gate.
 */
export function isPathInsideHome(filePath: string): { ok: boolean; resolved: string; reason?: string } {
  const home = homedir();
  const homePrefix = home.endsWith('/') ? home : home + '/';
  const resolved = filePath.startsWith('~') ? join(home, filePath.slice(1)) : join(filePath);
  if (resolved !== home && !resolved.startsWith(homePrefix)) {
    return { ok: false, resolved, reason: `Path must be inside your home directory (${home}).` };
  }
  return { ok: true, resolved };
}

/** Ensure ~/.flash/ exists with safe permissions. */
function ensureDir(): void {
  if (!existsSync(FLASH_DIR)) {
    mkdirSync(FLASH_DIR, { mode: 0o700 });
  } else {
    chmodSync(FLASH_DIR, 0o700);
  }
}

function loadRegistry(): WalletRegistry {
  try {
    const raw = readFileSync(REGISTRY_FILE, 'utf-8');
    const parsed = safeJsonParse<unknown>(raw, null, 'wallets.json');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.wallets)) {
        return parsed as WalletRegistry;
      }
    }
    return { wallets: [] };
  } catch {
    return { wallets: [] };
  }
}

function saveRegistry(registry: WalletRegistry): void {
  ensureDir();
  writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 });
}

/** Sanitize wallet name: alphanumeric, hyphens, underscores only. */
function sanitizeName(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clean || clean.length > 64) {
    throw new Error('Wallet name must be 1-64 alphanumeric/hyphen/underscore characters');
  }
  return clean;
}

export class WalletStore {
  constructor() {
    this.migrateFromLegacyStore();
  }

  /**
   * Validate a wallet file path for security.
   * Checks: exists, inside home dir, not a symlink escape, <1KB, permissions.
   * Returns the resolved real path.
   */
  validateWalletPath(filePath: string): string {
    const home = homedir();
    const homePrefix = home.endsWith('/') ? home : home + '/';

    // Resolve the path
    const resolved = filePath.startsWith('~') ? join(home, filePath.slice(1)) : join(filePath); // normalize

    // Must be inside home directory
    if (resolved !== home && !resolved.startsWith(homePrefix)) {
      throw new Error(`Wallet path must be within home directory (${home}).`);
    }

    // File must exist
    if (!existsSync(resolved)) {
      throw new Error(`Wallet file not found: ${resolved}`);
    }

    // Check for symlink escape
    const realPath = realpathSync(resolved);
    if (realPath !== home && !realPath.startsWith(homePrefix)) {
      throw new Error('Wallet path resolves outside home directory (symlink?).');
    }

    // File size check — match walletManager.loadFromFile (384 bytes is plenty
    // for a 64-byte keypair JSON encoded as a numeric array, even with
    // whitespace and a trailing newline).
    const stats = statSync(realPath);
    if (stats.size > 384) {
      throw new Error(`File too large (${stats.size} bytes). Expected a keypair JSON (~129 bytes).`);
    }

    // Symlink check (lstat to detect symlinks)
    const lstats = lstatSync(resolved);
    if (lstats.isSymbolicLink()) {
      // Allowed only if realpath is still inside home (checked above)
      // but warn about it
    }

    // Permission check — warn if not 600 or stricter
    const mode = stats.mode & 0o777;
    if (mode & 0o077) {
      // File is readable by group or others — security warning
      const octal = mode.toString(8);
      throw new Error(`Wallet file has insecure permissions (${octal}). ` + `Run: chmod 600 "${realPath}" to fix.`);
    }

    return realPath;
  }

  /**
   * Register a wallet by file path. No key material is stored.
   * Validates the file, derives the address, stores only {name, path, address}.
   */
  registerWallet(name: string, filePath: string): { address: string; path: string } {
    const safeName = sanitizeName(name);
    const realPath = this.validateWalletPath(filePath);

    // Check for duplicate name
    const registry = loadRegistry();
    if (registry.wallets.some((w) => w.name === safeName)) {
      throw new Error(`Wallet "${safeName}" already exists. Use a different name or remove it first.`);
    }

    // Read and validate the keypair to derive the address
    const raw = readFileSync(realPath, 'utf-8');
    let secretKey: number[];
    try {
      secretKey = JSON.parse(raw);
    } catch {
      throw new Error('Invalid wallet file format. Expected a JSON array of 64 bytes.');
    }

    if (!Array.isArray(secretKey) || secretKey.length !== 64) {
      throw new Error(
        `Invalid keypair: expected 64-byte array, got ${Array.isArray(secretKey) ? secretKey.length : typeof secretKey}`,
      );
    }

    for (let i = 0; i < secretKey.length; i++) {
      const v = secretKey[i];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {
        throw new Error(`Invalid keypair: byte at index ${i} is not a valid uint8 value`);
      }
    }

    const keyBytes = Uint8Array.from(secretKey);
    secretKey.fill(0); // Zero the parsed array

    const keypair = Keypair.fromSecretKey(keyBytes);
    const address = keypair.publicKey.toBase58();

    // Zero the keypair's secret key — we only needed the address
    try {
      keypair.secretKey.fill(0);
    } catch {
      /* best-effort */
    }

    // Store metadata only
    registry.wallets.push({ name: safeName, path: realPath, address });
    saveRegistry(registry);

    return { address, path: realPath };
  }

  /** List all registered wallet names. */
  listWallets(): string[] {
    const registry = loadRegistry();
    return registry.wallets.map((w) => w.name).sort();
  }

  /** Get the original file path for a registered wallet. */
  getWalletPath(name: string): string {
    const safeName = sanitizeName(name);
    const registry = loadRegistry();
    // Exact match first, then case-insensitive fallback
    const entry =
      registry.wallets.find((w) => w.name === safeName) ??
      registry.wallets.find((w) => w.name.toLowerCase() === safeName.toLowerCase());
    if (!entry) {
      throw new Error(`Wallet "${safeName}" not found. Use "wallet list" to see registered wallets.`);
    }
    // Verify original file still exists
    if (!existsSync(entry.path)) {
      throw new Error(
        `Wallet file no longer exists at: ${entry.path}\n` + `  Re-register with: wallet import ${safeName} <new-path>`,
      );
    }
    return entry.path;
  }

  /** Check if a wallet name is registered. */
  hasWallet(name: string): boolean {
    try {
      const safeName = sanitizeName(name);
      const registry = loadRegistry();
      return registry.wallets.some((w) => w.name === safeName || w.name.toLowerCase() === safeName.toLowerCase());
    } catch {
      return false;
    }
  }

  /** Get the full wallet entry (name, path, address). */
  getWalletEntry(name: string): WalletEntry {
    const safeName = sanitizeName(name);
    const registry = loadRegistry();
    const entry =
      registry.wallets.find((w) => w.name === safeName) ??
      registry.wallets.find((w) => w.name.toLowerCase() === safeName.toLowerCase());
    if (!entry) {
      throw new Error(`Wallet "${safeName}" not found.`);
    }
    return { ...entry };
  }

  /** Set a wallet as the default (auto-loaded on startup). */
  setDefault(name: string): void {
    const safeName = sanitizeName(name);
    // Verify it exists
    this.getWalletPath(safeName);
    const registry = loadRegistry();
    registry.defaultWallet = safeName;
    saveRegistry(registry);
  }

  /** Clear the default wallet so none auto-loads on startup. */
  clearDefault(): void {
    const registry = loadRegistry();
    delete registry.defaultWallet;
    saveRegistry(registry);
  }

  /** Get the default wallet name. */
  getDefault(): string | null {
    const registry = loadRegistry();
    if (!registry.defaultWallet) return null;
    // Verify it still exists
    try {
      this.getWalletPath(registry.defaultWallet);
      return registry.defaultWallet;
    } catch {
      return null;
    }
  }

  /** Remove a registered wallet. Does NOT delete the original keypair file. */
  removeWallet(name: string): void {
    const safeName = sanitizeName(name);
    const registry = loadRegistry();
    const idx = registry.wallets.findIndex((w) => w.name === safeName);
    if (idx === -1) {
      throw new Error(`Wallet "${safeName}" not found.`);
    }
    registry.wallets.splice(idx, 1);

    // If this was the default, clear it
    if (registry.defaultWallet === safeName) {
      delete registry.defaultWallet;
    }
    saveRegistry(registry);
  }

  /** Get the cached address for a registered wallet (no file read needed). */
  getAddress(name: string): string {
    const entry = this.getWalletEntry(name);
    return entry.address;
  }

  /**
   * One-time migration from legacy ~/.flash/wallets/<name>.json store.
   * Registers legacy wallets pointing to their existing file locations.
   * Does not delete the old files — user must clean up manually.
   */
  private migrateFromLegacyStore(): void {
    // Skip if registry already exists (already migrated)
    if (existsSync(REGISTRY_FILE)) return;

    // Skip if no legacy wallets directory
    if (!existsSync(LEGACY_WALLETS_DIR)) return;

    try {
      const files = readdirSync(LEGACY_WALLETS_DIR).filter((f) => f.endsWith('.json'));
      if (files.length === 0) return;

      const registry: WalletRegistry = { wallets: [] };

      // Load legacy default wallet config
      try {
        const configRaw = readFileSync(LEGACY_CONFIG_FILE, 'utf-8');
        const config = JSON.parse(configRaw);
        if (config.defaultWallet) {
          registry.defaultWallet = config.defaultWallet;
        }
      } catch {
        /* no config */
      }

      for (const file of files) {
        const name = file.replace(/\.json$/, '');
        const filePath = join(LEGACY_WALLETS_DIR, file);

        try {
          // M17: Validate legacy file paths through the same security checks
          try { this.validateWalletPath(filePath); } catch { continue; }
          let raw = readFileSync(filePath, 'utf-8');
          const secretKey = JSON.parse(raw);
          raw = '';

          if (!Array.isArray(secretKey) || secretKey.length !== 64) continue;

          const keyBytes = Uint8Array.from(secretKey);
          secretKey.fill(0);

          const keypair = Keypair.fromSecretKey(keyBytes);
          const address = keypair.publicKey.toBase58();
          try {
            keypair.secretKey.fill(0);
          } catch {
            /* best-effort */
          }

          // Point to the legacy location since we don't know the original path
          registry.wallets.push({ name, path: filePath, address });
        } catch {
          // Skip invalid files
        }
      }

      if (registry.wallets.length > 0) {
        saveRegistry(registry);
        // Suppress under NO_DNA — agent JSON streams expect every stdout
        // line to be a valid record, and a 3-line migration banner ahead
        // of the first JSON record breaks line-buffered parsers.
        if (!process.env.NO_DNA) {
          console.log(
            `  [Migration] Migrated ${registry.wallets.length} wallet(s) to new registry format.\n` +
              `  Legacy wallet files in ~/.flash/wallets/ are no longer needed.\n` +
              `  Consider re-importing wallets with "wallet import" to point to your original keypair files.\n`,
          );
        }
      }
    } catch {
      // Migration is best-effort — don't block startup
    }
  }
}
