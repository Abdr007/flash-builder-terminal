/**
 * Pyth-only price + 24h-change service for the v2 monitor.
 *
 * All data comes from Pyth — no CoinGecko, no Flash REST. Two endpoints:
 *   - Hermes:    https://hermes.pyth.network — current prices (batch)
 *   - Benchmark: https://benchmarks.pyth.network — historical OHLC (per-symbol)
 *
 * Custodies on Magic V2 carry a `pythTicker` like "Crypto.SOL/USD" — we map
 * those to Hermes feed IDs once at init, then fetch all current prices in a
 * single HTTP round-trip per refresh.
 *
 * The 24h-ago price is fetched via Pyth Benchmark's TradingView shim and
 * cached for 30 minutes (24h change shifts slowly; refetching every 5s is
 * wasteful and rate-limit-prone).
 */

import { setTimeout as wait } from 'timers/promises';
import { readJsonCapped } from '../utils/fetch-json.js';

const HERMES = 'https://hermes.pyth.network';
const BENCHMARKS = 'https://benchmarks.pyth.network';
const ONE_DAY_S = 86_400;
const HISTORY_TTL_MS = 30 * 60 * 1_000;

export interface PythPrice {
  ticker: string;
  price: number;
  /** 24h change as a percent. NaN until 24h-ago lookup completes. */
  priceChange24h: number;
  /** True if 24h figure is still cold-loading; row will hide change as N/A. */
  pending24h: boolean;
  /** Unix-seconds timestamp from Pyth — used to infer market open/closed. */
  publishTime: number;
  /** Seconds since the last Pyth publish. Crypto: ~0; equities after-hours: hours. */
  staleSeconds: number;
}

interface HermesFeed {
  id: string;
  attributes: {
    symbol?: string;
    base?: string;
    quote_currency?: string;
    asset_type?: string;
    /**
     * Trading schedule per Pyth's published format:
     *   "<IANA-tz>;<7 day-segments>;<holidays>"
     *
     * Day order in the 7 segments is Mon, Tue, Wed, Thu, Fri, Sat, Sun.
     * Each segment is one of:
     *   - "C"            closed all day
     *   - "O"            open 24h
     *   - "HHMM-HHMM"    open in that local-time window
     *   - multiple ranges separated by "&"
     *
     * Holidays are comma-separated "MMDD/<spec>" where spec is "C" or
     * "HHMM-HHMM". See https://docs.pyth.network/price-feeds/core/market-hours.
     */
    schedule?: string;
  };
}

interface DayWindow {
  /** Minutes since local midnight, inclusive. */
  openMin: number;
  /** Minutes since local midnight, exclusive. */
  closeMin: number;
}

interface ParsedSchedule {
  /** IANA timezone identifier (e.g. "America/New_York"). */
  tz: string;
  /** Index 0=Mon, 6=Sun. Each entry is the day's open windows. */
  weekly: DayWindow[][];
  /** "MMDD" → either "closed" or replacement windows for that calendar date. */
  holidays: Map<string, DayWindow[] | 'closed'>;
}

/** Minutes since local midnight from "HHMM" (e.g. "0930" → 570). */
function hhmmToMin(s: string): number {
  if (!/^\d{4}$/.test(s)) return Number.NaN;
  const h = parseInt(s.slice(0, 2), 10);
  const m = parseInt(s.slice(2, 4), 10);
  if (h > 24 || m > 59) return Number.NaN;
  return h * 60 + m;
}

/** Parse one day or holiday spec ("C", "O", "HHMM-HHMM", "0900-1200&1300-1700"). */
function parseDaySpec(spec: string): DayWindow[] | 'closed' {
  const trimmed = spec.trim().toUpperCase();
  if (trimmed === 'C' || trimmed === '') return 'closed';
  if (trimmed === 'O') return [{ openMin: 0, closeMin: 24 * 60 }];
  const out: DayWindow[] = [];
  for (const range of trimmed.split('&')) {
    const m = range.match(/^(\d{4})-(\d{4})$/);
    if (!m) continue;
    const o = hhmmToMin(m[1]);
    const c = hhmmToMin(m[2]);
    if (Number.isNaN(o) || Number.isNaN(c)) continue;
    // 0000-0000 is sometimes used for "open" — normalise to full-day.
    if (o === c) {
      out.push({ openMin: 0, closeMin: 24 * 60 });
    } else if (c < o) {
      // Overnight (e.g. 1800-0200): split into [open..midnight] + [midnight..close]
      out.push({ openMin: o, closeMin: 24 * 60 });
      out.push({ openMin: 0, closeMin: c });
    } else {
      out.push({ openMin: o, closeMin: c });
    }
  }
  return out.length > 0 ? out : 'closed';
}

/** Parse a full schedule string. Returns null if the string is unrecognisable. */
export function parseSchedule(raw: string | undefined): ParsedSchedule | null {
  if (!raw) return null;
  const parts = raw.split(';');
  if (parts.length < 2) return null;
  const tz = parts[0].trim();
  if (!tz) return null;
  const daySpecs = parts[1].split(',');
  if (daySpecs.length < 7) return null;
  const weekly: DayWindow[][] = [];
  for (let i = 0; i < 7; i++) {
    const parsed = parseDaySpec(daySpecs[i]);
    weekly.push(parsed === 'closed' ? [] : parsed);
  }
  const holidays = new Map<string, DayWindow[] | 'closed'>();
  if (parts.length >= 3 && parts[2].trim()) {
    for (const entry of parts[2].split(',')) {
      const [date, spec] = entry.split('/');
      if (!date || !spec) continue;
      const dateKey = date.trim();
      if (!/^\d{4}$/.test(dateKey)) continue;
      holidays.set(dateKey, parseDaySpec(spec));
    }
  }
  return { tz, weekly, holidays };
}

/**
 * Snapshot of the schedule "now" in the schedule's own timezone. Used both
 * for evaluating the current state and walking forward to find the next open.
 */
function localContext(schedule: ParsedSchedule, when: Date): {
  /** 0=Mon..6=Sun (Pyth ordering, same as schedule.weekly). */
  dayIdx: number;
  minutesOfDay: number;
  /** "MMDD" string for today, in schedule TZ. */
  mmdd: string;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.tz,
    weekday: 'short', hour: 'numeric', minute: 'numeric', month: '2-digit', day: '2-digit',
    hour12: false,
  }).formatToParts(when);
  const wkRaw = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  // Intl returns Sun..Sat (0..6) typically; we convert to Pyth Mon..Sun (0..6).
  const intlOrder = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const intlIdx = intlOrder.indexOf(wkRaw);
  const dayIdx = intlIdx <= 0 ? 6 : intlIdx - 1; // Sun → 6, Mon → 0, ...
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return { dayIdx, minutesOfDay: hour * 60 + minute, mmdd: `${month}${day}` };
}

/** What windows apply on a given (dayIdx, mmdd)? Holiday overrides weekly. */
function windowsFor(schedule: ParsedSchedule, dayIdx: number, mmdd: string): DayWindow[] {
  const holiday = schedule.holidays.get(mmdd);
  if (holiday === 'closed') return [];
  if (Array.isArray(holiday)) return holiday;
  return schedule.weekly[dayIdx] ?? [];
}

/** Friendly summary of a weekly schedule (e.g. "Mon-Fri 09:30-16:00 America/New_York"). */
export function describeWeekly(schedule: ParsedSchedule): string {
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  // Group consecutive identical days for compactness.
  const groups: Array<{ days: number[]; sig: string; windows: DayWindow[] }> = [];
  for (let i = 0; i < 7; i++) {
    const w = schedule.weekly[i];
    const sig = JSON.stringify(w);
    const last = groups[groups.length - 1];
    if (last && last.sig === sig && last.days[last.days.length - 1] === i - 1) {
      last.days.push(i);
    } else {
      groups.push({ days: [i], sig, windows: w });
    }
  }
  const formatRange = (w: DayWindow[]): string => {
    if (w.length === 0) return 'closed';
    if (w.length === 1 && w[0].openMin === 0 && w[0].closeMin === 24 * 60) return '24h';
    return w.map((win) => `${minToHHMM(win.openMin)}-${minToHHMM(win.closeMin)}`).join(' & ');
  };
  const formatGroup = (g: { days: number[]; windows: DayWindow[] }): string => {
    const days = g.days.length === 1
      ? dayNames[g.days[0]]
      : `${dayNames[g.days[0]]}-${dayNames[g.days[g.days.length - 1]]}`;
    return `${days} ${formatRange(g.windows)}`;
  };
  const open = groups.filter((g) => g.windows.length > 0);
  if (open.length === 0) return `closed (${schedule.tz})`;
  return `${open.map(formatGroup).join(', ')} (${schedule.tz})`;
}

function minToHHMM(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "tomorrow 09:30 America/New_York" for the next-open ISO. */
export function formatNextOpen(tz: string, iso: string): string {
  const when = new Date(iso);
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(when);
  const wk = local.find((p) => p.type === 'weekday')?.value ?? '';
  const hh = local.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = local.find((p) => p.type === 'minute')?.value ?? '00';
  return `${wk} ${hh}:${mm} ${tz}`;
}

/** Evaluate where we are in `schedule` right now. */
export function evaluateSchedule(
  schedule: ParsedSchedule,
  now: Date = new Date(),
): { state: 'open' | 'closed' | 'break'; openWindow?: DayWindow; nextOpenIso?: string } {
  const ctx = localContext(schedule, now);
  const today = windowsFor(schedule, ctx.dayIdx, ctx.mmdd);
  const inside = today.find((w) => ctx.minutesOfDay >= w.openMin && ctx.minutesOfDay < w.closeMin);
  if (inside) {
    return { state: 'open', openWindow: inside };
  }
  // If today has a window later, mark "break" if we're between windows; "closed" otherwise.
  const laterToday = today.find((w) => w.openMin > ctx.minutesOfDay);
  const earlierToday = today.find((w) => w.closeMin <= ctx.minutesOfDay);
  if (laterToday && earlierToday) {
    return { state: 'break' };
  }
  // Walk forward up to 14 days to find the next open minute.
  for (let offset = laterToday ? 0 : 1; offset <= 14; offset++) {
    const probe = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
    const probeCtx = localContext(schedule, probe);
    const windows = windowsFor(schedule, probeCtx.dayIdx, probeCtx.mmdd);
    for (const w of windows) {
      if (offset === 0 && w.openMin <= probeCtx.minutesOfDay) continue;
      return { state: 'closed', nextOpenIso: probe.toISOString() };
    }
  }
  return { state: 'closed' };
}

interface HermesPriceUpdate {
  id: string;
  price: { price: string; expo: number; conf?: string };
}

interface BenchmarkResponse {
  s?: string;
  c?: number[];
  o?: number[];
  t?: number[];
}

export class PythPriceService {
  /** ticker (e.g. "Crypto.SOL/USD") → 32-byte hex feed id */
  private feedIdByTicker = new Map<string, string>();
  private tickerByFeedId = new Map<string, string>();
  /** ticker → asset class (Crypto/Equity/FX/Metal/Commodities/...) for fallback hints. */
  private assetTypeByTicker = new Map<string, string>();
  /** ticker → parsed Pyth schedule (the source of truth for trading hours). */
  private scheduleByTicker = new Map<string, ParsedSchedule>();
  private historyCache = new Map<string, { priceAgo: number; fetchedAt: number }>();
  /** Per-ticker market open/closed cache for trading-side gating (30s TTL). */
  private statusCache = new Map<string, { open: boolean; staleSeconds: number; checkedAt: number }>();
  private static readonly STATUS_TTL_MS = 30_000;
  private static readonly CLOSED_THRESHOLD_S = 600;
  private initialised = false;
  private initPromise: Promise<void> | null = null;

  /**
   * Current trading session for a ticker, driven by the Pyth-published schedule
   * attribute (see https://docs.pyth.network/price-feeds/core/market-hours).
   *
   * Returns 'open' | 'closed' | 'break' from the schedule, plus a short label.
   * Crypto / rates / unknown asset types fall through to 24/7 since Pyth often
   * omits a schedule for those. The asset-class fallback is only used when no
   * schedule is registered yet (e.g. before init() resolves).
   */
  marketSession(ticker: string): { state: 'regular' | 'pre' | 'post' | 'open' | 'break' | 'closed'; label: string } {
    const sched = this.scheduleByTicker.get(ticker);
    if (sched) {
      const ev = evaluateSchedule(sched);
      if (ev.state === 'open') {
        // Surface a richer label for equities so the UI can distinguish
        // pre/regular/post when the feed publishes outside the regular session.
        return { state: 'open', label: this.deriveOpenLabel(ticker, ev.openWindow) };
      }
      if (ev.state === 'break') return { state: 'break', label: 'Break' };
      return { state: 'closed', label: 'Closed' };
    }

    // Fallback: asset-class heuristics (used pre-init or for feeds without a
    // schedule attribute, e.g. crypto). Matches the V2 UI semantics.
    const cls = this.assetTypeByTicker.get(ticker)?.toLowerCase()
      ?? (ticker.startsWith('Crypto.') ? 'crypto'
        : ticker.startsWith('Equity.') ? 'equity'
        : ticker.startsWith('FX.') ? 'fx'
        : ticker.startsWith('Metal.') ? 'metal'
        : ticker.startsWith('Commodities.') ? 'commodities'
        : ticker.startsWith('Rates.') ? 'rates'
        : 'unknown');
    if (cls === 'crypto' || cls === 'rates' || cls === 'unknown') {
      return { state: 'open', label: '24/7' };
    }
    return { state: 'open', label: 'Open' };
  }

  /**
   * For an open feed: try to label by trading-day position.
   * Equity feeds typically declare 0930-1600 (regular). Pre/post variants
   * declare separate windows. We label by where the feed currently sits
   * within US-equity day boundaries, otherwise just "Open".
   */
  private deriveOpenLabel(ticker: string, win?: DayWindow): string {
    const cls = (this.assetTypeByTicker.get(ticker) ?? '').toLowerCase();
    if (cls === 'crypto') return '24/7';
    if (cls === 'equity' && win) {
      // Heuristic — only meaningful for US ticker schedules.
      const REG_OPEN = 9 * 60 + 30;
      const REG_CLOSE = 16 * 60;
      if (win.openMin >= REG_OPEN && win.closeMin <= REG_CLOSE) return 'Market';
      if (win.closeMin <= REG_OPEN) return 'Pre-Mkt';
      if (win.openMin >= REG_CLOSE) return 'Post-Mkt';
    }
    return 'Open';
  }

  /**
   * Human-readable trading-hours hint. Prefers Pyth's schedule when available,
   * falls back to asset-class heuristics otherwise. All times in the schedule's
   * declared timezone.
   */
  marketHoursHint(ticker: string): { hours: string; nextOpen: string } {
    const sched = this.scheduleByTicker.get(ticker);
    if (sched) {
      const ev = evaluateSchedule(sched);
      const hours = describeWeekly(sched);
      const nextOpen = ev.state === 'open' ? 'open now'
        : ev.nextOpenIso ? `next open: ${formatNextOpen(sched.tz, ev.nextOpenIso)}`
        : '';
      return { hours, nextOpen };
    }
    return this.legacyHoursHint(ticker);
  }

  /** Pre-schedule fallback. Only invoked if Pyth didn't publish a schedule. */
  private legacyHoursHint(ticker: string): { hours: string; nextOpen: string } {
    const cls = this.assetTypeByTicker.get(ticker)?.toLowerCase()
      ?? (ticker.startsWith('Crypto.') ? 'crypto'
        : ticker.startsWith('Equity.') ? 'equity'
        : ticker.startsWith('FX.') ? 'fx'
        : ticker.startsWith('Metal.') ? 'metal'
        : ticker.startsWith('Commodities.') ? 'commodities'
        : ticker.startsWith('Rates.') ? 'rates'
        : 'unknown');

    const nyParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date());
    const tzWeekday = nyParts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
    const tzHour = parseInt(nyParts.find((p) => p.type === 'hour')?.value ?? '0', 10);
    const tzMinute = parseInt(nyParts.find((p) => p.type === 'minute')?.value ?? '0', 10);

    const dayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(tzWeekday);
    const fmtDay = (i: number) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][((i % 7) + 7) % 7];

    const nextWeekday930 = (): string => {
      const d = (dayIdx === 0 || dayIdx === 6) ? (dayIdx === 6 ? 1 : 0)
        : (tzHour < 9 || (tzHour === 9 && tzMinute < 30)) ? 0
        : 1; // tomorrow
      let target = (dayIdx + d) % 7;
      while (target === 0 || target === 6) target = (target + 1) % 7;
      const label = (target === (dayIdx + 1) % 7) ? 'tomorrow' : fmtDay(target);
      return `${label} 9:30am ET`;
    };
    const nextSunday17 = (): string => {
      const daysToSun = dayIdx === 0 ? (tzHour < 17 ? 0 : 7) : 7 - dayIdx;
      return daysToSun === 0 ? 'tonight 5:00pm ET' : daysToSun === 1 ? 'tomorrow 5:00pm ET' : `${fmtDay(0)} 5:00pm ET`;
    };

    switch (cls) {
      case 'crypto':
        return { hours: 'crypto trades 24/7', nextOpen: 'should already be open — check connectivity' };
      case 'equity':
        return { hours: 'US equities trade Mon-Fri 9:30am-4:00pm ET', nextOpen: `next open: ${nextWeekday930()}` };
      case 'fx':
        return { hours: 'FX trades Sun 5pm - Fri 5pm ET', nextOpen: `next open: ${nextSunday17()}` };
      case 'metal':
        return { hours: 'metals trade Sun 6pm - Fri 5pm ET (1hr daily break ~5-6pm)', nextOpen: `next open: ${nextSunday17()}` };
      case 'commodities':
        return { hours: 'commodities trade Sun 6pm - Fri 5pm ET (varies by contract)', nextOpen: `next open: ${nextSunday17()}` };
      default:
        return { hours: '', nextOpen: '' };
    }
  }

  /**
   * Returns whether `ticker` is currently tradable, inferred from the staleness
   * of its latest Pyth publish. Cached for 30s. ~80ms cold, 0ms warm.
   * Fails open on error (don't block trades because our check is broken).
   */
  async isMarketOpen(ticker: string): Promise<{ open: boolean; staleSeconds: number }> {
    const cached = this.statusCache.get(ticker);
    if (cached && Date.now() - cached.checkedAt < PythPriceService.STATUS_TTL_MS) {
      return { open: cached.open, staleSeconds: cached.staleSeconds };
    }
    if (!this.initialised) {
      try { await this.init(); } catch { return { open: true, staleSeconds: -1 }; }
    }
    const id = this.feedIdByTicker.get(ticker);
    if (!id) return { open: true, staleSeconds: -1 };
    try {
      const res = await fetch(`${HERMES}/v2/updates/price/latest?ids[]=${id}`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) return { open: true, staleSeconds: -1 };
      const payload = (await readJsonCapped(res)) as { parsed?: Array<{ price: { publish_time?: number } }> };
      const pt = payload.parsed?.[0]?.price?.publish_time ?? 0;
      const nowSec = Math.floor(Date.now() / 1_000);
      const staleSeconds = pt > 0 ? Math.max(0, nowSec - pt) : -1;
      const open = staleSeconds < 0 ? true : staleSeconds <= PythPriceService.CLOSED_THRESHOLD_S;
      // FIFO trim: same pattern as historyCache. Cap at 500 — every market we
      // actually trade has headroom and a runaway script can't grow this map
      // unboundedly across the entire Pyth feed registry.
      if (this.statusCache.size >= 500) {
        const oldest = this.statusCache.keys().next().value;
        if (oldest !== undefined) this.statusCache.delete(oldest);
      }
      this.statusCache.set(ticker, { open, staleSeconds, checkedAt: Date.now() });
      return { open, staleSeconds };
    } catch {
      return { open: true, staleSeconds: -1 };
    }
  }

  /** One-shot init: pulls the Hermes feed registry and indexes by symbol. */
  async init(): Promise<void> {
    if (this.initialised) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      try {
        const res = await fetch(`${HERMES}/v2/price_feeds`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`feed registry: ${res.status}`);
        const feeds = (await readJsonCapped(res)) as HermesFeed[];
        // Defense-in-depth bound: Hermes returns ~500 feeds today. A hostile
        // or misbehaving Hermes response could feed an unbounded list which
        // would balloon the registry maps; clip at a safe ceiling.
        const MAX_FEEDS = 5000;
        const slice = feeds.slice(0, MAX_FEEDS);
        for (const f of slice) {
          const sym = f.attributes?.symbol;
          if (sym && f.id) {
            this.feedIdByTicker.set(sym, f.id);
            this.tickerByFeedId.set(f.id, sym);
            if (f.attributes?.asset_type) this.assetTypeByTicker.set(sym, f.attributes.asset_type);
            if (f.attributes?.schedule) {
              const parsed = parseSchedule(f.attributes.schedule);
              if (parsed) this.scheduleByTicker.set(sym, parsed);
            }
          }
        }
        // Set initialised BEFORE the IIFE clears initPromise so a third caller
        // arriving between the two doesn't observe initialised=false and re-fetch.
        this.initialised = true;
      } finally {
        this.initPromise = null;
      }
    })();
    return this.initPromise;
  }

  /**
   * Batch-fetch current prices + publish times for the given tickers via
   * Hermes `/v2/updates/price/latest`. Returns a Map keyed by ticker.
   * Tickers without a feed id are silently skipped.
   */
  async getCurrentPrices(tickers: string[]): Promise<Map<string, { price: number; publishTime: number }>> {
    if (!this.initialised) await this.init();
    const ids = tickers
      .map((t) => this.feedIdByTicker.get(t))
      .filter((id): id is string => !!id);
    if (ids.length === 0) return new Map();

    const url = `${HERMES}/v2/updates/price/latest?` + ids.map((id) => `ids[]=${id}`).join('&');
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) throw new Error(`hermes prices: ${res.status}`);
    const payload = (await readJsonCapped(res)) as { parsed?: Array<{ id: string; price: HermesPriceUpdate['price'] & { publish_time?: number } }> };

    const out = new Map<string, { price: number; publishTime: number }>();
    for (const p of payload.parsed ?? []) {
      const ticker = this.tickerByFeedId.get(p.id) ?? this.tickerByFeedId.get(`0x${p.id}`);
      if (!ticker) continue;
      const expo = p.price.expo;
      const raw = Number(p.price.price);
      if (!Number.isFinite(raw) || !Number.isFinite(expo)) continue;
      // Pyth exponents are typically -8 to -2; bound to a sane range so a
      // hostile / corrupted response can't produce Infinity/0 silently.
      if (expo < -18 || expo > 0) continue;
      const px = raw * Math.pow(10, expo);
      if (Number.isFinite(px) && px > 0) {
        out.set(ticker, { price: px, publishTime: p.price.publish_time ?? 0 });
      }
    }
    return out;
  }

  /**
   * Returns the price ~24h ago for a ticker, or null if Pyth doesn't have
   * benchmark data for it. Cached for 30 min — 24h change shifts slowly.
   */
  async get24hAgoPrice(ticker: string): Promise<number | null> {
    const cached = this.historyCache.get(ticker);
    if (cached && Date.now() - cached.fetchedAt < HISTORY_TTL_MS) return cached.priceAgo;

    const now = Math.floor(Date.now() / 1_000);
    // Window: yesterday's daily candle. We look back 2 days to be safe with TZ
    // boundaries and pick the most recent candle whose close is older than 24h.
    const url =
      `${BENCHMARKS}/v1/shims/tradingview/history?symbol=${encodeURIComponent(ticker)}` +
      `&resolution=D&from=${now - 2 * ONE_DAY_S}&to=${now}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return null;
      const data = (await readJsonCapped(res)) as BenchmarkResponse;
      if (data.s !== 'ok' || !data.c?.length || !data.t?.length) return null;
      // Pick the close of the candle whose timestamp is closest to but ≤ now-24h.
      const target = now - ONE_DAY_S;
      const ts = data.t;
      const closes = data.c;
      let best = -1;
      // Defensive: parallel-array access. If `ts` is sparse (missing index)
      // we treat that entry as 0 — strictly less than any positive `target`,
      // so it'll be picked only if it's the very first match, which is fine.
      for (let i = 0; i < ts.length && i < closes.length; i++) {
        const t = Number(ts[i] ?? 0);
        if (!Number.isFinite(t)) continue;
        if (t <= target) best = i;
        else break;
      }
      const idx = best >= 0 ? best : 0;
      const priceAgo = Number(closes[idx]);
      if (!Number.isFinite(priceAgo) || priceAgo <= 0) return null;
      // Bound the history cache so a long-running monitor doesn't grow it
      // unboundedly across the full Pyth feed registry. 500 entries is enough
      // for every market we actually trade, with headroom.
      if (this.historyCache.size >= 500) {
        const oldest = this.historyCache.keys().next().value;
        if (oldest !== undefined) this.historyCache.delete(oldest);
      }
      this.historyCache.set(ticker, { priceAgo, fetchedAt: Date.now() });
      return priceAgo;
    } catch {
      return null;
    }
  }

  /**
   * Convenience: fetch current + 24h-ago for a list of tickers and compute
   * percent change. The 24h leg is fired in parallel with throttling — Pyth
   * benchmarks rate-limits aggressive callers.
   */
  async getPrices(tickers: string[]): Promise<Map<string, PythPrice>> {
    const current = await this.getCurrentPrices(tickers);
    const out = new Map<string, PythPrice>();
    const nowSec = Math.floor(Date.now() / 1_000);
    const tasks = tickers.map(async (t, i) => {
      if (i % 6 === 5) await wait(50);
      const cur = current.get(t);
      if (cur === undefined) return;
      const ago = await this.get24hAgoPrice(t);
      const pending24h = ago === null;
      const priceChange24h = pending24h ? NaN : ((cur.price - ago!) / ago!) * 100;
      const staleSeconds = cur.publishTime > 0 ? Math.max(0, nowSec - cur.publishTime) : -1;
      out.set(t, {
        ticker: t,
        price: cur.price,
        priceChange24h,
        pending24h,
        publishTime: cur.publishTime,
        staleSeconds,
      });
    });
    await Promise.all(tasks);
    return out;
  }
}

let _pythSvc: PythPriceService | null = null;
export function getPythService(): PythPriceService {
  if (!_pythSvc) _pythSvc = new PythPriceService();
  return _pythSvc;
}
