/**
 * 24h per-market volume from fstats.io.
 *
 * Endpoint: GET https://fstats.io/api/v1/volume/by-market?days=N
 *   → { data: [{ market_symbol: "BTC-LONG", side: "long", volume_usd, trades, ... }, ...] }
 *
 * fstats keys volume by `<SYMBOL>-<SIDE>` so we sum LONG+SHORT to get the
 * per-market total. Cached for 60s — endpoint is rate-limited and the
 * monitor refreshes every 5s.
 *
 * The local volume-indexer (in-process Anchor event subscriber) remains as a
 * warm-start fallback for the first ~minute of a session; thereafter the
 * fstats numbers are the source of truth (Flash's own indexer).
 */

import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';

const FSTATS_BASE = 'https://fstats.io/api/v1';
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 6_000;
const MAX_RESPONSE_BYTES = 1_000_000;

interface FstatsByMarketEntry {
  market_symbol?: string;
  side?: string;
  volume_usd?: number;
  trades?: number;
}

interface FstatsByMarketResponse {
  data?: FstatsByMarketEntry[];
}

interface VolumeCacheEntry {
  /** Map: SYMBOL → { volumeUsd, trades }. SYMBOL is the bare market symbol (BTC, SOL, …). */
  volumes: Map<string, { volumeUsd: number; trades: number }>;
  fetchedAt: number;
}

/**
 * Service singleton — one global cache shared by the monitor + any other
 * consumer. Independent of the SDK / wallet (it's a public REST endpoint).
 */
class FstatsVolumeService {
  private cache: VolumeCacheEntry | null = null;
  private inflight: Promise<VolumeCacheEntry> | null = null;
  private failureCount = 0;
  private static readonly MAX_FAILURES = 3;
  private static readonly FAILURE_BACKOFF_MS = 5 * 60 * 1_000;
  private nextRetryAt = 0;

  /**
   * Returns 24h volume per symbol. Hits the network at most once per
   * `CACHE_TTL_MS`; concurrent callers share a single in-flight request.
   * On error: falls back to last-known cache, or empty map.
   */
  async getVolumes(): Promise<Map<string, { volumeUsd: number; trades: number }>> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.volumes;
    }
    if (this.failureCount >= FstatsVolumeService.MAX_FAILURES && now < this.nextRetryAt) {
      // Circuit open — return stale cache or empty map until cooldown elapses.
      return this.cache?.volumes ?? new Map();
    }
    if (this.inflight) {
      const result = await this.inflight;
      return result.volumes;
    }
    this.inflight = this.fetchFresh().finally(() => { this.inflight = null; });
    try {
      const fresh = await this.inflight;
      this.cache = fresh;
      this.failureCount = 0;
      return fresh.volumes;
    } catch (err) {
      this.failureCount++;
      if (this.failureCount >= FstatsVolumeService.MAX_FAILURES) {
        this.nextRetryAt = Date.now() + FstatsVolumeService.FAILURE_BACKOFF_MS;
      }
      getLogger().debug('fstats-volume', `fetch failed: ${getErrorMessage(err)}`);
      return this.cache?.volumes ?? new Map();
    }
  }

  private async fetchFresh(): Promise<VolumeCacheEntry> {
    const url = `${FSTATS_BASE}/volume/by-market?days=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`fstats ${res.status}`);
      const contentLength = res.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
        throw new Error('fstats response too large');
      }
      // Stream-read with a hard byte cap so a server that lies about (or
      // omits) Content-Length cannot make us OOM. Aborts via the same
      // controller as the timeout — closes the socket as soon as we hit cap.
      const reader = res.body?.getReader();
      if (!reader) throw new Error('fstats response has no body');
      const decoder = new TextDecoder();
      let received = 0;
      let text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          received += value.byteLength;
          if (received > MAX_RESPONSE_BYTES) {
            controller.abort();
            throw new Error('fstats response exceeded cap');
          }
          text += decoder.decode(value, { stream: true });
        }
      }
      text += decoder.decode();
      const json = JSON.parse(text) as FstatsByMarketResponse;
      return { volumes: aggregate(json.data ?? []), fetchedAt: Date.now() };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Sum LONG+SHORT entries by stripping `-LONG`/`-SHORT` from market_symbol. */
function aggregate(entries: FstatsByMarketEntry[]): Map<string, { volumeUsd: number; trades: number }> {
  const out = new Map<string, { volumeUsd: number; trades: number }>();
  for (const e of entries) {
    const sym = (e.market_symbol ?? '').toUpperCase();
    if (!sym) continue;
    // Strip side suffix: "BTC-LONG" → "BTC", "SOL-SHORT" → "SOL".
    const bare = sym.replace(/-(LONG|SHORT)$/, '');
    const v = Number(e.volume_usd);
    const t = Number(e.trades);
    if (!Number.isFinite(v) || v < 0) continue;
    const cur = out.get(bare) ?? { volumeUsd: 0, trades: 0 };
    cur.volumeUsd += v;
    cur.trades += Number.isFinite(t) ? t : 0;
    out.set(bare, cur);
  }
  return out;
}

let _instance: FstatsVolumeService | null = null;
export function getFstatsVolumeService(): FstatsVolumeService {
  if (!_instance) _instance = new FstatsVolumeService();
  return _instance;
}
