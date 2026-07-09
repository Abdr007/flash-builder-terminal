/**
 * Magic-mode liquidation-risk alerts.
 *
 * Background poller that tracks distance-to-liq per open position and posts
 * to Telegram and/or Discord webhooks when a position crosses thresholds.
 *
 * Config via env:
 *   MAGIC_ALERTS_TG_BOT_TOKEN, MAGIC_ALERTS_TG_CHAT_ID  (Telegram)
 *   MAGIC_ALERTS_DISCORD_WEBHOOK                          (Discord)
 *   MAGIC_ALERTS_INTERVAL_MS  (default 60000)
 *
 * Thresholds (with hysteresis to prevent spam):
 *   distance ≥ 30%:            SAFE
 *   30% > distance ≥ 15%:      WARNING (alerted)
 *   distance < 15%:            CRITICAL (alerted)
 *
 * Recovery direction uses wider thresholds (35% / 18%) so a position
 * hovering near a boundary doesn't ping back-and-forth.
 */

import type { MagicTradeClient } from '../client/magic-client.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';

const log = getLogger();

type Level = 'SAFE' | 'WARNING' | 'CRITICAL';

interface PositionRiskState {
  key: string;        // `${market}:${side}`
  level: Level;
  lastDistance: number;
  lastChangeAt: number;
}

export interface MagicAlertConfig {
  intervalMs?: number;
  telegram?: { botToken: string; chatId: string };
  discord?: { webhookUrl: string };
}

/**
 * Validate a webhook URL: https only, no embedded credentials, public host
 * (no loopback / RFC1918 / link-local / mDNS) so a misconfigured env var
 * can't be used to SSRF the cloud metadata service or an internal service.
 */
function validateWebhookUrl(raw: string, label: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    log.warn('magic-alerts', `${label} URL is not a valid URL — ignoring`);
    return null;
  }
  if (u.protocol !== 'https:') {
    log.warn('magic-alerts', `${label} URL must be https — ignoring`);
    return null;
  }
  if (u.username || u.password) {
    log.warn('magic-alerts', `${label} URL has embedded credentials — ignoring`);
    return null;
  }
  const host = u.hostname.toLowerCase();
  // Block loopback, link-local, .local mDNS, and obvious private ranges.
  const blocked =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.startsWith('127.') ||
    host.startsWith('169.254.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith('.local');
  if (blocked) {
    log.warn('magic-alerts', `${label} URL points to a private host — ignoring`);
    return null;
  }
  return u.toString();
}

export class MagicAlertMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private state = new Map<string, PositionRiskState>();
  private interval: number;
  private telegram?: { botToken: string; chatId: string };
  private discord?: { webhookUrl: string };
  private ticking = false;

  constructor(private readonly client: MagicTradeClient, cfg?: MagicAlertConfig) {
    this.interval = cfg?.intervalMs ?? 60_000;
    this.telegram = cfg?.telegram ?? this.telegramFromEnv();
    const discord = cfg?.discord ?? this.discordFromEnv();
    if (discord) {
      const validated = validateWebhookUrl(discord.webhookUrl, 'discord');
      this.discord = validated ? { webhookUrl: validated } : undefined;
    }
  }

  private telegramFromEnv(): { botToken: string; chatId: string } | undefined {
    const t = process.env.MAGIC_ALERTS_TG_BOT_TOKEN;
    const c = process.env.MAGIC_ALERTS_TG_CHAT_ID;
    return t && c ? { botToken: t, chatId: c } : undefined;
  }

  private discordFromEnv(): { webhookUrl: string } | undefined {
    const u = process.env.MAGIC_ALERTS_DISCORD_WEBHOOK;
    return u ? { webhookUrl: u } : undefined;
  }

  start(): void {
    if (this.timer) return;
    void this.runTick();
    this.timer = setInterval(() => void this.runTick(), this.interval);
    this.timer.unref?.();
    log.info('magic-alerts', `started — interval=${this.interval}ms tg=${!!this.telegram} discord=${!!this.discord}`);
  }

  /**
   * Re-entrancy guard. setInterval(async) does not wait for the previous tick
   * to finish, so a slow webhook (5s timeout × N alerts) can pile up overlapping
   * ticks. Skip if a tick is already in flight.
   */
  private async runTick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tick();
    } catch (err) {
      log.warn('magic-alerts', `tick failed: ${getErrorMessage(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    log.info('magic-alerts', 'stopped');
  }

  hasOutbound(): boolean {
    return Boolean(this.telegram || this.discord);
  }

  /** Public for `magic alerts status` to surface current state. */
  snapshot(): PositionRiskState[] {
    return Array.from(this.state.values());
  }

  private async tick(): Promise<void> {
    let positions: Awaited<ReturnType<MagicTradeClient['getPositions']>>;
    try {
      positions = await this.client.getPositions();
    } catch (err) {
      log.warn('magic-alerts', `getPositions failed: ${getErrorMessage(err)}`);
      return;
    }
    const seenKeys = new Set<string>();
    for (const p of positions) {
      const key = `${p.market}:${p.side}`;
      seenKeys.add(key);
      if (!Number.isFinite(p.liquidationPrice) || p.liquidationPrice <= 0 || !Number.isFinite(p.markPrice) || p.markPrice <= 0) {
        continue;
      }
      // Distance to liq as fraction of entry. Long: lower mark = closer. Short: higher mark = closer.
      const denom = p.entryPrice > 0 ? p.entryPrice : p.markPrice;
      const rawDistance = p.side === 'long'
        ? (p.markPrice - p.liquidationPrice) / denom
        : (p.liquidationPrice - p.markPrice) / denom;
      const distance = Math.max(0, rawDistance);
      const prev = this.state.get(key);
      const level = this.computeLevel(prev?.level, distance);
      if (!prev || prev.level !== level) {
        this.state.set(key, { key, level, lastDistance: distance, lastChangeAt: Date.now() });
        if (level !== 'SAFE') {
          await this.dispatchAlert(p.market, p.side, level, distance, p.markPrice, p.liquidationPrice);
        } else if (prev && prev.level !== 'SAFE') {
          await this.dispatchAlert(p.market, p.side, 'SAFE', distance, p.markPrice, p.liquidationPrice);
        }
      } else {
        // No level change — refresh distance only
        this.state.set(key, { ...prev, lastDistance: distance });
      }
    }
    // Drop closed positions from state
    for (const k of Array.from(this.state.keys())) {
      if (!seenKeys.has(k)) this.state.delete(k);
    }
  }

  private computeLevel(prev: Level | undefined, distance: number): Level {
    // Recovery thresholds wider to add hysteresis.
    if (prev === 'CRITICAL') {
      if (distance >= 0.18) return 'WARNING';
      return 'CRITICAL';
    }
    if (prev === 'WARNING') {
      if (distance >= 0.35) return 'SAFE';
      if (distance < 0.15) return 'CRITICAL';
      return 'WARNING';
    }
    // From SAFE or unknown
    if (distance < 0.15) return 'CRITICAL';
    if (distance < 0.30) return 'WARNING';
    return 'SAFE';
  }

  private async dispatchAlert(
    market: string,
    side: string,
    level: Level,
    distance: number,
    mark: number,
    liq: number,
  ): Promise<void> {
    const emoji = level === 'CRITICAL' ? '🚨' : level === 'WARNING' ? '⚠️' : '✅';
    const pct = (distance * 100).toFixed(1);
    const text = `${emoji} Magic ${level}: ${market} ${side} — distance to liq ${pct}% (mark $${mark.toFixed(4)}, liq $${liq.toFixed(4)})`;

    // Webhook fetches MUST time out — without a deadline a hanging webhook
    // would stall the alert loop, which runs on the trade hot path's tick.
    if (this.telegram) {
      try {
        const url = `https://api.telegram.org/bot${this.telegram.botToken}/sendMessage`;
        await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: this.telegram.chatId, text }),
          signal: AbortSignal.timeout(5_000),
        });
      } catch (err) {
        // Strip the bot token from the error message — fetch errors often
        // include the failing URL, and the token is in the URL path.
        const safe = redactBotToken(getErrorMessage(err), this.telegram.botToken);
        log.warn('magic-alerts', `telegram send failed: ${safe}`);
      }
    }
    if (this.discord) {
      try {
        await fetch(this.discord.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: text }),
          signal: AbortSignal.timeout(5_000),
        });
      } catch (err) {
        // Discord webhook URLs include a secret token; redact the whole URL.
        const safe = getErrorMessage(err).replace(this.discord.webhookUrl, '<discord-webhook>');
        log.warn('magic-alerts', `discord send failed: ${safe}`);
      }
    }
  }
}

function redactBotToken(message: string, token: string): string {
  return message.split(token).join('<bot-token>');
}

let _global: MagicAlertMonitor | null = null;

export function startMagicAlerts(client: MagicTradeClient): MagicAlertMonitor {
  if (_global) _global.stop();
  _global = new MagicAlertMonitor(client);
  _global.start();
  return _global;
}

export function stopMagicAlerts(): void {
  if (_global) _global.stop();
  _global = null;
}

export function getMagicAlerts(): MagicAlertMonitor | null {
  return _global;
}
