/**
 * Signing Guard — central transaction-signing security module.
 *
 * Enforces:
 * - Configurable max trade limits (collateral, position size, leverage)
 * - Signing rate limits (per-minute cap + min-delay between trades)
 * - Audit log on disk (never logs private keys, raw txs, or signatures)
 *
 * Every trade path MUST pass through `checkTradeLimits` + `checkRateLimit`
 * before signing, and `logAudit` after the result is known.
 */

import { appendFileSync, mkdirSync, existsSync, writeFileSync, statSync, renameSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { getErrorMessage } from '../utils/retry.js';
import { redactCommonSecrets } from './redact-secrets.js';

export interface SigningGuardConfig {
  /** Maximum collateral per single trade (USD). 0 = unlimited. */
  maxCollateralPerTrade: number;
  /** Maximum position size per single trade (USD). 0 = unlimited. */
  maxPositionSize: number;
  /** Maximum leverage allowed. 0 = use market defaults only. */
  maxLeverage: number;
  /** Maximum number of signing operations per minute. 0 = unlimited. */
  maxTradesPerMinute: number;
  /** Minimum delay between consecutive signings (ms). 0 = no delay. */
  minDelayBetweenTradesMs: number;
  /** Path to signing audit log file. */
  auditLogPath: string;
}

export const DEFAULT_SIGNING_GUARD_CONFIG: SigningGuardConfig = {
  maxCollateralPerTrade: 0,
  maxPositionSize: 0,
  maxLeverage: 0,
  maxTradesPerMinute: 10,
  minDelayBetweenTradesMs: 1000,
  auditLogPath: join(homedir(), '.magic', 'signing-audit.log'),
};

export interface TradeLimitCheck {
  allowed: boolean;
  reason?: string;
}

export interface SigningAuditEntry {
  timestamp: string;
  type:
    | 'open'
    | 'close'
    | 'partial_close'
    | 'increase'
    | 'add_collateral'
    | 'remove_collateral'
    | 'reverse'
    | 'limit_order'
    | 'cancel_order'
    | 'liquidate'
    | 'deposit'
    | 'withdraw'
    | 'settle'
    | 'init_udl'
    | 'init_basket'
    | 'delegate_basket'
    | 'other';
  market?: string;
  side?: string;
  collateral?: number;
  leverage?: number;
  sizeUsd?: number;
  walletAddress: string;
  // 'submitted' = accepted for propagation but not yet confirmed on-chain
  // (the honest state before a terminal status is known); 'confirmed' only after
  // an on-chain check with no error; 'failed' = reverted on-chain.
  result: 'confirmed' | 'submitted' | 'rejected' | 'failed' | 'rate_limited';
  reason?: string;
  txSignature?: string;
  latencyMs?: number;
  // Tamper-evidence (present ONLY when SIGNING_AUDIT_TAMPER_EVIDENT=1). These
  // form an append-only hash chain: `hash = sha256(prevHash + canonical(entry
  // without hash))`, so deleting, editing, or reordering any line breaks the
  // chain from that point on and `verifyAuditChain` reports the first bad line.
  seq?: number;
  prevHash?: string;
  hash?: string;
}

/** Genesis anchor for the tamper-evident hash chain (fixed constant). */
const AUDIT_CHAIN_GENESIS = 'flash-magic-audit-genesis-v1';

/** Deterministic serialization: sorted keys so write-time and verify-time
 *  hashing agree regardless of property insertion order. Entry values are flat
 *  primitives (strings/numbers), so a shallow sort is sufficient. */
function stableStringify(obj: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

function chainHash(prevHash: string, entryWithoutHash: Record<string, unknown>): string {
  return createHash('sha256').update(prevHash + stableStringify(entryWithoutHash)).digest('hex');
}

/**
 * Verify a tamper-evident signing-audit log. Reads the file, walks the hash
 * chain from genesis, and returns the 1-based line number of the FIRST entry
 * whose `seq`, `prevHash`, or recomputed `hash` doesn't match — i.e. where the
 * log was edited, truncated, or reordered. `{ ok: true }` means intact.
 *
 * Assumes every line is a chained entry (the log was written with tamper-
 * evidence on from the start). Best-effort: unreadable file → ok:false.
 */
export function verifyAuditChain(path: string): { ok: boolean; brokenAtLine?: number; reason?: string } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return { ok: false, reason: `cannot read log: ${getErrorMessage(err)}` };
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  let prev = AUDIT_CHAIN_GENESIS;
  let expectedSeq = 0;
  for (let i = 0; i < lines.length; i++) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      return { ok: false, brokenAtLine: i + 1, reason: 'not valid JSON' };
    }
    const { hash, ...rest } = entry;
    if (typeof hash !== 'string' || typeof rest.prevHash !== 'string' || typeof rest.seq !== 'number') {
      return { ok: false, brokenAtLine: i + 1, reason: 'missing chain fields (seq/prevHash/hash)' };
    }
    if (rest.seq !== expectedSeq) return { ok: false, brokenAtLine: i + 1, reason: `seq mismatch (want ${expectedSeq}, got ${rest.seq})` };
    if (rest.prevHash !== prev) return { ok: false, brokenAtLine: i + 1, reason: 'prevHash does not chain to prior line' };
    if (chainHash(prev, rest) !== hash) return { ok: false, brokenAtLine: i + 1, reason: 'hash mismatch (line was edited)' };
    prev = hash;
    expectedSeq++;
  }
  return { ok: true };
}

const MAX_AUDIT_LOG_BYTES = 10 * 1024 * 1024;
const MAX_SIGNING_HISTORY = 100;

/**
 * Strip credentials from any string in an audit entry. Builds on the
 * shared `redactCommonSecrets` pass and adds audit-log-specific
 * patterns (path-embedded tokens) that we DON'T strip from regular
 * file logs (where Solscan-style URLs need to survive).
 */
function scrubString(s: string): string {
  let out = redactCommonSecrets(s);
  // Path-embedded tokens (QuickNode/Triton style — 16+ urlsafe chars).
  // The audit log carries no useful long URL paths, so this is safe
  // to apply unconditionally.
  out = out.replace(/(https?:\/\/[^/\s"']+\/)([A-Za-z0-9_-]{16,})(?=[/\s"']|$)/gi,
    (_m, host: string) => `${host}***`);
  return out;
}
function scrubAuditEntry(entry: SigningAuditEntry): SigningAuditEntry {
  return {
    ...entry,
    reason: entry.reason ? scrubString(entry.reason) : entry.reason,
    // Tx signature is base58 — pass through (signatures are public anyway).
  };
}

export class SigningGuard {
  private config: SigningGuardConfig;
  private signingTimestamps: number[] = [];
  private lastSigningTime = 0;

  // Tamper-evident hash chain (opt-in via SIGNING_AUDIT_TAMPER_EVIDENT=1).
  private readonly tamperEvident: boolean =
    process.env.SIGNING_AUDIT_TAMPER_EVIDENT === '1' || process.env.SIGNING_AUDIT_TAMPER_EVIDENT === 'true';
  private lastAuditHash = AUDIT_CHAIN_GENESIS;
  private auditSeq = 0;

  constructor(config?: Partial<SigningGuardConfig>) {
    this.config = { ...DEFAULT_SIGNING_GUARD_CONFIG, ...config };
    this.initAuditLog();
    if (this.tamperEvident) this.resumeAuditChain();
  }

  /**
   * Resume the hash chain across process restarts: read the CURRENT log's last
   * chained line and continue from its hash + seq. Without this, every restart
   * would reset to genesis and verifyAuditChain would flag a false break at the
   * restart boundary. Best-effort — a missing/empty/unchained log starts fresh.
   */
  private resumeAuditChain(): void {
    try {
      if (!existsSync(this.config.auditLogPath)) return;
      const raw = readFileSync(this.config.auditLogPath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      const last = lines[lines.length - 1];
      if (!last) return;
      const entry = JSON.parse(last) as { hash?: unknown; seq?: unknown };
      if (typeof entry.hash === 'string' && typeof entry.seq === 'number') {
        this.lastAuditHash = entry.hash;
        this.auditSeq = entry.seq + 1;
      }
    } catch {
      /* best-effort: fall back to genesis */
    }
  }

  /**
   * True when ANY per-trade risk cap is active (collateral / position-size /
   * leverage > 0). The sign boundary uses this to fail CLOSED: a size- or
   * leverage-growing builder that can't be resolved into concrete
   * `TradeLimitParams` is refused while caps are configured, rather than
   * silently signing past a cap the operator set.
   */
  capsConfigured(): boolean {
    return (
      this.config.maxCollateralPerTrade > 0 ||
      this.config.maxPositionSize > 0 ||
      this.config.maxLeverage > 0
    );
  }

  /** Returns `{ allowed: true }` if the trade fits within configured limits. */
  checkTradeLimits(params: { collateral: number; leverage: number; sizeUsd: number; market: string }): TradeLimitCheck {
    const { collateral, leverage, sizeUsd } = params;

    // Defense-in-depth: NaN comparisons return false, so without this gate a
    // NaN size/collateral/leverage would silently pass every `> max` check.
    // Reject before the per-field checks see undefined math.
    if (!Number.isFinite(collateral) || !Number.isFinite(leverage) || !Number.isFinite(sizeUsd)) {
      return { allowed: false, reason: 'invalid trade parameters (non-finite collateral / leverage / size)' };
    }
    if (collateral < 0 || leverage < 0 || sizeUsd < 0) {
      return { allowed: false, reason: 'invalid trade parameters (negative collateral / leverage / size)' };
    }

    if (this.config.maxCollateralPerTrade > 0 && collateral > this.config.maxCollateralPerTrade) {
      return {
        allowed: false,
        reason:
          `Collateral $${collateral.toFixed(2)} exceeds maximum $${this.config.maxCollateralPerTrade.toFixed(2)}. ` +
          `Adjust MAX_COLLATERAL_PER_TRADE in .env to change.`,
      };
    }

    if (this.config.maxPositionSize > 0 && sizeUsd > this.config.maxPositionSize) {
      return {
        allowed: false,
        reason:
          `Position size $${sizeUsd.toFixed(2)} exceeds maximum $${this.config.maxPositionSize.toFixed(2)}. ` +
          `Adjust MAX_POSITION_SIZE in .env to change.`,
      };
    }

    if (this.config.maxLeverage > 0 && leverage > this.config.maxLeverage) {
      return {
        allowed: false,
        reason:
          `Leverage ${leverage}x exceeds maximum ${this.config.maxLeverage}x. ` +
          `Adjust MAX_LEVERAGE in .env to change.`,
      };
    }

    return { allowed: true };
  }

  /**
   * Reserve a slot in the rate-limit window atomically. Closes the TOCTOU gap
   * during the long ER confirmation window so concurrent trades can't bypass.
   *
   * Uses `performance.now()` — a monotonic clock that's immune to system-time
   * jumps (NTP corrections, manual clock changes). With Date.now(), a
   * backward time jump could trick `elapsed > minDelay` into firing early,
   * effectively bypassing the rate limit.
   */
  checkRateLimit(): TradeLimitCheck {
    const now = performance.now();

    if (this.config.minDelayBetweenTradesMs > 0 && this.lastSigningTime > 0) {
      const elapsed = now - this.lastSigningTime;
      if (elapsed < this.config.minDelayBetweenTradesMs) {
        const wait = ((this.config.minDelayBetweenTradesMs - elapsed) / 1000).toFixed(1);
        return {
          allowed: false,
          reason:
            `Rate limited: minimum ${(this.config.minDelayBetweenTradesMs / 1000).toFixed(1)}s between trades. ` +
            `Wait ${wait}s.`,
        };
      }
    }

    if (this.config.maxTradesPerMinute > 0) {
      const oneMinuteAgo = now - 60_000;
      this.signingTimestamps = this.signingTimestamps.filter((t) => t > oneMinuteAgo);
      if (this.signingTimestamps.length >= this.config.maxTradesPerMinute) {
        return {
          allowed: false,
          reason: `Rate limited: max ${this.config.maxTradesPerMinute} trades/minute reached.`,
        };
      }
    }

    this.lastSigningTime = now;
    this.signingTimestamps.push(now);
    if (this.signingTimestamps.length > MAX_SIGNING_HISTORY) {
      this.signingTimestamps = this.signingTimestamps.slice(-MAX_SIGNING_HISTORY);
    }
    return { allowed: true };
  }

  /**
   * Sleep until `checkRateLimit()` would pass. Used by composite operations
   * (e.g. `reverse` = close + open) that legitimately submit multiple trades
   * back-to-back and shouldn't fail just because the user kicked it off
   * within the inter-trade cooldown window.
   *
   * Caps the wait at the configured `minDelayBetweenTradesMs` so this can
   * never block longer than a normal cooldown.
   */
  async waitForRateLimit(): Promise<void> {
    if (this.config.minDelayBetweenTradesMs <= 0) return;
    if (this.lastSigningTime === 0) return;
    const elapsed = performance.now() - this.lastSigningTime;
    const waitMs = this.config.minDelayBetweenTradesMs - elapsed;
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, Math.min(waitMs, this.config.minDelayBetweenTradesMs)));
    }
  }

  /**
   * Update timestamps after a successful trade send. NOTE: `checkRateLimit`
   * already pushes a timestamp and updates `lastSigningTime` when it reserves
   * the slot — we do NOT push another one here, otherwise every trade would
   * count as two and effectively halve the configured `maxTradesPerMinute`.
   * Window is unified to 60s (matches `checkRateLimit`'s filter window).
   */
  recordSigning(): void {
    const now = performance.now();
    this.lastSigningTime = now;
    const oneMinuteAgo = now - 60_000;
    this.signingTimestamps = this.signingTimestamps.filter((t) => t > oneMinuteAgo);
    if (this.signingTimestamps.length > MAX_SIGNING_HISTORY) {
      this.signingTimestamps = this.signingTimestamps.slice(-MAX_SIGNING_HISTORY);
    }
  }

  /** Has the user been warned that the audit log is failing? */
  private auditWriteFailed = false;

  /**
   * Append an audit-log line. Never logs key material, sigs, or raw txs.
   * The fs append is dispatched off the hot path via `setImmediate` so the
   * trade RPC isn't waiting on disk before returning the user their card.
   *
   * If the audit log can't be written (permissions, full disk, …), surface
   * a one-time stderr warning so the user can investigate. After that, fail
   * silently — we don't want to spam every trade. The trade itself is NOT
   * blocked: blocking trading on log-failure would be a worse outcome than
   * silently losing audit history.
   */
  logAudit(entry: SigningAuditEntry): void {
    // Scrub credentials from the entry before serializing. The `reason`
    // field routinely contains raw SDK / RPC error messages which embed
    // RPC URLs (with `?api-key=...` queries or path-tokens), telegram bot
    // tokens, and other secrets. Without this, every audit log entry from
    // a failed RPC call leaks the operator's api key to disk.
    const scrubbed = scrubAuditEntry(entry);
    // Tamper-evidence: compute the chain fields SYNCHRONOUSLY (in call order) so
    // consecutive logAudit calls chain deterministically regardless of when their
    // async writes fire. Never let this throw onto the money path — on any error
    // fall back to the plain (unchained) entry. Default-off: zero change unless
    // SIGNING_AUDIT_TAMPER_EVIDENT is set.
    let record: Record<string, unknown> = scrubbed as unknown as Record<string, unknown>;
    if (this.tamperEvident) {
      try {
        const base = { ...scrubbed, seq: this.auditSeq, prevHash: this.lastAuditHash } as unknown as Record<string, unknown>;
        const hash = chainHash(this.lastAuditHash, base);
        this.lastAuditHash = hash;
        this.auditSeq += 1;
        record = { ...base, hash };
      } catch {
        /* chain best-effort; write the plain entry rather than lose the record */
      }
    }
    const line = JSON.stringify(record) + '\n';
    setImmediate(() => {
      try {
        if (existsSync(this.config.auditLogPath)) {
          const size = statSync(this.config.auditLogPath).size;
          if (size > MAX_AUDIT_LOG_BYTES) {
            for (let i = 9; i >= 1; i--) {
              const from = i === 1 ? this.config.auditLogPath + '.old' : this.config.auditLogPath + `.old.${i}`;
              const to = this.config.auditLogPath + `.old.${i + 1}`;
              try { renameSync(from, to); } catch { /* ignore */ }
            }
            renameSync(this.config.auditLogPath, this.config.auditLogPath + '.old');
            writeFileSync(this.config.auditLogPath, '', { mode: 0o600 });
          }
        }
        // mode arg is honoured only when fs creates the file; on
        // append-to-existing it's a no-op. We pass it for the case
        // where rotation just wrote the new file but the umask has
        // since loosened (fresh shells, sudo'd parents, etc.) — belt
        // and suspenders so audit history is never world-readable.
        appendFileSync(this.config.auditLogPath, line, { mode: 0o600 });
        this.auditWriteFailed = false;
      } catch (err) {
        if (!this.auditWriteFailed) {
          this.auditWriteFailed = true;
          process.stderr.write(
            `signing-audit log write failed (${getErrorMessage(err)}). ` +
            `subsequent audit failures will be silent. check ${this.config.auditLogPath}\n`,
          );
        }
      }
    });
  }

  private initAuditLog(): void {
    try {
      const dir = dirname(this.config.auditLogPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!existsSync(this.config.auditLogPath)) writeFileSync(this.config.auditLogPath, '', { mode: 0o600 });
    } catch {
      /* best-effort */
    }
  }

  get limits(): {
    maxCollateralPerTrade: number;
    maxPositionSize: number;
    maxLeverage: number;
    maxTradesPerMinute: number;
  } {
    return {
      maxCollateralPerTrade: this.config.maxCollateralPerTrade,
      maxPositionSize: this.config.maxPositionSize,
      maxLeverage: this.config.maxLeverage,
      maxTradesPerMinute: this.config.maxTradesPerMinute,
    };
  }
}

let _guard: SigningGuard | null = null;

export function initSigningGuard(config?: Partial<SigningGuardConfig>): SigningGuard {
  if (_guard) {
    if (config) _guard = new SigningGuard(config);
    return _guard;
  }
  _guard = new SigningGuard(config);
  return _guard;
}

export function getSigningGuard(): SigningGuard {
  if (!_guard) _guard = new SigningGuard();
  return _guard;
}
