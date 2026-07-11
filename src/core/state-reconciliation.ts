/**
 * State reconciliation — keeps the CLI's idea of the world in sync with
 * what the program actually says is on-chain.
 *
 * What we sync:
 *   - Open positions (count + per-market summary)
 *   - Available balances (UDL deposits − basket debits + pendingCredits)
 *   - Open orders & trigger orders
 *
 * When it runs:
 *   - On startup, once we have a wallet + client (called from terminal init).
 *   - On wallet switch (caller invokes `setClient` again).
 *   - Periodically every 60s thereafter while a client is attached (cache warm
 *     + a one-line "synced" REPL notice on the first reconcile per wallet).
 *
 * Numerical values are validated for finite-ness before being accepted;
 * corrupted reads are logged and skipped. Post-trade verification now lives in
 * `FlashV2BuilderClient.signAndSubmit` (on-chain confirm), so this module no
 * longer exposes a `verifyTrade`/snapshot API — that was dead (zero callers) and
 * read as a safety net that wasn't wired.
 *
 * This is NOT a write-back system. The blockchain is authoritative — we only
 * pull. If there's a discrepancy with anything we have cached locally, the
 * blockchain wins.
 */

import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';
import type { MagicTradeClient } from '../client/magic-client.js';

const RECONCILE_INTERVAL_MS = 60_000;
const FIRST_DELAY_MS = 1_500;

export interface ReconcileSnapshot {
  ts: number;
  positionCount: number;
  positions: Array<{ symbol: string; side: 'long' | 'short'; sizeUsd: number; collateralUsd: number; markPrice: number }>;
  openOrderCount: number;
  triggerCount: number;
  availableByToken: Record<string, number>;
}

class StateReconciler {
  private client: MagicTradeClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<ReconcileSnapshot | null> | null = null;
  private firstReconcileDone = false;
  // Generational counter — incremented on every wallet switch. doReconcile
  // captures the gen at the start of its async work and discards results that
  // arrive after a switch. Without this, a slow getPositions() against the
  // PREVIOUS wallet can clobber `lastSnapshot` AFTER `setClient(newWallet)`
  // has already cleared it, leaking the old wallet's positions into the new
  // session. Same idea protects against a reconcile racing an in-flight trade.
  private generation = 0;

  /**
   * Set or replace the active client. Idempotent for the same instance — the
   * tool-dispatch hot path may re-call this on every command, and we don't
   * want to reset the snapshot or re-trigger a reconcile each time.
   */
  setClient(client: MagicTradeClient | null): void {
    if (this.client === client) return;
    this.generation += 1;
    this.client = client;
    this.firstReconcileDone = false;
    // Drop any in-flight Promise reference so a stale resolution can't race
    // a newly issued reconcile under the same gen.
    this.inflight = null;
    if (client && !this.timer) this.start();
    if (!client && this.timer) this.stop();
    if (client) {
      // Defer the first run so we don't compete with banner / pre-warm.
      // .unref() so a fast-exiting REPL isn't held open by the deferred call.
      const t = setTimeout(() => { this.reconcile().catch(() => { /* swallow */ }); }, FIRST_DELAY_MS);
      t.unref?.();
    }
  }

  /** Begin periodic reconcile. Idempotent. No-op when no client is attached. */
  start(): void {
    if (this.timer || !this.client) return;
    this.timer = setInterval(() => {
      this.reconcile().catch(() => { /* swallow */ });
    }, RECONCILE_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Stop the periodic reconcile timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Force a reconcile right now. Returns the new snapshot or null on failure. */
  async reconcile(): Promise<ReconcileSnapshot | null> {
    if (!this.client) return null;
    if (this.inflight) return this.inflight;
    // Capture-and-compare in finally so a setClient() that nulled
    // `this.inflight` mid-flight, followed by a fresh reconcile() call,
    // doesn't get its inflight clobbered by THIS promise's stale finally.
    const me = this.doReconcile();
    this.inflight = me;
    me.finally(() => { if (this.inflight === me) this.inflight = null; });
    return me;
  }

  private async doReconcile(): Promise<ReconcileSnapshot | null> {
    const client = this.client;
    if (!client) return null;
    // Capture the wallet/client generation at the start of the async work so
    // we can discard results that arrive after a wallet switch.
    const startGen = this.generation;
    const logger = getLogger();
    try {
      const [positions, basket, balances] = await Promise.all([
        safeCall(() => client.getPositions(), [] as Awaited<ReturnType<typeof client.getPositions>>, 'getPositions'),
        safeCall(() => client.fetchBasket(), null as unknown, 'fetchBasket'),
        safeCall(
          () => client.getAvailableBalances(),
          new Map() as Awaited<ReturnType<typeof client.getAvailableBalances>>,
          'getAvailableBalances',
        ),
      ]);
      // Discard results from a prior generation — wallet switched mid-fetch.
      if (startGen !== this.generation) return null;

      const cleanPositions = positions
        .filter((p) => Number.isFinite(p.sizeUsd) && Number.isFinite(p.collateralUsd) && p.sizeUsd > 0)
        .map((p) => ({
          // Position carries `market` (the human symbol like "SOL") not `symbol`.
          symbol: p.market,
          side: (typeof p.side === 'string' ? p.side : String(p.side)).toLowerCase() as 'long' | 'short',
          sizeUsd: p.sizeUsd,
          collateralUsd: p.collateralUsd,
          markPrice: Number.isFinite(p.markPrice) ? p.markPrice : 0,
        }));

      let triggerCount = 0;
      let openOrderCount = 0;
      const b = basket as { triggerOrders?: unknown[]; limitOrders?: unknown[] } | null;
      if (b?.triggerOrders && Array.isArray(b.triggerOrders)) triggerCount = b.triggerOrders.length;
      if (b?.limitOrders && Array.isArray(b.limitOrders)) openOrderCount = b.limitOrders.length;

      const availableByToken: Record<string, number> = {};
      for (const [tok, info] of balances.entries()) {
        const v = info?.available;
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
          availableByToken[tok] = v;
        }
      }

      const snap: ReconcileSnapshot = {
        ts: Date.now(),
        positionCount: cleanPositions.length,
        positions: cleanPositions,
        openOrderCount,
        triggerCount,
        availableByToken,
      };
      // Re-check generation immediately before the assignment. The check at
      // line 148 happened before all the synchronous post-processing above
      // — a setClient() that fired between Promise.all resolving and now
      // would otherwise leak a snapshot from the previous wallet into the
      // new session. Synchronous re-check costs nothing.
      if (startGen !== this.generation) return null;

      if (!this.firstReconcileDone) {
        this.firstReconcileDone = true;
        logger.info(
          'reconcile',
          `synced: ${snap.positionCount} positions, ${snap.openOrderCount} orders, ${snap.triggerCount} triggers`,
        );
      }
      return snap;
    } catch (err) {
      logger.debug('reconcile', `failed: ${getErrorMessage(err)}`);
      return null;
    }
  }
}

/**
 * Run an async fn and return a fallback on failure. NEVER silent — every
 * failure logs at debug level so the user can tail the log to diagnose
 * "why is reconciliation showing zero positions". Swallowing the error
 * outright (the previous behavior) made an RPC outage indistinguishable
 * from "user has no positions" — a genuinely confusing UX failure.
 */
async function safeCall<T>(fn: () => Promise<T>, fallback: T, label = 'safeCall'): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    getLogger().debug('reconcile', `${label} failed: ${getErrorMessage(err)}`);
    return fallback;
  }
}

let _instance: StateReconciler | null = null;
export function getReconciler(): StateReconciler {
  if (!_instance) _instance = new StateReconciler();
  return _instance;
}
