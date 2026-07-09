/**
 * Magic-mode session stats — tracked in memory and rendered below every
 * magic command's output so the CLI feels alive between trades.
 *
 * Tracks: trade count, win/loss tally, last trade size, ER health.
 * No persistence — each terminal session starts fresh.
 */

import chalk from 'chalk';
import { getErHealthMonitor } from '../monitor/magic-er-health.js';

interface SessionStats {
  trades: number;
  opens: number;
  closes: number;
  wins: number;
  losses: number;
  realizedPnlUsd: number;
  lastTradeAt: number;
}

const stats: SessionStats = {
  trades: 0,
  opens: 0,
  closes: 0,
  wins: 0,
  losses: 0,
  realizedPnlUsd: 0,
  lastTradeAt: 0,
};

export function recordMagicAction(opts: {
  type: 'open' | 'close' | 'add' | 'remove' | 'tp' | 'sl' | 'limit' | 'reverse' | 'increase' | 'decrease' | 'liquidate' | 'settle' | 'deposit' | 'withdraw';
  pnlUsd?: number;
}): void {
  stats.trades += 1;
  if (opts.type === 'open' || opts.type === 'reverse' || opts.type === 'increase' || opts.type === 'limit') stats.opens += 1;
  if (opts.type === 'close' || opts.type === 'decrease') stats.closes += 1;
  if (opts.pnlUsd !== undefined) {
    stats.realizedPnlUsd += opts.pnlUsd;
    if (opts.pnlUsd > 0) stats.wins += 1;
    else if (opts.pnlUsd < 0) stats.losses += 1;
  }
  stats.lastTradeAt = Date.now();
}

export function getSessionStats(): SessionStats {
  return { ...stats };
}

export function resetSessionStats(): void {
  stats.trades = 0;
  stats.opens = 0;
  stats.closes = 0;
  stats.wins = 0;
  stats.losses = 0;
  stats.realizedPnlUsd = 0;
  stats.lastTradeAt = 0;
}

/**
 * Render a single-line session footer. Intended to print right under the
 * trade card so the user always sees their session state.
 *
 *   session · 4 trades · 2 opens · 2 closes · pnl +$5.40 · ER ● 142ms
 */
export function renderSessionFooter(): string {
  const er = getErHealthMonitor()?.snapshot();
  const dot = er?.healthy ? chalk.green('●') : chalk.red('●');
  const erRtt = er ? chalk.dim(`${er.lastRttMs}ms`) : chalk.dim('—');
  const pnl = stats.realizedPnlUsd;
  const pnlStr = pnl > 0 ? chalk.green(`+$${pnl.toFixed(2)}`) : pnl < 0 ? chalk.red(`-$${Math.abs(pnl).toFixed(2)}`) : chalk.dim('$0.00');

  if (stats.trades === 0) {
    // First-trade hint — minimal but reassuring
    return `  ${chalk.dim('session ·')} ${chalk.dim('ready')} ${chalk.dim('·')} ER ${dot} ${erRtt}`;
  }

  const parts: string[] = [
    chalk.dim('session ·'),
    chalk.bold(`${stats.trades} cmds`),
  ];
  if (stats.opens > 0) parts.push(chalk.dim('·'), `${chalk.bold(stats.opens)} ${chalk.dim('open')}`);
  if (stats.closes > 0) parts.push(chalk.dim('·'), `${chalk.bold(stats.closes)} ${chalk.dim('close')}`);
  if (stats.wins + stats.losses > 0) {
    parts.push(chalk.dim('·'), `${chalk.green(stats.wins)}W ${chalk.red(stats.losses)}L`);
    parts.push(chalk.dim('·'), pnlStr);
  }
  parts.push(chalk.dim('·'), `ER ${dot} ${erRtt}`);
  return '  ' + parts.join(' ');
}
