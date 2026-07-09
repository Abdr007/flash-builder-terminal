/**
 * Wallet manager. Loads a Solana keypair from disk (Solana CLI JSON format)
 * and exposes a signing-capable surface for the SDK.
 *
 * Critical: `Keypair.fromSecretKey` does NOT copy the input bytes — it holds
 * a reference. We never copy the secret key elsewhere; signing happens
 * directly with the loaded keypair. On disconnect we zero the in-place buffer.
 *
 * Token balance fetching is identical to bolt-terminal's WalletManager, with
 * a 30s LRU cache and on-chain Token Metadata fallback for unknown mints.
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { safeEnvNumber } from '../utils/safe-env.js';

const RPC_RETRY_OPTS = { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 3000 };

export class WalletManager {
  private connection: Connection;
  private keypair: Keypair | null = null;
  // The RAW secret buffer we passed to `Keypair.fromSecretKey`. That call
  // retains this exact array by reference as the keypair's internal secret, so
  // zeroing THIS scrubs the live key. `keypair.secretKey` cannot be used for
  // scrubbing — its getter returns a fresh COPY, so `.fill(0)` on it is a no-op.
  private rawSecret: Uint8Array | null = null;
  private publicKey: PublicKey | null = null;
  private tokenBalancesCache: {
    data: { sol: number; tokens: Array<{ symbol: string; mint: string; amount: number }> };
    expiry: number;
  } | null = null;
  private static readonly TOKEN_CACHE_TTL = 30_000;

  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  // Auto-disconnect after this many ms of inactivity (security guard for
  // unattended terminals). Default 4 hours — long enough for active trading
  // sessions, short enough to limit blast radius if a laptop is left open.
  // Set `SESSION_TIMEOUT_MS=0` to disable entirely.
  private static readonly SESSION_TIMEOUT_MS = safeEnvNumber('SESSION_TIMEOUT_MS', 4 * 60 * 60 * 1_000);

  private _disconnecting = false;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  setConnection(connection: Connection): void {
    this.connection = connection;
    this.tokenBalancesCache = null;
  }

  clearBalanceCache(): void {
    this.tokenBalancesCache = null;
  }

  resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.keypair) return;
    // SESSION_TIMEOUT_MS=0 disables idle auto-disconnect entirely.
    if (WalletManager.SESSION_TIMEOUT_MS <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.keypair) {
        getLogger().warn('WALLET', 'Session timed out due to inactivity — wallet disconnected for security');
        this.disconnect();
      }
    }, WalletManager.SESSION_TIMEOUT_MS);
    this.idleTimer.unref();
  }

  get isConnected(): boolean {
    return this.keypair !== null;
  }

  get hasAddress(): boolean {
    return this.publicKey !== null;
  }

  get isReadOnly(): boolean {
    return this.publicKey !== null && this.keypair === null;
  }

  get address(): string | null {
    return this.publicKey?.toBase58() ?? null;
  }

  getKeypair(): Keypair | null {
    if (this._disconnecting) return null;
    return this.keypair;
  }

  isDisconnecting(): boolean {
    return this._disconnecting;
  }

  /**
   * Disconnect: zero the secret key bytes in place, then drop references.
   * We zero `rawSecret` — the buffer `Keypair.fromSecretKey` holds by reference
   * — NOT `keypair.secretKey`, whose getter returns a throwaway copy (zeroing
   * that leaves the real key untouched in the heap).
   */
  disconnect(): void {
    this._disconnecting = true;
    try {
      if (this.rawSecret) this.rawSecret.fill(0);
    } catch {
      /* best-effort */
    }
    this.rawSecret = null;
    this.keypair = null;
    this.publicKey = null;
    this._disconnecting = false;
    this.tokenBalancesCache = null;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * Load a Solana CLI-format keypair JSON from disk.
   * Throws on path traversal, oversized files, malformed JSON, or invalid bytes.
   * Does NOT copy the secret key — `Keypair.fromSecretKey` retains the buffer reference.
   */
  loadFromFile(path: string): { address: string; keypair: Keypair } {
    const logger = getLogger();

    const resolvedPath = resolve(path);
    const home = homedir();
    const homePrefix = home.endsWith('/') ? home : home + '/';
    if (resolvedPath !== home && !resolvedPath.startsWith(homePrefix)) {
      throw new Error(`Wallet path must be within home directory (${home}). Got: ${resolvedPath}`);
    }

    let realPath: string;
    try {
      realPath = realpathSync(resolvedPath);
    } catch {
      throw new Error(`Wallet file not found: ${resolvedPath}`);
    }
    if (realPath !== home && !realPath.startsWith(homePrefix)) {
      throw new Error(`Wallet path resolves outside home directory (symlink?). Real path: ${realPath}`);
    }

    // Open ONCE, fstat the same FD, then read from it. Closes the TOCTOU
    // window where an attacker could swap the file between two `statSync`s
    // and the read. Single fd, single inode, atomic w.r.t. concurrent
    // renames on the path.
    let fd: number;
    try {
      fd = openSync(realPath, 'r');
    } catch {
      throw new Error(`Wallet file not readable: ${realPath}`);
    }
    let raw: string;
    try {
      const fst = fstatSync(fd);
      // A real keypair JSON (`[1, 2, …, 64]`) is ~129 bytes. Cap at 384.
      if (fst.size > 384) {
        throw new Error(`Wallet file too large (${fst.size} bytes). Expected a 64-byte keypair JSON (~129 bytes).`);
      }
      // 0600 perm check (user-only) on POSIX. Same FD, no race.
      if (process.platform !== 'win32') {
        const mode = fst.mode & 0o777;
        if (mode & 0o077) {
          throw new Error(
            `Wallet file ${realPath} is too permissive (mode ${mode.toString(8)}). ` +
            `Run \`chmod 600 ${realPath}\` and try again.`,
          );
        }
      }
      const buf = Buffer.alloc(fst.size);
      const bytesRead = readSync(fd, buf, 0, fst.size, 0);
      raw = buf.subarray(0, bytesRead).toString('utf-8');
    } finally {
      try { closeSync(fd); } catch { /* best-effort */ }
    }

    let secretKey: number[];
    try {
      secretKey = JSON.parse(raw);
    } catch {
      throw new Error('Invalid wallet file format (expected JSON byte array).');
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
    secretKey.fill(0); // Zero the parsed JS array; `keyBytes` is the only reference now.

    // Zero the PRIOR wallet's secret bytes before we drop the reference.
    // Without this, a `wallet use bob` after `wallet use alice` leaves alice's
    // private key sitting in heap memory until GC — visible in core dumps,
    // swap, or a debugger attach. We zero the RETAINED raw buffer, not
    // `keypair.secretKey` (a copy — zeroing it does nothing).
    if (this.rawSecret) {
      try { this.rawSecret.fill(0); } catch { /* ignore */ }
    }

    // CRITICAL: `Keypair.fromSecretKey` does NOT copy — it retains `keyBytes`
    // by reference as the keypair's internal secret. We keep our own handle to
    // that same buffer (`rawSecret`) so disconnect / the next switch can zero
    // the live key material. Do NOT zero `keyBytes` right after this call.
    this.rawSecret = keyBytes;
    this.keypair = Keypair.fromSecretKey(keyBytes);
    this.publicKey = this.keypair.publicKey;

    const address = this.publicKey.toBase58();
    logger.debug('Wallet', `Loaded wallet: ${address}`);

    this.resetIdleTimer();
    return { address, keypair: this.keypair };
  }

  /**
   * True if the loaded keypair still holds non-zero key material (i.e. hasn't
   * been zeroed by a concurrent disconnect or memory corruption).
   */
  verifyKeypairIntegrity(): boolean {
    if (!this.keypair) return false;
    try {
      const sk = this.keypair.secretKey;
      // Solana ed25519 secret keys are 64 bytes total: bytes 0-31 are the
      // seed and bytes 32-63 are the public key. A partial wipe of the
      // upper half (e.g. SDK doing in-place key derivation gone wrong)
      // would still nominally sign but produce garbage. Inspect ALL 64
      // bytes — a healthy keypair has non-zero in BOTH halves.
      if (sk.length !== 64) return false;
      let nonZeroSeed = 0;
      let nonZeroPub = 0;
      for (let i = 0; i < 32; i++) if (sk[i] !== 0) nonZeroSeed++;
      for (let i = 32; i < 64; i++) if (sk[i] !== 0) nonZeroPub++;
      return nonZeroSeed > 0 && nonZeroPub > 0;
    } catch {
      return false;
    }
  }

  /** Non-throwing wrapper. */
  tryDetect(path: string): { address: string; keypair: Keypair } | null {
    try {
      return this.loadFromFile(path);
    } catch {
      return null;
    }
  }

  /** Read-only connect by address (no signing). */
  connectAddress(address: string): { address: string } {
    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(address);
    } catch {
      throw new Error(`Invalid Solana address: ${address}`);
    }
    if (!PublicKey.isOnCurve(pubkey.toBytes())) {
      throw new Error(`Address is not a valid wallet (off-curve): ${address}`);
    }
    this.publicKey = pubkey;
    // Switching to a read-only address must scrub any previously-loaded signing
    // key from the heap, not just drop the reference.
    if (this.rawSecret) {
      try { this.rawSecret.fill(0); } catch { /* ignore */ }
      this.rawSecret = null;
    }
    this.keypair = null;
    getLogger().debug('Wallet', `Connected address (read-only): ${pubkey.toBase58()}`);
    return { address: pubkey.toBase58() };
  }

  async getBalance(): Promise<number> {
    if (!this.publicKey) throw new Error('No wallet connected');
    const lamports = await withRetry(
      () => this.connection.getBalance(this.publicKey!),
      'wallet-balance',
      RPC_RETRY_OPTS,
    );
    return lamports / LAMPORTS_PER_SOL;
  }

  async getTokenBalances(): Promise<{ sol: number; tokens: Array<{ symbol: string; mint: string; amount: number }> }> {
    if (!this.publicKey) throw new Error('No wallet connected');

    const now = Date.now();
    if (this.tokenBalancesCache && this.tokenBalancesCache.expiry > now) {
      return this.tokenBalancesCache.data;
    }

    const KNOWN_MINTS: Record<string, string> = {
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
      Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
      So11111111111111111111111111111111111111112: 'WSOL',
      JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 'JUP',
      HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: 'PYTH',
      jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: 'JTO',
      '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': 'RAY',
      DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'BONK',
      EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: 'WIF',
      mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: 'mSOL',
      J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: 'JitoSOL',
      bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: 'bSOL',
      '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'ETH',
      '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 'WBTC',
      PENGUdRFKyGbMx6s3KcAMR7G4k26hAciRmvMKsKKBuv: 'PENGU',
      orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE: 'ORCA',
      rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof: 'RNDR',
      '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g': 'HYPE',
      '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4': 'JLP',
    };

    const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

    const [solBalance, tokenAccounts, token2022Accounts] = await withRetry(
      () =>
        Promise.all([
          this.connection.getBalance(this.publicKey!),
          this.connection.getParsedTokenAccountsByOwner(this.publicKey!, { programId: TOKEN_PROGRAM_ID }),
          this.connection.getParsedTokenAccountsByOwner(this.publicKey!, { programId: TOKEN_2022_PROGRAM_ID }),
        ]),
      'wallet-token-balances',
      RPC_RETRY_OPTS,
    );

    const tokens: Array<{ symbol: string; mint: string; amount: number }> = [];
    const allAccounts = [...tokenAccounts.value, ...token2022Accounts.value];

    for (const account of allAccounts) {
      const info = account.account.data.parsed?.info;
      if (!info) continue;
      const mint: string = info.mint;
      const uiAmount: number = info.tokenAmount?.uiAmount ?? 0;
      if (uiAmount === 0) continue;

      let symbol = KNOWN_MINTS[mint];

      if (!symbol) {
        try {
          const mintPk = new PublicKey(mint);
          const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
          const [metadataPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), mintPk.toBuffer()],
            METADATA_PROGRAM,
          );
          const meta = await this.connection.getAccountInfo(metadataPDA);
          if (meta && meta.data.length > 65) {
            const nameLen = meta.data.readUInt32LE(65);
            const symOffset = 69 + nameLen;
            if (symOffset + 4 < meta.data.length) {
              const symLen = meta.data.readUInt32LE(symOffset);
              if (symLen > 0 && symLen <= 10) {
                const rawSym = meta.data.subarray(symOffset + 4, symOffset + 4 + symLen).toString('utf8').replace(/\0/g, '').trim();
                if (rawSym.length > 0 && rawSym.length <= 8 && /^[A-Za-z0-9]+$/.test(rawSym)) {
                  symbol = rawSym.toUpperCase();
                }
              }
            }
          }
        } catch {
          /* best-effort metadata lookup */
        }
      }

      if (!symbol) symbol = 'UNKNOWN';
      tokens.push({ symbol, mint, amount: uiAmount });
    }

    const result = { sol: solBalance / LAMPORTS_PER_SOL, tokens };
    this.tokenBalancesCache = { data: result, expiry: Date.now() + WalletManager.TOKEN_CACHE_TTL };
    return result;
  }

  async getUsdcBalance(): Promise<number> {
    const balances = await this.getTokenBalances();
    const usdc = balances.tokens.find((t) => t.symbol === 'USDC');
    return usdc?.amount ?? 0;
  }
}
