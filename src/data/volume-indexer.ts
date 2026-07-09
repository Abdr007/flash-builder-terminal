/**
 * Trade-volume indexer — subscribes to ER program logs, decodes Anchor
 * events for opens / closes / increases / decreases / liquidations, and
 * aggregates 24h volume per market.
 *
 * Why this exists: there is no on-chain field that aggregates 24h volume —
 * the program emits per-trade `*Log` events but never sums them. Flash's UI
 * runs an off-chain indexer for this; we run a tiny one in-process.
 *
 * Persistence: trades are appended to `~/.magic/volume-events.jsonl`. On
 * restart we replay entries from the last 24h into memory so the user
 * doesn't lose context. Older lines are pruned during compaction.
 */

import { Connection, Logs, PublicKey } from '@solana/web3.js';
import { EventParser, Program } from '@coral-xyz/anchor';
import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import type { PoolConfig as MagicPoolConfig } from '@flash_trade/magic-trade-client';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1_000;
const COMPACTION_INTERVAL_MS = 60 * 60 * 1_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024; // hard cap for the jsonl

const VOLUME_EVENT_NAMES = new Set([
  'openPositionLogMTv1',
  'closePositionLogMTv1',
  'increasePositionSizeLog',
  'decreasePositionSizeLog',
  'liquidateLogMTv1',
]);

interface VolumeEvent {
  ts: number;
  market: string;
  symbol: string;
  sizeUsd: number;
  kind: 'open' | 'close' | 'increase' | 'decrease' | 'liquidate';
  signature?: string;
}

export class VolumeIndexer {
  private events: VolumeEvent[] = [];
  private subscriptionId: number | null = null;
  private compactionTimer: NodeJS.Timeout | null = null;
  private readonly logFilePath: string;
  private readonly parser: EventParser;
  private readonly marketToSymbol: Map<string, string>;
  private readonly seenSignatures = new Set<string>();
  /** When the indexer started — useful for "warming up" UI. */
  readonly startedAt: number;
  private starting = false;

  constructor(
    private readonly erConnection: Connection,
    private readonly program: Program,
    poolConfig: MagicPoolConfig,
  ) {
    this.startedAt = Date.now();
    this.logFilePath = join(homedir(), '.magic', 'volume-events.jsonl');
    mkdirSync(dirname(this.logFilePath), { recursive: true });
    this.parser = new EventParser(program.programId, program.coder);

    this.marketToSymbol = new Map();
    for (const m of poolConfig.markets) {
      const target = poolConfig.custodies.find((cu) => cu.custodyAccount.equals(m.targetCustody));
      if (target) this.marketToSymbol.set(m.marketAccount.toBase58(), target.symbol);
    }

    this.loadFromDisk();
  }

  /** Subscribe to ER program logs. Idempotent. Fails open on subscribe error. */
  async start(): Promise<void> {
    if (this.subscriptionId !== null || this.starting) return;
    this.starting = true;
    try {
      this.subscriptionId = this.erConnection.onLogs(
        this.program.programId,
        (logs) => this.onLogs(logs),
        'confirmed',
      );
      // Periodic compaction: prune old in-memory + rewrite jsonl.
      this.compactionTimer = setInterval(() => this.compact(), COMPACTION_INTERVAL_MS);
      this.compactionTimer.unref?.();
    } catch (err) {
      getLogger().warn('volume-indexer', `subscribe failed: ${getErrorMessage(err)}`);
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    if (this.compactionTimer) {
      clearInterval(this.compactionTimer);
      this.compactionTimer = null;
    }
    if (this.subscriptionId !== null) {
      try {
        await this.erConnection.removeOnLogsListener(this.subscriptionId);
      } catch { /* ignore */ }
      this.subscriptionId = null;
    }
  }

  private onLogs(logs: Logs): void {
    if (logs.err) return;
    if (logs.signature && this.seenSignatures.has(logs.signature)) return;
    if (logs.signature) this.seenSignatures.add(logs.signature);
    if (this.seenSignatures.size > 5000) {
      // Bound: drop oldest; not a strict LRU but safe enough.
      const arr = Array.from(this.seenSignatures);
      this.seenSignatures.clear();
      for (const s of arr.slice(-2500)) this.seenSignatures.add(s);
    }

    try {
      for (const event of this.parser.parseLogs(logs.logs)) {
        if (!VOLUME_EVENT_NAMES.has(event.name)) continue;
        const ev = this.normalize(event, logs.signature);
        if (ev) this.record(ev);
      }
    } catch {
      /* parse error on this tx — ignore */
    }
  }

  private normalize(event: { name: string; data: unknown }, signature?: string): VolumeEvent | null {
    const data = event.data as { market?: PublicKey; sizeUsd?: { toString(): string } } | undefined;
    if (!data?.market || !data.sizeUsd) return null;
    const marketPk = data.market.toBase58();
    const symbol = this.marketToSymbol.get(marketPk);
    if (!symbol) return null;
    const sizeRaw = Number(data.sizeUsd.toString());
    if (!Number.isFinite(sizeRaw) || sizeRaw <= 0) return null;
    const kind: VolumeEvent['kind'] =
      event.name.startsWith('open') ? 'open'
        : event.name.startsWith('close') ? 'close'
        : event.name.startsWith('increase') ? 'increase'
        : event.name.startsWith('decrease') ? 'decrease'
        : 'liquidate';
    return {
      ts: Date.now(),
      market: marketPk,
      symbol,
      sizeUsd: sizeRaw / 1_000_000,
      kind,
      signature,
    };
  }

  private appendFailures = 0;
  private static readonly MAX_APPEND_FAILURES = 10;

  private record(ev: VolumeEvent): void {
    this.events.push(ev);
    // Memory bound: compaction only runs every hour but a busy market can ship
    // thousands of events per hour. Force an in-memory compaction once we
    // cross the soft cap so getVolumes()/getStats() don't get O(N) slow and
    // RSS doesn't grow without bound between hourly compactions.
    if (this.events.length > 20_000) this.compact();
    if (this.appendFailures >= VolumeIndexer.MAX_APPEND_FAILURES) {
      // Disk persistence is dead — keep accumulating in memory only so the
      // monitor stays accurate, but stop hammering the FS.
      return;
    }
    try {
      // Bound the log file: if it's too big, compact before append.
      if (existsSync(this.logFilePath) && statSync(this.logFilePath).size > MAX_FILE_BYTES) {
        this.compact();
      }
      appendFileSync(this.logFilePath, JSON.stringify(ev) + '\n', { mode: 0o600 });
      this.appendFailures = 0;
    } catch (err) {
      this.appendFailures++;
      if (this.appendFailures === VolumeIndexer.MAX_APPEND_FAILURES) {
        getLogger().warn(
          'volume-indexer',
          `disabling jsonl persistence after ${VolumeIndexer.MAX_APPEND_FAILURES} consecutive write failures: ${getErrorMessage(err)}`,
        );
      } else {
        getLogger().debug('volume-indexer', `append failed: ${getErrorMessage(err)}`);
      }
    }
  }

  private loadFromDisk(): void {
    if (!existsSync(this.logFilePath)) return;
    try {
      const cutoff = Date.now() - ONE_DAY_MS;
      const content = readFileSync(this.logFilePath, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as VolumeEvent;
          if (typeof ev.ts === 'number' && ev.ts >= cutoff) this.events.push(ev);
        } catch { /* skip bad line */ }
      }
      this.events.sort((a, b) => a.ts - b.ts);
    } catch (err) {
      getLogger().debug('volume-indexer', `load failed: ${getErrorMessage(err)}`);
    }
  }

  /** Compact: prune entries > 24h old in memory AND rewrite the jsonl. */
  private compact(): void {
    const cutoff = Date.now() - ONE_DAY_MS;
    this.events = this.events.filter((e) => e.ts >= cutoff);
    try {
      const lines = this.events.map((e) => JSON.stringify(e)).join('\n');
      writeFileSync(this.logFilePath, lines + (lines ? '\n' : ''), { mode: 0o600 });
    } catch (err) {
      getLogger().debug('volume-indexer', `compact failed: ${getErrorMessage(err)}`);
    }
  }

  /** 24h volume per symbol, in USD. */
  getVolumes(): Map<string, number> {
    const cutoff = Date.now() - ONE_DAY_MS;
    const out = new Map<string, number>();
    for (const ev of this.events) {
      if (ev.ts < cutoff) continue;
      out.set(ev.symbol, (out.get(ev.symbol) ?? 0) + ev.sizeUsd);
    }
    return out;
  }

  /** Total 24h trade count and earliest event timestamp (for warm-up UX). */
  getStats(): { tradeCount: number; oldestTs: number; warmedSeconds: number } {
    const cutoff = Date.now() - ONE_DAY_MS;
    const fresh = this.events.filter((e) => e.ts >= cutoff);
    const oldestTs = fresh.length ? fresh[0].ts : Date.now();
    const warmedSeconds = Math.max(0, Math.floor((Date.now() - oldestTs) / 1_000));
    return { tradeCount: fresh.length, oldestTs, warmedSeconds };
  }

  /** True once indexer has at least N seconds of history (for "warming up" UI). */
  isWarm(minSeconds = 600): boolean {
    return this.getStats().warmedSeconds >= minSeconds;
  }
}

let _indexer: VolumeIndexer | null = null;
export function setVolumeIndexer(indexer: VolumeIndexer | null): void {
  _indexer = indexer;
}
export function getVolumeIndexer(): VolumeIndexer | null {
  return _indexer;
}
