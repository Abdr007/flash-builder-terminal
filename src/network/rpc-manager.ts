/**
 * Minimal RPC manager for the magic terminal.
 *
 * Manages a list of L1 RPC endpoints (primary + backups) with one active
 * selection at a time. Lighter than bolt-terminal's full failover/health
 * monitor — we don't need that for v2's L1 read path. What we DO need:
 *   - swap the active endpoint at runtime
 *   - measure per-endpoint latency
 *   - notify subscribers on switch (so WalletManager + cached clients rebuild)
 *
 * Persistence (writing to ~/.magic/config.json) lives in the rpc-tools
 * dispatcher, not here — this class is purely in-memory state.
 */

import { Connection } from '@solana/web3.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';
import { validateRpcUrl } from '../config/index.js';

export interface RpcEndpoint {
  url: string;
  label: string;
}

export type ConnectionChangeCallback = (conn: Connection, ep: RpcEndpoint) => void;

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Automatic-failover thresholds. Tunable from outside via `setHealthOptions`,
 * but the defaults are chosen to be conservative — never fail over on a
 * single hiccup, never fail over more than once per cooldown.
 */
export interface HealthOptions {
  /** Probe interval, ms. */
  intervalMs: number;
  /** Latency above this counts as a "slow" probe (ms). */
  slowLatencyMs: number;
  /** Slot lag (vs. best-known peer) above this counts as a "lagging" probe. */
  slowSlotLag: number;
  /** Consecutive bad probes required to trigger failover. */
  badProbeThreshold: number;
  /** Minimum gap between two failover events (ms). Prevents flapping. */
  failoverCooldownMs: number;
  /** Max parallel probe latency for backups; -1 disables. */
  probeTimeoutMs: number;
}

const DEFAULT_HEALTH_OPTIONS: HealthOptions = {
  intervalMs: 30_000,
  slowLatencyMs: 2_000,
  slowSlotLag: 50,
  badProbeThreshold: 3,
  failoverCooldownMs: 60_000,
  probeTimeoutMs: 4_000,
};

function labelFromUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.includes('helius')) return 'Helius';
    if (u.hostname.includes('quicknode')) return 'QuickNode';
    if (u.hostname.includes('triton')) return 'Triton';
    if (u.hostname.includes('alchemy')) return 'Alchemy';
    if (u.hostname.includes('mainnet-beta.solana.com')) return 'Solana Mainnet (public)';
    if (u.hostname.includes('devnet.solana.com')) return 'Solana Devnet (public)';
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return 'Local';
    return u.hostname;
  } catch {
    return url;
  }
}

export class RpcManager {
  private endpoints: RpcEndpoint[];
  private activeIdx = 0;
  private _conn: Connection;
  private latencyByUrl = new Map<string, number>();
  private slotByUrl = new Map<string, number>();
  private consecutiveBadProbes = 0;
  private healthTimer: NodeJS.Timeout | null = null;
  private healthOptions: HealthOptions = DEFAULT_HEALTH_OPTIONS;
  private lastFailoverAt = 0;
  private failoverHandler: ((from: RpcEndpoint, to: RpcEndpoint, reason: string) => void) | null = null;
  private onChange: ConnectionChangeCallback | null = null;

  constructor(initialUrls: string[]) {
    if (initialUrls.length === 0) throw new Error('RpcManager requires at least one URL');
    this.endpoints = initialUrls.map((u) => ({ url: u, label: labelFromUrl(u) }));
    this._conn = new Connection(initialUrls[0], 'confirmed');
  }

  get connection(): Connection { return this._conn; }
  get activeEndpoint(): RpcEndpoint { return this.endpoints[this.activeIdx]; }
  get totalEndpoints(): number { return this.endpoints.length; }

  getEndpoints(): readonly RpcEndpoint[] { return this.endpoints; }
  getEndpointLatency(url: string): number { return this.latencyByUrl.get(url) ?? -1; }
  /** Last-observed slot for an endpoint (-1 if never probed). */
  getEndpointSlot(url: string): number { return this.slotByUrl.get(url) ?? -1; }
  /** How far behind the best-known peer this endpoint is. 0 if unknown / equal. */
  getSlotLag(url: string): number {
    const own = this.slotByUrl.get(url);
    if (own === undefined) return 0;
    let best = own;
    for (const s of this.slotByUrl.values()) if (s > best) best = s;
    return Math.max(0, best - own);
  }

  setConnectionChangeCallback(cb: ConnectionChangeCallback): void { this.onChange = cb; }

  /**
   * Add a new endpoint. Returns false if URL already present.
   * Validates that the URL is https-only and free of embedded creds —
   * defense-in-depth against config writes that bypass the
   * `loadConfig` boot-time check (e.g., a dynamic `rpc add` from the
   * REPL while the user is connected via untrusted remote shell).
   */
  addEndpoint(url: string, label?: string): boolean {
    const safe = validateRpcUrl(url, 'rpc-manager.addEndpoint');
    if (this.endpoints.some((ep) => ep.url === safe)) return false;
    this.endpoints.push({ url: safe, label: label ?? labelFromUrl(safe) });
    return true;
  }

  /** Remove an endpoint. Cannot remove the active one. Returns false if not found / active. */
  removeEndpoint(url: string): boolean {
    const idx = this.endpoints.findIndex((ep) => ep.url === url);
    if (idx < 0 || idx === this.activeIdx) return false;
    this.endpoints.splice(idx, 1);
    this.latencyByUrl.delete(url);
    // Also drop the slot map entry — otherwise getSlotLag() would compute
    // lag against a phantom endpoint's last-known slot, skewing telemetry
    // and potentially triggering spurious failovers.
    this.slotByUrl.delete(url);
    if (this.activeIdx > idx) this.activeIdx--;
    return true;
  }

  /**
   * Switch the active endpoint. Returns false if not found / already
   * active. Validates the URL even though it's already in our list
   * — avoids any path where a stored endpoint with downgraded scheme
   * (http://) could become live via this method.
   */
  switchTo(url: string): boolean {
    const safe = validateRpcUrl(url, 'rpc-manager.switchTo');
    const idx = this.endpoints.findIndex((ep) => ep.url === safe);
    if (idx < 0 || idx === this.activeIdx) return false;
    this.activeIdx = idx;
    this._conn = new Connection(this.endpoints[idx].url, 'confirmed');
    this.onChange?.(this._conn, this.endpoints[idx]);
    return true;
  }

  /** Measure latency of one URL via getSlot. Returns ms or -1 on failure. */
  async measureOne(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<number> {
    const conn = new Connection(url, 'confirmed');
    const t0 = Date.now();
    try {
      await Promise.race([
        conn.getSlot(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]);
      const ms = Date.now() - t0;
      this.latencyByUrl.set(url, ms);
      return ms;
    } catch {
      this.latencyByUrl.set(url, -1);
      return -1;
    }
  }

  /** Measure latency of every endpoint in parallel. */
  async measureAll(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Array<{ url: string; label: string; ms: number }>> {
    return Promise.all(
      this.endpoints.map(async (ep) => ({
        url: ep.url,
        label: ep.label,
        ms: await this.measureOne(ep.url, timeoutMs),
      })),
    );
  }

  // ─── Auto failover ─────────────────────────────────────────────

  /** Override the default health-monitor thresholds. */
  setHealthOptions(opts: Partial<HealthOptions>): void {
    this.healthOptions = { ...this.healthOptions, ...opts };
  }

  /** Subscribe to failover events (one callback total). */
  setFailoverHandler(cb: (from: RpcEndpoint, to: RpcEndpoint, reason: string) => void): void {
    this.failoverHandler = cb;
  }

  /**
   * Start the background health monitor. Idempotent — calling twice is a
   * no-op. Disabled when only one endpoint is configured (nothing to fail
   * over to). The probe runs an active getSlot on every endpoint each tick,
   * tracks slot-lag vs. the best-known peer, and switches the active endpoint
   * when the current one accumulates `badProbeThreshold` bad probes in a row.
   */
  startHealthMonitor(): void {
    if (this.healthTimer || this.endpoints.length < 2) return;
    const tick = () => {
      this.runHealthProbe().catch((err) => {
        getLogger().debug('rpc-health', `probe failed: ${getErrorMessage(err)}`);
      });
    };
    // Wait one interval before the first tick so we don't compete with startup.
    this.healthTimer = setInterval(tick, this.healthOptions.intervalMs);
    this.healthTimer.unref?.();
  }

  /** Stop the background health monitor. */
  stopHealthMonitor(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /** One probe round: latency + slot per endpoint, decide whether to fail over. */
  private async runHealthProbe(): Promise<void> {
    const opts = this.healthOptions;
    const probes = await Promise.all(
      this.endpoints.map(async (ep) => {
        const conn = ep.url === this.activeEndpoint.url ? this._conn : new Connection(ep.url, 'confirmed');
        const t0 = Date.now();
        try {
          const slot = await Promise.race([
            conn.getSlot('confirmed'),
            new Promise<number>((_, rej) => setTimeout(() => rej(new Error('timeout')), opts.probeTimeoutMs)),
          ]);
          const ms = Date.now() - t0;
          this.latencyByUrl.set(ep.url, ms);
          this.slotByUrl.set(ep.url, slot);
          return { ep, ms, slot, ok: true };
        } catch {
          this.latencyByUrl.set(ep.url, -1);
          return { ep, ms: -1, slot: -1, ok: false };
        }
      }),
    );

    const okProbes = probes.filter((p) => p.ok);
    // If nothing came back, there's no candidate to fail over to anyway —
    // skip the round entirely. (Without this, the consecutiveBadProbes
    // counter would still climb on a flapping network and surface a
    // failover decision later when we recover.)
    if (okProbes.length === 0) return;
    const bestSlot = Math.max(...okProbes.map((p) => p.slot));
    const active = probes.find((p) => p.ep.url === this.activeEndpoint.url);
    if (!active) return;

    // Only meaningful to compute lag when the active probe came back.
    const slotLag = active.ok ? Math.max(0, bestSlot - active.slot) : 0;
    const isBad = !active.ok
      || (active.ms > 0 && active.ms > opts.slowLatencyMs)
      || slotLag > opts.slowSlotLag;

    if (!isBad) {
      this.consecutiveBadProbes = 0;
      return;
    }
    this.consecutiveBadProbes++;
    if (this.consecutiveBadProbes < opts.badProbeThreshold) return;

    const now = Date.now();
    if (now - this.lastFailoverAt < opts.failoverCooldownMs) return;

    // Pick the healthiest alternate: must be ok, must not be the active one,
    // prefer lowest latency, then highest slot.
    const candidate = probes
      .filter((p) => p.ok && p.ep.url !== active.ep.url)
      .sort((a, b) => (a.ms - b.ms) || (b.slot - a.slot))[0];
    if (!candidate) return;

    const reason = !active.ok
      ? 'active endpoint unreachable'
      : slotLag > opts.slowSlotLag
        ? `slot lag ${slotLag} > ${opts.slowSlotLag}`
        : `latency ${active.ms}ms > ${opts.slowLatencyMs}ms`;

    const from = active.ep;
    if (this.switchTo(candidate.ep.url)) {
      this.consecutiveBadProbes = 0;
      this.lastFailoverAt = now;
      getLogger().warn('rpc-health', `failover: ${from.label} → ${candidate.ep.label} (${reason})`);
      this.failoverHandler?.(from, candidate.ep, reason);
    }
  }
}

let _instance: RpcManager | null = null;
export function setRpcManager(m: RpcManager | null): void { _instance = m; }
export function getRpcManager(): RpcManager | null { return _instance; }

/**
 * Mask credentials in RPC URLs for display. Covers the three common
 * provider patterns:
 *   - Helius / Alchemy:   `?api-key=<token>`           → query param masked
 *   - QuickNode:          `host.quiknode.pro/<token>/`  → path token masked
 *   - Triton:             `<token>.solana-mainnet.rpcpool.com/<token>`
 *                         → both subdomain and path-token masked
 *   - Embedded creds:     `https://user:pass@host`     → userinfo masked
 *
 * Conservative: any opaque path segment 16+ chars long that's all
 * `[A-Za-z0-9_-]` gets collapsed. False positives (e.g. a v1 path
 * literally named "abcdefghijklmno0") are rare; false negatives (token
 * leaking) are catastrophic.
 */
export function maskRpcUrl(url: string): string {
  let out = url;
  // 1. Embedded userinfo (username:password@).
  out = out.replace(/(https?:\/\/)([^/@\s]+)@/i, (_m, scheme: string) => `${scheme}***@`);
  // 2. Query-param secrets.
  out = out.replace(/([?&])(api[-_]?key|key|token|secret|auth)=([^&]+)/gi,
    (_m, p: string, q: string) => `${p}${q}=${'*'.repeat(8)}`);
  // 3. Path-embedded tokens — any segment of 16+ urlsafe chars that doesn't
  //    look like a normal path part (no dots, no equals).
  try {
    const u = new URL(out);
    if (u.pathname && u.pathname !== '/') {
      const segments = u.pathname.split('/');
      const masked = segments.map((seg) => {
        if (seg.length >= 16 && /^[A-Za-z0-9_-]+$/.test(seg)) {
          return '***';
        }
        return seg;
      });
      u.pathname = masked.join('/');
      out = u.toString();
    }
  } catch { /* not a parseable URL — leave string-mode result */ }
  return out;
}
