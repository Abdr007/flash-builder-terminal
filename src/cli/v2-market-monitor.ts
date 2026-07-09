/**
 * Magic V2 market monitor TUI — verbatim port of bolt-terminal's
 * `market-monitor.ts`. Same telemetry header, same table chrome, same
 * keyboard handling, same diff-rendered redraw loop.
 *
 * Differences from v1, by user request:
 *   - Markets sourced from v2 PoolConfig (not v1 POOL_MARKETS).
 *   - Prices + 24h change come from Pyth (primary). For markets Pyth Hermes
 *     has no feed for, Flash's own /prices is used as an authoritative
 *     fallback so EVERY market always shows real data — never a blank row.
 *   - OI comes from `sdk.accounts.fetchAllCustodies` (v2 ER state), one batch
 *     RPC call per refresh.
 */

import type { Interface } from 'readline';
import chalk from 'chalk';
import { Connection, PublicKey } from '@solana/web3.js';
import { formatUsd, formatPrice, formatPercent } from '../utils/format.js';
import { c, pad, BRAND_NAME_SHORT, BRAND_NAME_UPPER } from './magic-theme.js';
import { TermRenderer } from './term-renderer.js';
import { MagicTradeClient } from '../client/magic-client.js';
import { getPythService } from '../data/pyth-prices.js';
import { getFlashPriceService } from '../data/flash-prices.js';
import { getFstatsVolumeService } from '../data/fstats-volume.js';
import { getVolumeIndexer } from '../data/volume-indexer.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';

interface MonitorDeps {
  rl: Interface;
  client: MagicTradeClient;
}

// 1 Hz live updates. Per-tick cost: 1 Pyth Hermes batch + 1 ER
// `getMultipleAccountsInfo` over cached market PDAs + 1 `getSlot`. fstats
// volume + Pyth 24h-ago prices use their own caches (30 s / 30 min) so we
// don't burn rate-limit headroom on them. Refresh-in-progress guard below
// prevents overlap if any tick spills past 1 s on a slow link.
const REFRESH_MS = 1_000;
const USD_POWER = 1_000_000;
// A Flash /prices reading older than this (the endpoint went down after a
// success) is NOT treated as a live quote — the row carries the last value
// forward under the "stale" styling instead of showing a frozen price as live.
const FLASH_MAX_LIVE_AGE_MS = 4_000;
const PRICE_MOVE_PCT = 1.0;
const OI_CHANGE_USD = 10_000;
const RATIO_SHIFT_PCT = 5;

interface MarketRow {
  symbol: string;
  price: number;
  change: number;
  totalOi: number;
  /** 24h trading volume in USD (fstats.io for V1-overlap markets, in-process indexer otherwise). */
  volume24hUsd: number;
  /** Where the volume came from — used to subdue the cell when we have nothing yet. */
  volumeSource: 'fstats' | 'indexer' | 'none';
  longPct: number;
  shortPct: number;
  priceDirection: 'up' | 'down' | 'flat';
  /** True when this tick carried the last known-good oracle price forward (the live fetch missed this symbol). */
  stale: boolean;
  /** Trading session derived from the Pyth schedule attribute (regular/pre/post/open/break/closed). */
  sessionState: 'regular' | 'pre' | 'post' | 'open' | 'break' | 'closed';
  sessionLabel: string;
}

interface MarketEvent {
  message: string;
  color: 'green' | 'red' | 'yellow';
  timestamp: number;
}

interface MarketSnapshot {
  timestamp: number;
  price: number;
  totalOi: number;
  longPct: number;
}

interface Telemetry {
  /** ER slot fetch round-trip — pure RPC baseline. */
  rpcLatencyMs: number;
  /** Pyth Hermes price fetch — oracle freshness. */
  oracleLatencyMs: number;
  /** ER fetchAllMarkets — read of aggregate OI state. */
  marketsLatencyMs: number;
  slot: number;
  renderTimeMs: number;
}

export async function runV2MarketMonitor(deps: MonitorDeps, filter?: string): Promise<void> {
  const { client } = deps;
  const erConn = (client as unknown as { sdk: { erConnection: Connection } }).sdk.erConnection;
  const pyth = getPythService();
  // Authoritative complete-coverage fallback: Flash's own /prices carries a
  // live price for EVERY market, including tokens Pyth Hermes has no feed for.
  const flashPrices = getFlashPriceService();

  // Symbol → custody (target) and pythTicker, derived once.
  // Only include custodies that are actually TARGETED by some market — this
  // drops stablecoin custodies like USDC which are collateral-only and have
  // no perp market (otherwise they'd render as "$0.00 50/50" garbage).
  type Spec = { symbol: string; pythTicker: string; targetCustody: PublicKey };
  const targetCustodySet = new Set<string>(
    client.poolConfig.markets.map((m) => m.targetCustody.toBase58()),
  );
  let specs: Spec[] = [];
  for (const cu of client.poolConfig.custodies) {
    // Only custodies actually TARGETED by a market — drops collateral-only
    // custodies (USDC, etc.) that have no perp market. A missing pythTicker no
    // longer excludes a market: Flash /prices covers it by symbol, so every
    // tradable market appears in the monitor even when Pyth has no feed for it.
    if (!targetCustodySet.has(cu.custodyAccount.toBase58())) continue;
    specs.push({ symbol: cu.symbol, pythTicker: cu.pythTicker ?? '', targetCustody: cu.custodyAccount });
  }
  if (filter) specs = specs.filter((s) => s.symbol === filter.toUpperCase());

  const renderer = new TermRenderer();
  let running = true;
  // Per-market 24h volume — primarily from fstats, with the in-process indexer
  // as a warm-start fallback. Refreshed via fstats getVolumes() (60s TTL).
  const fstatsVol = getFstatsVolumeService();
  let volumesBySymbol: Map<string, { volumeUsd: number; trades: number }> = new Map();
  let lastVolumeFetchAt = 0;

  // ─── STEP 1: isolate input before any rendering ──────────────
  deps.rl.pause();
  const wasRaw = process.stdin.isRaw;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  // Hard restore-on-failure: if anything between here and the cleanup-handler
  // registration throws, we'd otherwise leak the terminal in raw + alt-screen
  // mode. Wire a process-level listener that fires on crash and unwires once
  // the monitor either exits cleanly or registers its own cleanup.
  let altScreenEntered = false;
  const emergencyRestore = (): void => {
    try { if (altScreenEntered) renderer.leaveAltScreen(); } catch { /* ignore */ }
    try { renderer.reset(); } catch { /* ignore */ }
    try { if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false); } catch { /* ignore */ }
  };
  const onUncaught = (): void => emergencyRestore();
  process.once('uncaughtException', onUncaught);
  await new Promise<void>((resolve) => {
    const drain = (): void => { /* discard */ };
    process.stdin.on('data', drain);
    setTimeout(() => {
      process.stdin.removeListener('data', drain);
      resolve();
    }, 50);
  });

  // ─── State for event detection + history ──────────────────────
  const prevPrices = new Map<string, number>();
  const prevOi = new Map<string, number>();
  const prevLongPct = new Map<string, number>();
  // Last known-good oracle price per symbol. Lets a market keep showing real
  // data when a single tick's Hermes fetch misses it, instead of the whole
  // row vanishing. Persists for the life of the monitor session.
  const lastGood = new Map<string, { price: number; change: number }>();
  const HISTORY_DEPTH = 12;
  const marketHistory = new Map<string, MarketSnapshot[]>();
  const pushSnapshot = (sym: string, snap: MarketSnapshot) => {
    let buf = marketHistory.get(sym);
    if (!buf) {
      buf = [];
      marketHistory.set(sym, buf);
    }
    buf.push(snap);
    if (buf.length > HISTORY_DEPTH) buf.splice(0, buf.length - HISTORY_DEPTH);
  };
  const velocityLabel = (sym: string): string => {
    const buf = marketHistory.get(sym);
    if (!buf || buf.length < 2) return `${REFRESH_MS / 1000}s`;
    const elapsed = Math.round((buf[buf.length - 1].timestamp - buf[buf.length - 2].timestamp) / 1000);
    return `${elapsed > 0 ? elapsed : REFRESH_MS / 1000}s`;
  };

  let recentEvents: MarketEvent[] = [];
  const MAX_EVENTS = 6;

  const telemetry: Telemetry = { rpcLatencyMs: -1, oracleLatencyMs: -1, marketsLatencyMs: -1, slot: -1, renderTimeMs: 0 };
  let previousSlot = -1;
  let slotFreezeCount = 0;

  // ─── Data fetch — Pyth (prices + 24h) || ER (slot, OI) ────────
  const fetchData = async (): Promise<MarketRow[]> => {
    const now = Date.now();
    const tickers = specs.map((s) => s.pythTicker);
    // Real OI lives on each MARKET account's `collectivePosition.sizeUsd` —
    // one market per (target, lock, side). The LIVE state is on ER (basket is
    // delegated there); reading from `accounts` (L1) gives stale committed
    // snapshots that are usually zero or way behind. We reach for `erAccounts`
    // and fall back to L1 only if ER hasn't been initialised.
    // FAST PATH: batched `getMultipleAccountsInfo` over the known market PDAs.
    // The SDK's `fetchAllMarkets` does N sequential RPCs (one per market) and
    // takes ~3s against the live ER router. We replace it with a single
    // batched RPC and an in-process Anchor decode — typically <300ms.
    const sdkRoot = (client as unknown as {
      sdk: { program: { coder: { accounts: { decode: (n: string, b: Buffer) => unknown } } } };
    }).sdk;
    const decode = (buf: Buffer): { targetCustody: PublicKey; side: string | Record<string, unknown>; collectivePosition?: { sizeUsd?: { toString(): string } } } | null => {
      try {
        return sdkRoot.program.coder.accounts.decode('market', buf) as {
          targetCustody: PublicKey;
          side: string | Record<string, unknown>;
          collectivePosition?: { sizeUsd?: { toString(): string } };
        };
      } catch {
        return null;
      }
    };
    const marketPdas = client.poolConfig.markets.map((m) => m.marketAccount);
    const marketFetcher = async (): Promise<Array<{
      targetCustody: PublicKey;
      side: string | Record<string, unknown>;
      collectivePosition?: { sizeUsd?: { toString(): string } };
    }>> => {
      // ER `getMultipleAccountsInfo` accepts up to 100 keys — we have ~27, so
      // a single call covers them. Filter out nulls / decode failures.
      const infos = await erConn.getMultipleAccountsInfo(marketPdas, 'confirmed');
      const out: Array<{ targetCustody: PublicKey; side: string | Record<string, unknown>; collectivePosition?: { sizeUsd?: { toString(): string } } }> = [];
      for (const info of infos) {
        if (!info?.data) continue;
        const decoded = decode(info.data);
        if (decoded) out.push(decoded);
      }
      return out;
    };

    // Measure each call's latency independently — sharing a Promise.all
    // timer would just give us max(slowest), which made RPC and Oracle look
    // identical. Wrapping each promise lets the telemetry distinguish a slow
    // ER read from a slow Pyth fetch.
    const timed = <T>(p: Promise<T>): Promise<{ value: T; ms: number }> => {
      const t0 = performance.now();
      return p.then((value) => ({ value, ms: Math.round(performance.now() - t0) }));
    };

    // Refresh volumes lazily — fstats has its own 60s cache so we can call
    // every loop iteration without hammering them, but we'd rather not even
    // attempt the network round-trip when the cache is fresh.
    if (now - lastVolumeFetchAt > 30_000) {
      lastVolumeFetchAt = now;
      fstatsVol.getVolumes().then((v) => { volumesBySymbol = v; }).catch(() => { /* keep last */ });
    }

    const [oracleRes, marketsRes, rpcRes, flashRes] = await Promise.all([
      timed(pyth.getPrices(tickers).catch(() => new Map() as Map<string, ReturnType<typeof pyth.getPrices> extends Promise<Map<string, infer U>> ? U : never>)),
      timed(marketFetcher().catch(() => [] as Array<unknown>)),
      timed(erConn.getSlot('confirmed').catch(() => -1)),
      // Complete-coverage fallback price source. Own cache (1.5s TTL) so this
      // is a no-op network-wise most ticks; never throws.
      flashPrices.getPrices().catch(() => new Map()),
    ]);
    const pricesByTicker = oracleRes.value;
    const flashBySymbol = flashRes;
    // Only trust the Flash fallback as LIVE while its cache is fresh. During an
    // outage the service keeps serving its last map; without this a frozen
    // price would render as a live green quote.
    const flashFresh = flashPrices.ageMs() <= FLASH_MAX_LIVE_AGE_MS;
    const markets = marketsRes.value as Array<{
      targetCustody: PublicKey;
      side: string | Record<string, unknown>;
      collectivePosition?: { sizeUsd?: { toString(): string } };
    }>;
    const slot = rpcRes.value;

    telemetry.oracleLatencyMs = oracleRes.ms;
    telemetry.marketsLatencyMs = marketsRes.ms;
    telemetry.rpcLatencyMs = rpcRes.ms;
    telemetry.slot = slot;

    if (telemetry.slot > 0) {
      if (telemetry.slot === previousSlot) slotFreezeCount++;
      else slotFreezeCount = 0;
      previousSlot = telemetry.slot;
    }

    // Aggregate OI per target custody, split by side.
    const oiByCustody = new Map<string, { long: number; short: number }>();
    for (const m of markets) {
      const sizeRaw = m.collectivePosition?.sizeUsd ? Number(m.collectivePosition.sizeUsd.toString()) : 0;
      if (!Number.isFinite(sizeRaw) || sizeRaw <= 0) continue;
      const sideStr = (typeof m.side === 'string' ? m.side : Object.keys(m.side as object)[0] ?? '').toLowerCase();
      const key = m.targetCustody.toBase58();
      const cur = oiByCustody.get(key) ?? { long: 0, short: 0 };
      const sizeUsd = sizeRaw / USD_POWER;
      if (sideStr === 'short') cur.short += sizeUsd;
      else cur.long += sizeUsd;
      oiByCustody.set(key, cur);
    }

    const rows: MarketRow[] = [];
    for (const s of specs) {
      const tp = pricesByTicker.get(s.pythTicker);
      const pythLive = !!tp && Number.isFinite(tp.price) && tp.price > 0;
      // Never drop a market. Price source priority:
      //   1. Pyth Hermes (live) — primary; also gives 24h change.
      //   2. Flash /prices (live) — authoritative fallback for tokens Pyth has
      //      no feed for (FARTCOIN, PUMP, GRAM, …), so they show REAL data.
      //   3. Last known-good price carried forward, flagged stale.
      //   4. "—" only if the symbol has never been priced this session.
      // Result: every configured market is always present with real data.
      const flashPx = (pythLive || !flashFresh) ? undefined : flashBySymbol.get(s.symbol.toUpperCase());
      const flashLive = !!flashPx && Number.isFinite(flashPx.price) && flashPx.price > 0;
      const live = pythLive || flashLive;
      const remembered = lastGood.get(s.symbol);
      const price = pythLive ? tp!.price : flashLive ? flashPx!.price : remembered?.price ?? 0;
      // Flash /prices carries no 24h change; keep the last Pyth-derived change
      // if we ever had one, else N/A. Price is what the requirement is about.
      const change = pythLive ? tp!.priceChange24h : remembered?.change ?? NaN;
      const stale = !live;
      if (live) lastGood.set(s.symbol, { price, change });
      const oi = oiByCustody.get(s.targetCustody.toBase58()) ?? { long: 0, short: 0 };
      const totalOi = oi.long + oi.short;
      const longPct = totalOi > 0 ? Math.round((oi.long / totalOi) * 100) : 50;
      const shortPct = totalOi > 0 ? 100 - longPct : 50;

      const prev = prevPrices.get(s.symbol);
      let priceDirection: 'up' | 'down' | 'flat' = 'flat';
      if (live && prev !== undefined && prev > 0) {
        // Float-equality direction made every micro-tick (sub-cent jitter)
        // toggle the green/red color, which read as flicker. Demand at
        // least 1 ppm of the prior price before flagging direction.
        const epsilon = prev * 1e-6;
        if (price > prev + epsilon) priceDirection = 'up';
        else if (price < prev - epsilon) priceDirection = 'down';
      }

      const vLabel = velocityLabel(s.symbol);
      if (live && prev !== undefined && prev > 0) {
        const pct = ((price - prev) / prev) * 100;
        if (Math.abs(pct) >= PRICE_MOVE_PCT) {
          const dir = pct > 0 ? '+' : '';
          recentEvents.push({
            message: `${s.symbol} price moved ${dir}${pct.toFixed(2)}% (${vLabel})`,
            color: pct > 0 ? 'green' : 'red',
            timestamp: now,
          });
        }
      }
      const prevOiVal = prevOi.get(s.symbol);
      if (prevOiVal !== undefined && prevOiVal > 0) {
        const oiDelta = totalOi - prevOiVal;
        if (Math.abs(oiDelta) >= OI_CHANGE_USD) {
          const dir = oiDelta > 0 ? '+' : '-';
          recentEvents.push({
            message: `${s.symbol} OI ${dir}${formatUsd(Math.abs(oiDelta))} (${vLabel})`,
            color: oiDelta > 0 ? 'green' : 'yellow',
            timestamp: now,
          });
        }
      }
      const prevLong = prevLongPct.get(s.symbol);
      if (prevLong !== undefined) {
        const shift = longPct - prevLong;
        if (Math.abs(shift) >= RATIO_SHIFT_PCT) {
          const desc = shift > 0 ? `longs +${shift}pp` : `shorts +${Math.abs(shift)}pp`;
          recentEvents.push({
            message: `${s.symbol} ratio shifted: ${desc} (${vLabel})`,
            color: 'yellow',
            timestamp: now,
          });
        }
      }

      if (live) prevPrices.set(s.symbol, price);
      prevOi.set(s.symbol, totalOi);
      prevLongPct.set(s.symbol, longPct);
      if (live) pushSnapshot(s.symbol, { timestamp: now, price, totalOi, longPct });

      // Trading session — driven by Pyth's `attributes.schedule` per feed,
      // with asset-class fallback for crypto / unknown.
      const session = pyth.marketSession(s.pythTicker);

      // 24h volume: prefer fstats numbers (Flash's own indexer covers V1
      // markets), fall back to our in-process Anchor event indexer for
      // anything fstats doesn't cover (V2-only / new markets).
      const fstatsHit = volumesBySymbol.get(s.symbol.toUpperCase());
      let volume24hUsd = 0;
      let volumeSource: MarketRow['volumeSource'] = 'none';
      if (fstatsHit && fstatsHit.volumeUsd > 0) {
        volume24hUsd = fstatsHit.volumeUsd;
        volumeSource = 'fstats';
      } else {
        const indexer = getVolumeIndexer();
        const local = indexer?.getVolumes().get(s.symbol);
        if (local && local > 0) {
          volume24hUsd = local;
          volumeSource = 'indexer';
        }
      }

      rows.push({
        symbol: s.symbol,
        price,
        change,
        totalOi,
        volume24hUsd,
        volumeSource,
        longPct,
        shortPct,
        priceDirection,
        stale,
        sessionState: session.state,
        sessionLabel: session.label,
      });
    }

    // Evict stale events (>60s) and cap size
    const eventNow = Date.now();
    recentEvents = recentEvents.filter((e) => eventNow - e.timestamp < 60_000);
    if (recentEvents.length > MAX_EVENTS) recentEvents = recentEvents.slice(-MAX_EVENTS);

    // Sort by current trading activity: 24h volume primary, OI tiebreaker.
    // Markets with no volume yet (pre-indexer warm-up) fall to OI ranking,
    // so high-volume markets (ETH, BTC, SOL) surface immediately and dormant
    // ones (TXN, INTC, …) sink. Avoids the "ETH below SPY" anomaly we saw
    // when sorting purely by OI.
    //
    // Hysteresis: round each value to its top 2 significant digits before
    // comparing — gives a natural ~5% deadband at any magnitude. Without
    // this, two markets within $1k of each other swap rank on every tick
    // as their volumes update, producing visible row jitter.
    const bucket = (n: number): number => {
      if (!Number.isFinite(n) || n <= 0) return 0;
      const mag = Math.floor(Math.log10(n));
      const step = Math.pow(10, Math.max(0, mag - 1));
      return Math.round(n / step) * step;
    };
    rows.sort((a, b) => {
      const va = a.volume24hUsd > 0 ? bucket(a.volume24hUsd) : -1;
      const vb = b.volume24hUsd > 0 ? bucket(b.volume24hUsd) : -1;
      if (va !== vb) return vb - va;
      const oa = bucket(a.totalOi);
      const ob = bucket(b.totalOi);
      if (oa !== ob) return ob - oa;
      // Final tiebreaker: alphabetical so ties are stable across ticks.
      return a.symbol.localeCompare(b.symbol);
    });
    return rows;
  };

  // ─── Frame builder — same chrome as v1 ────────────────────────
  const buildFrame = (rows: MarketRow[]): string[] => {
    const termHeight = process.stdout.rows || 24;
    // Include the date so a monitor left running across midnight remains
    // unambiguous. Locale picks short forms automatically.
    const nowD = new Date();
    const now = `${nowD.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}  ${nowD.toLocaleTimeString()}`;

    const rpcMs = telemetry.rpcLatencyMs;
    const rpcStr =
      rpcMs < 0 ? c.faint('RPC N/A')
        : rpcMs < 150 ? chalk.green(`RPC ${rpcMs}ms`)
        : rpcMs < 400 ? chalk.yellow(`RPC ${rpcMs}ms`)
        : chalk.red(`RPC ${rpcMs}ms`);

    const oMs = telemetry.oracleLatencyMs;
    const oracleStr =
      oMs < 0 ? c.faint('Oracle N/A')
        : oMs <= 1500 ? chalk.green(`Oracle ${oMs}ms`)
        : oMs <= 4000 ? chalk.yellow(`Oracle ${oMs}ms ⚠`)
        : chalk.red(`Oracle ${oMs}ms ⚠`);

    const slotStr =
      telemetry.slot < 0 ? c.faint('Slot N/A')
        : slotFreezeCount >= 2 ? chalk.red(`Slot ${telemetry.slot} ⚠`)
        : chalk.green(`Slot ${telemetry.slot}`);

    // Replaced the cosmetic "Lag 0" with actual ER markets-fetch latency.
    // ER is single-leader so slot-lag has no meaning here; market read time
    // is the more useful number — it's the bottleneck for OI freshness.
    const mMs = telemetry.marketsLatencyMs;
    const mktsStr =
      mMs < 0 ? c.faint('Mkts N/A')
        : mMs <= 400 ? chalk.green(`Mkts ${mMs}ms`)
        : mMs <= 1500 ? chalk.yellow(`Mkts ${mMs}ms`)
        : chalk.red(`Mkts ${mMs}ms ⚠`);

    // Telemetry: RPC · Oracle · Mkts · Slot. Render time and the "Pyth · ER"
    // source label are dropped — neither is actionable, and removing them
    // gives the line space to breathe.
    const telemetryLine =
      `  ${rpcStr}  ${c.faint('·')}  ${oracleStr}  ${c.faint('·')}  ${mktsStr}  ` +
      `${c.faint('·')}  ${slotStr}`;

    const CHROME_LINES = 7;
    const maxMarketRows = Math.max(5, termHeight - CHROME_LINES);
    const visibleRows = rows.slice(0, maxMarketRows);
    const truncated = rows.length > maxMarketRows;

    // Visible column widths (vlen-aware). Header pads on raw strings then we
    // wrap with chalk; data rows use `pad()` which strips ANSI before measuring.
    const ASSET_W = 14;
    const hdr = [
      c.muted(pad('  Asset', ASSET_W)),
      c.muted('Price'.padStart(14)),
      c.muted('24h Change'.padStart(12)),
      c.muted('Open Interest'.padStart(16)),
      c.muted('24h Volume'.padStart(14)),
      c.muted('Long / Short'.padStart(14)),
      c.muted('Session'.padStart(11)),
    ].join('');

    // One title row carries the brand on the left and the live meta (date,
    // time, market count) on the right. The "press q to exit" hint is dropped
    // — it's standard TUI affordance and we'd rather give the table room.
    const headerRight =
      `${c.muted(`${rows.length} markets`)}  ${c.faint('·')}  ${c.muted(now)}`;

    // Single rule under the column header — fewer dividers, more breathing
    // room. The data block is delimited by the muted column-header row above
    // and a blank line / footer below; no top rule needed.
    const lines: string[] = [
      `  ${c.teal.bold(BRAND_NAME_SHORT)}  ${c.faint('·')}  ${c.teal('Market Monitor')}    ${headerRight}`,
      telemetryLine,
      '',
      hdr,
      `  ${c.faint('─'.repeat(95))}`,
    ];

    for (const r of visibleRows) {
      // Session-aware dot — colored by current trading session (matches V2 UI
      // semantics: regular = ●, pre/post = ◐/◑, closed = ○, break = ◐ muted).
      // All markets remain tradable 24/7 via Flash's internal oracle; the dot
      // is just a freshness/session indicator.
      const dot =
        r.sessionState === 'regular' || r.sessionState === 'open' ? c.long('●')
          : r.sessionState === 'pre' ? c.cyan('◐')
          : r.sessionState === 'post' ? c.cyan('◑')
          : r.sessionState === 'break' ? c.warn('◐')
          : r.sessionState === 'closed' ? c.faint('○')
          : c.muted('●');
      const sym = pad(`  ${dot} ${chalk.bold(r.symbol)}`, ASSET_W);
      // Direction glyph alongside color so colorblind users can read the
      // signal — color-only signals fail for ~8% of male users.
      const dirArrow = r.priceDirection === 'up' ? '▲ '
        : r.priceDirection === 'down' ? '▼ '
        : '  ';
      const priceStr = (r.price > 0 ? dirArrow + formatPrice(r.price) : '—').padStart(14);
      const coloredPrice =
        r.price <= 0 ? c.faint(priceStr)
          : r.stale ? c.muted(priceStr) // carried-forward last-known price — subdued, no direction color
          : r.priceDirection === 'up' ? chalk.green(priceStr)
          : r.priceDirection === 'down' ? chalk.red(priceStr)
          : priceStr;
      const changeRaw = !Number.isFinite(r.change)
        ? 'N/A'.padStart(12)
        : r.change === 0
          ? '+0.00%'.padStart(12)
          : formatPercent(r.change).padStart(12);
      // Same idea for 24h change — sign in `formatPercent` already, but a
      // glyph reinforces it without color.
      const change = !Number.isFinite(r.change) ? c.faint(changeRaw)
        : r.change > 0 ? c.long(changeRaw)
        : r.change < 0 ? c.short(changeRaw)
        : c.faint(changeRaw);
      // Empty cells are an em dash, not a misleading "$0.00 / 50 / 50".
      // Markets with zero OI have no real ratio — distinguish them visually
      // from genuinely balanced 50/50 markets that *do* have OI.
      const oiStr = r.totalOi > 0
        ? formatUsd(r.totalOi).padStart(16)
        : c.faint('—'.padStart(16));
      const volRaw = r.volumeSource === 'none'
        ? '—'.padStart(14)
        : formatUsd(r.volume24hUsd).padStart(14);
      const volStr = r.volumeSource === 'none'
        ? c.faint(volRaw)
        : r.volumeSource === 'indexer'
          ? c.muted(volRaw) // dimmer until fstats kicks in / for V2-only markets
          : volRaw;
      // Long/Short ratio with explicit `L/S` glyphs so colorblind users
      // can read the dominant side. Pure color was the only signal before.
      const ratioRaw = r.totalOi > 0
        ? `${r.longPct}L / ${r.shortPct}S`.padStart(14)
        : '—'.padStart(14);
      const ratioColored = r.totalOi <= 0
        ? c.faint(ratioRaw)
        : r.longPct > 60 ? c.long(ratioRaw)
          : r.shortPct > 60 ? c.short(ratioRaw)
          : c.faint(ratioRaw);
      const sessRaw = (r.sessionLabel || (r.sessionState === 'closed' ? 'Closed' : 'Open')).padStart(11);
      const sessStr =
        r.sessionState === 'closed' ? c.short(sessRaw)
          : r.sessionState === 'break' ? c.warn(sessRaw)
          : r.sessionState === 'pre' || r.sessionState === 'post' ? c.cyan(sessRaw)
          : c.long(sessRaw);
      lines.push(`${sym}${coloredPrice}${change}${oiStr}${volStr}${ratioColored}${sessStr}`);
    }

    if (visibleRows.length === 0) lines.push(c.faint('  No active markets found.'));
    if (truncated) lines.push(c.faint(`  ... +${rows.length - maxMarketRows} more (resize terminal to see all)`));

    // Bottom rule + footer line: session distribution on the left, aggregate
    // OI / 24h volume on the right. Mirrors a Bloomberg-style status bar.
    const counts = {
      cont: rows.filter((r) => r.sessionLabel === '24/7').length,
      market: rows.filter((r) => r.sessionLabel === 'Market').length,
      pre: rows.filter((r) => r.sessionState === 'pre').length,
      post: rows.filter((r) => r.sessionState === 'post').length,
      open: rows.filter((r) => r.sessionState === 'open' && r.sessionLabel !== '24/7' && r.sessionLabel !== 'Market').length,
      brk: rows.filter((r) => r.sessionState === 'break').length,
      closed: rows.filter((r) => r.sessionState === 'closed').length,
    };
    const sessParts = [
      counts.cont ? `${c.long('●')} ${c.faint(`24/7 (${counts.cont})`)}` : '',
      counts.market ? `${c.long('●')} ${c.faint(`Market (${counts.market})`)}` : '',
      counts.pre ? `${c.cyan('◐')} ${c.faint(`Pre (${counts.pre})`)}` : '',
      counts.post ? `${c.cyan('◑')} ${c.faint(`Post (${counts.post})`)}` : '',
      counts.open ? `${c.long('●')} ${c.faint(`Open (${counts.open})`)}` : '',
      counts.brk ? `${c.warn('◐')} ${c.faint(`Break (${counts.brk})`)}` : '',
      counts.closed ? `${c.faint('○')} ${c.faint(`Closed (${counts.closed})`)}` : '',
    ].filter(Boolean).join('  ');

    // Footer = session distribution only. Totals row removed: the
    // aggregated OI / 24h-volume numbers were misleading because they
    // mixed real per-row values with a few rows where the indexer
    // returned a flat fallback, producing apparently-real but actually-
    // synthetic totals. Per-row data is what traders look at anyway.
    lines.push('');
    lines.push(`  ${sessParts}`);

    return lines;
  };

  // Full cleanup for any setup-phase failure AFTER raw mode / alt-screen were
  // entered. These are normal promise rejections (not uncaughtException), so
  // the emergency handler wouldn't fire — without this the terminal leaks in
  // raw + alt-screen mode. Restores everything and unwires the crash listener.
  const cleanupAndBail = (err: unknown, what: string): void => {
    emergencyRestore(); // leaveAltScreen + reset + setRawMode(wasRaw)
    process.removeListener('uncaughtException', onUncaught);
    deps.rl.resume();
    getLogger().warn('v2-monitor', `${what}: ${getErrorMessage(err)}`);
    try { process.stdout.write(chalk.red(`  Market monitor: ${getErrorMessage(err)}\n`)); } catch { /* stdout closed */ }
  };

  // ─── STEP 2: enter alt-screen + loading frame ─────────────────
  try {
    renderer.enterAltScreen();
    altScreenEntered = true;
    renderer.clear();
    renderer.render(['', `  ${c.teal.bold(`${BRAND_NAME_UPPER} — MARKET MONITOR`)}`, '', c.faint('  Loading market data via Pyth…'), '']);
  } catch (err) {
    cleanupAndBail(err, 'alt-screen enter failed');
    return;
  }

  // ─── STEP 3: first dataset (block) ────────────────────────────
  let initialRows: MarketRow[];
  try {
    initialRows = await fetchData();
  } catch (err) {
    cleanupAndBail(err, 'initial fetch failed');
    return;
  }

  try {
    const renderStart0 = performance.now();
    renderer.render(buildFrame(initialRows));
    telemetry.renderTimeMs = Math.round(performance.now() - renderStart0);
  } catch (err) {
    cleanupAndBail(err, 'initial render failed');
    return;
  }

  // ─── STEP 4: refresh loop ─────────────────────────────────────
  // Coalesce concurrent ticks: `inFlight` is the actual pending fetchData
  // promise (if any). The Promise.race timeout below abandons late results,
  // but the inner promise stays alive — and we keep `inFlight` set to it
  // until it actually resolves. That way a hung Pyth/ER call can't spawn a
  // pile of concurrent fetches at 1 Hz.
  // Track the latest fetched rows so the resize handler (registered below)
  // can re-render with current data instead of the initial snapshot.
  let lastRowsForResize: MarketRow[] = initialRows;
  let inFlight: Promise<MarketRow[]> | null = null;
  const interval = setInterval(async () => {
    if (!running || inFlight) return;
    const fetchPromise = fetchData();
    inFlight = fetchPromise;
    // Clear `inFlight` only when the underlying fetch actually settles.
    fetchPromise.finally(() => { if (inFlight === fetchPromise) inFlight = null; });
    try {
      const rows = await Promise.race([
        fetchPromise,
        new Promise<MarketRow[]>((_, reject) => setTimeout(() => reject(new Error('refresh timeout')), 4_000)),
      ]);
      if (!running) return;
      const renderStart = performance.now();
      lastRowsForResize = rows;
      const frame = buildFrame(rows);
      if (renderer.hasChanged(frame)) renderer.render(frame);
      telemetry.renderTimeMs = Math.round(performance.now() - renderStart);
    } catch {
      /* skip; keep last good frame. inFlight is cleared by the finally on the inner promise. */
    }
  }, REFRESH_MS);

  // ─── STEP 4b: redraw on terminal resize ───────────────────────
  // Without this, the layout snaps to whatever rows/cols were live at the
  // last 1Hz tick — a wider window leaves the right side blank and a
  // narrower one wraps the header row until the next tick fires.
  const onResize = () => {
    if (!running) return;
    try {
      // Force a full redraw — clear the renderer's last-frame cache so the
      // next render() doesn't short-circuit on hasChanged.
      renderer.reset();
      renderer.enterAltScreen();
      renderer.render(buildFrame(lastRowsForResize));
    } catch { /* best-effort */ }
  };
  process.stdout.on('resize', onResize);

  // ─── STEP 5: exit on 'q' / Ctrl-C ─────────────────────────────
  await new Promise<void>((resolve) => {
    let exited = false;
    const cleanup = () => {
      if (exited) return;
      exited = true;
      process.removeListener('uncaughtException', onUncaught);
      process.stdout.removeListener('resize', onResize);
      process.stdin.removeListener('data', onKey);
      process.stdin.removeListener('error', onStdinError);
      process.stdin.removeListener('end', onStdinEnd);
      running = false;
      clearInterval(interval);
      renderer.leaveAltScreen();
      renderer.reset();
      process.stdin.pause();
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false);
      const drainHandler = () => { /* discard */ };
      process.stdin.resume();
      process.stdin.on('data', drainHandler);
      setTimeout(() => {
        process.stdin.removeListener('data', drainHandler);
        process.stdin.pause();
        deps.rl.resume();
        if (deps.rl.terminal) {
          (deps.rl as unknown as { line: string }).line = '';
          (deps.rl as unknown as { cursor: number }).cursor = 0;
          deps.rl.prompt();
        }
        resolve();
      }, 100);
    };
    const onKey = (buf: Buffer) => {
      const key = buf.toString();
      if (key !== 'q' && key !== 'Q' && key !== '\x03') return;
      cleanup();
    };
    const onStdinError = () => cleanup();
    const onStdinEnd = () => cleanup();
    process.stdin.on('data', onKey);
    process.stdin.on('error', onStdinError);
    process.stdin.on('end', onStdinEnd);
  });
}
