/**
 * Flash V2 REST price fallback.
 *
 * Pyth Hermes is the monitor's primary oracle, but it doesn't carry feeds for
 * every market Flash lists — newer / exotic tokens (FARTCOIN, PUMP, MEGA,
 * CHIP, GRAM, BP, ORE, …) have no Hermes feed at all. Flash's own
 * `GET /prices` endpoint is the authoritative, complete source: it returns a
 * live `priceUi` + `marketSession` for EVERY configured market, keyed by the
 * short symbol the monitor already uses.
 *
 * This service is a thin, cached wrapper used strictly as a FALLBACK — when
 * Pyth has a symbol we prefer Pyth (it also gives us 24h change + a richer
 * schedule). When Pyth is missing a symbol, this guarantees the row still
 * shows real data instead of an em-dash.
 */

const DEFAULT_URL = 'https://flashapi.trade';
// The monitor ticks at 1 Hz; a 1.5 s cache means at most one Flash round-trip
// per couple of ticks while still tracking the market in near real time.
const TTL_MS = 1_500;

export interface FlashPrice {
  price: number;
  session: 'regular' | 'pre' | 'post' | 'open' | 'break' | 'closed' | 'unknown';
}

interface FlashPriceRaw {
  priceUi?: number;
  price?: number;
  exponent?: number;
  marketSession?: string;
}

function normSession(s: string | undefined): FlashPrice['session'] {
  switch ((s ?? '').toLowerCase()) {
    case 'regular':
    case 'pre':
    case 'post':
    case 'open':
    case 'break':
    case 'closed':
      return s!.toLowerCase() as FlashPrice['session'];
    default:
      return 'unknown';
  }
}

export class FlashPriceService {
  private readonly baseUrl: string;
  private cache: Map<string, FlashPrice> = new Map();
  private fetchedAt = -1; // timestamp of the last SUCCESSFUL fetch (-1 = never)
  private inFlight: Promise<Map<string, FlashPrice>> | null = null;
  // Failure backoff: on a persistent outage don't hammer the endpoint every
  // tick. `fetchedAt` only advances on success, so `ageMs()` keeps growing and
  // callers can tell the cache has gone stale.
  private backoffUntil = 0;
  private failCount = 0;

  constructor(baseUrl?: string) {
    // Match config resolution: explicit arg → env → default.
    this.baseUrl = (baseUrl ?? process.env.MAGIC_FLASH_API_URL ?? DEFAULT_URL).replace(/\/+$/, '');
  }

  /** Milliseconds since the last SUCCESSFUL fetch — Infinity if never fetched. */
  ageMs(): number {
    return this.fetchedAt < 0 ? Number.POSITIVE_INFINITY : Date.now() - this.fetchedAt;
  }

  private noteFailure(): void {
    this.failCount = Math.min(this.failCount + 1, 6);
    // 2s, 4s, 8s … capped at 30s.
    this.backoffUntil = Date.now() + Math.min(1000 * 2 ** this.failCount, 30_000);
  }

  /**
   * Returns the full symbol → price map, keyed by UPPERCASE symbol so callers
   * can look up case-insensitively (config uses `JitoSOL`, the API uses
   * `JitoSOL`, the monitor uppercases). Cached for {@link TTL_MS}; concurrent
   * callers share a single in-flight request. Never throws — on any failure it
   * returns the last good cache (possibly empty).
   */
  async getPrices(): Promise<Map<string, FlashPrice>> {
    const now = Date.now();
    if (now - this.fetchedAt < TTL_MS && this.cache.size > 0) return this.cache;
    if (now < this.backoffUntil) return this.cache; // in failure backoff — serve stale cache
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/prices`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(3_000),
        });
        if (!res.ok) { this.noteFailure(); return this.cache; }
        const payload = (await res.json()) as Record<string, FlashPriceRaw>;
        const next = new Map<string, FlashPrice>();
        for (const [sym, v] of Object.entries(payload)) {
          if (!v || typeof v !== 'object') continue;
          let px = typeof v.priceUi === 'number' ? v.priceUi : NaN;
          // Fall back to raw price × 10^exponent if priceUi is absent.
          if (!Number.isFinite(px) && typeof v.price === 'number' && typeof v.exponent === 'number') {
            px = v.price * Math.pow(10, v.exponent);
          }
          if (!Number.isFinite(px) || px <= 0) continue;
          next.set(sym.toUpperCase(), { price: px, session: normSession(v.marketSession) });
        }
        if (next.size > 0) {
          this.cache = next;
          this.fetchedAt = Date.now();
          this.failCount = 0;
          this.backoffUntil = 0;
        } else {
          this.noteFailure();
        }
        return this.cache;
      } catch {
        this.noteFailure();
        return this.cache;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /** Synchronous read of the last cached price for a symbol (case-insensitive). */
  peek(symbol: string): FlashPrice | undefined {
    return this.cache.get(symbol.toUpperCase());
  }
}

let _svc: FlashPriceService | null = null;
export function getFlashPriceService(): FlashPriceService {
  if (!_svc) _svc = new FlashPriceService();
  return _svc;
}
