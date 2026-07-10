/**
 * Live FLASH6-pool market data from the Flash V2 Builder API.
 *
 * The legacy `magic-trade-client` SDK loads the OLD FTv2 pool (27 custodies /
 * 52 markets, stale/low OI). Mainnet actually trades on the FLASH6 pool
 * (`FLASH6Lo6…`, 62 symbols / 127 markets) served by flashapi.trade. The
 * monitor must reflect the pool you actually trade on, so it sources its market
 * universe and open-interest from here rather than the SDK.
 *
 * Data chain (verified against live mainnet):
 *   /tokens         → symbol → mint
 *   /raw/custodies  → mint   → custody pubkey
 *   /raw/markets    → aggregate collectivePosition.sizeUsd by targetCustody,
 *                     split Long/Short  (sizeUsd is micro-USD → /1e6)
 */

const DEFAULT_URL = 'https://flashapi.trade';
// Static maps (symbol↔mint↔custody) rarely change → refresh every 5 min.
const STATIC_TTL_MS = 5 * 60_000;
// OI changes with trading → refresh every 6s (the /raw/markets payload is large;
// per-second polling would be wasteful and OI doesn't move meaningfully faster).
const OI_TTL_MS = 6_000;
const USD_MICRO = 1_000_000;

export interface MarketOi {
  long: number; // USD
  short: number; // USD
}

export interface TokenMeta {
  mint: string;
  decimals: number;
  isStable: boolean;
}

interface TokenRaw { symbol?: string; name?: string; mint?: string; decimals?: number; isStable?: boolean }
interface CustodyRaw { pubkey?: string; account?: { mint?: string } }
interface MarketRaw {
  account?: {
    targetCustody?: string;
    collateralCustody?: string;
    side?: string;
    collectivePosition?: { sizeUsd?: number | string };
  };
}

function toArr<T>(x: unknown): T[] {
  if (Array.isArray(x)) return x as T[];
  if (x && typeof x === 'object') {
    const v = (x as Record<string, unknown>).data ?? Object.values(x as object)[0];
    if (Array.isArray(v)) return v as T[];
  }
  return [];
}

export class FlashMarketService {
  private readonly baseUrl: string;
  // symbol(UPPER) → custody pubkey  and its inverse
  private custodyBySymbol = new Map<string, string>();
  private symbolByCustody = new Map<string, string>();
  // symbol(UPPER) → token metadata (decimals, isStable, mint)
  private metaBySymbol = new Map<string, TokenMeta>();
  private staticAt = -1;
  private staticInFlight: Promise<void> | null = null;
  // custody pubkey → OI
  private oiByCustody = new Map<string, MarketOi>();
  // custodies that are a market TARGET (i.e. tradeable), from /raw/markets
  private targetCustodies = new Set<string>();
  // custodies used as COLLATERAL (depositable/lock tokens), from /raw/markets
  private collateralCustodies = new Set<string>();
  private oiAt = -1;
  private oiInFlight: Promise<void> | null = null;
  private oiBackoffUntil = 0;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? process.env.MAGIC_FLASH_API_URL ?? DEFAULT_URL).replace(/\/+$/, '');
  }

  /** Milliseconds since the last successful OI fetch (Infinity if never). */
  oiAgeMs(): number {
    return this.oiAt < 0 ? Number.POSITIVE_INFINITY : Date.now() - this.oiAt;
  }

  /** Symbols (UPPERCASE) whose custody is a market TARGET — i.e. tradeable
   *  perp markets (excludes collateral-only stables like USDC). Falls back to
   *  all mapped symbols if /raw/markets hasn't loaded yet. */
  tradeableSymbols(): string[] {
    if (this.targetCustodies.size === 0) return [...this.custodyBySymbol.keys()];
    const out: string[] = [];
    for (const [sym, cust] of this.custodyBySymbol) {
      if (this.targetCustodies.has(cust)) out.push(sym);
    }
    return out;
  }

  /** Live OI for a symbol, or undefined if not loaded. */
  oi(symbol: string): MarketOi | undefined {
    const cust = this.custodyBySymbol.get(symbol.toUpperCase());
    return cust ? this.oiByCustody.get(cust) : undefined;
  }

  /** Token metadata (decimals, isStable, mint) for a symbol. */
  meta(symbol: string): TokenMeta | undefined {
    return this.metaBySymbol.get(symbol.toUpperCase());
  }

  /** Symbols usable as COLLATERAL (the depositable/lock tokens) in the FLASH6
   *  pool. Falls back to all mapped symbols until /raw/markets has loaded. */
  collateralSymbols(): string[] {
    if (this.collateralCustodies.size === 0) return [...this.custodyBySymbol.keys()];
    const out: string[] = [];
    for (const cust of this.collateralCustodies) {
      const sym = this.symbolByCustody.get(cust);
      if (sym) out.push(sym);
    }
    return out;
  }

  /** Load the static symbol→mint→custody maps (cached, deduped, never throws). */
  async ensureStatic(): Promise<void> {
    const now = Date.now();
    if (now - this.staticAt < STATIC_TTL_MS && this.custodyBySymbol.size > 0) return;
    if (this.staticInFlight) return this.staticInFlight;
    this.staticInFlight = (async () => {
      try {
        const [tk, cu] = await Promise.all([
          this.get('/tokens'),
          this.get('/raw/custodies'),
        ]);
        const tokens = toArr<TokenRaw>(tk);
        const custs = toArr<CustodyRaw>(cu);
        const mintBySym = new Map<string, string>();
        const meta = new Map<string, TokenMeta>();
        for (const t of tokens) {
          const sym = (t.symbol ?? t.name)?.toUpperCase();
          if (sym && t.mint) {
            mintBySym.set(sym, t.mint);
            meta.set(sym, { mint: t.mint, decimals: Number(t.decimals ?? 6), isStable: !!t.isStable });
          }
        }
        const custByMint = new Map<string, string>();
        for (const c of custs) {
          const mint = c.account?.mint;
          if (mint && c.pubkey) custByMint.set(mint, c.pubkey);
        }
        const next = new Map<string, string>();
        const inv = new Map<string, string>();
        for (const [sym, mint] of mintBySym) {
          const cust = custByMint.get(mint);
          if (cust) { next.set(sym, cust); inv.set(cust, sym); }
        }
        if (next.size > 0) {
          this.custodyBySymbol = next;
          this.symbolByCustody = inv;
          this.metaBySymbol = meta;
          this.staticAt = Date.now();
        }
      } catch {
        /* keep last maps */
      } finally {
        this.staticInFlight = null;
      }
    })();
    return this.staticInFlight;
  }

  /** Refresh OI from /raw/markets (cached ~6s, failure backoff, never throws). */
  async refreshOi(): Promise<void> {
    const now = Date.now();
    if (now - this.oiAt < OI_TTL_MS && this.oiByCustody.size > 0) return;
    if (now < this.oiBackoffUntil) return;
    if (this.oiInFlight) return this.oiInFlight;
    this.oiInFlight = (async () => {
      try {
        const mk = await this.get('/raw/markets');
        const mkts = toArr<MarketRaw>(mk);
        if (mkts.length === 0) { this.noteOiFailure(); return; }
        const next = new Map<string, MarketOi>();
        const targets = new Set<string>();
        const collateral = new Set<string>();
        for (const m of mkts) {
          const a = m.account;
          if (!a?.targetCustody) continue;
          targets.add(a.targetCustody);
          if (a.collateralCustody) collateral.add(a.collateralCustody);
          const raw = Number(a.collectivePosition?.sizeUsd ?? 0);
          if (!Number.isFinite(raw) || raw <= 0) continue;
          const usd = raw / USD_MICRO;
          const cur = next.get(a.targetCustody) ?? { long: 0, short: 0 };
          if ((a.side ?? '').toLowerCase() === 'short') cur.short += usd;
          else cur.long += usd;
          next.set(a.targetCustody, cur);
        }
        this.oiByCustody = next;
        this.targetCustodies = targets;
        this.collateralCustodies = collateral;
        this.oiAt = Date.now();
        this.oiBackoffUntil = 0;
      } catch {
        this.noteOiFailure();
      } finally {
        this.oiInFlight = null;
      }
    })();
    return this.oiInFlight;
  }

  private noteOiFailure(): void {
    // Short exponential backoff so a persistent outage doesn't hammer the
    // large /raw/markets endpoint every tick.
    this.oiBackoffUntil = Date.now() + 8_000;
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`flash-markets ${path}: ${res.status}`);
    return res.json();
  }
}

let _svc: FlashMarketService | null = null;
export function getFlashMarketService(): FlashMarketService {
  if (!_svc) _svc = new FlashMarketService();
  return _svc;
}
