/**
 * Magic-mode session stats — tracked in memory across a terminal session.
 * `recordMagicAction` is called after every trade command so the tally stays
 * current. No persistence — each session starts fresh.
 */

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
