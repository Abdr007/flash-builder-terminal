/**
 * Background health probe for the MagicBlock ER router.
 *
 * Pings `getBlockHeight` every 30s and records (a) success vs error, (b) RTT.
 * Exposes a snapshot the prompt status bar can read so the user gets a heads-up
 * when the ER is degraded BEFORE they sign trades against it.
 *
 * Usage:
 *   const mon = startErHealthMonitor('https://flashtrade.magicblock.app/');
 *   const status = mon.snapshot();   // { healthy, lastRttMs, lastErr, ... }
 *   mon.stop();                       // on shutdown
 */

import { Connection } from '@solana/web3.js';
import { getErrorMessage } from '../utils/retry.js';

export interface ErHealthSnapshot {
  endpoint: string;
  healthy: boolean;
  lastCheckAt: number;
  lastRttMs: number;
  lastBlockHeight: number;
  lastErr: string | null;
  consecutiveFailures: number;
}

export class ErHealthMonitor {
  private conn: Connection;
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: ErHealthSnapshot;
  private ticking = false;

  constructor(public readonly endpoint: string) {
    this.conn = new Connection(endpoint, 'confirmed');
    this.state = {
      endpoint,
      // Pessimistic default: nothing has been verified yet, so report unhealthy
      // until the first probe lands. UI can detect this via lastCheckAt === 0.
      healthy: false,
      lastCheckAt: 0,
      lastRttMs: 0,
      lastBlockHeight: 0,
      lastErr: null,
      consecutiveFailures: 0,
    };
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    void this.runTick();
    this.timer = setInterval(() => void this.runTick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): ErHealthSnapshot {
    return { ...this.state };
  }

  /**
   * Re-entrancy guard: a degraded ER endpoint can take 30+ seconds to time out,
   * which is exactly the probe interval. Without this guard the next probe
   * fires while the previous is still in flight, doubling load on the failing
   * endpoint and producing overlapping state writes.
   */
  private async runTick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tick();
    } finally {
      this.ticking = false;
    }
  }

  private async tick(): Promise<void> {
    const start = Date.now();
    try {
      const h = await this.conn.getBlockHeight('confirmed');
      this.state = {
        ...this.state,
        healthy: true,
        lastCheckAt: Date.now(),
        lastRttMs: Date.now() - start,
        lastBlockHeight: h,
        lastErr: null,
        consecutiveFailures: 0,
      };
    } catch (err) {
      this.state = {
        ...this.state,
        healthy: false,
        lastCheckAt: Date.now(),
        lastRttMs: Date.now() - start,
        lastErr: getErrorMessage(err),
        consecutiveFailures: this.state.consecutiveFailures + 1,
      };
    }
  }
}

let _global: ErHealthMonitor | null = null;

export function startErHealthMonitor(endpoint: string): ErHealthMonitor {
  if (_global && _global.endpoint === endpoint) return _global;
  if (_global) _global.stop();
  _global = new ErHealthMonitor(endpoint);
  _global.start();
  return _global;
}

export function getErHealthMonitor(): ErHealthMonitor | null {
  return _global;
}

/** Stop and release the singleton. Called from the terminal's clean-shutdown. */
export function stopErHealthMonitor(): void {
  if (_global) _global.stop();
  _global = null;
}
