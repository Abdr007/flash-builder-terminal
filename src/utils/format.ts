/**
 * Number / string formatters for the Magic Terminal UI.
 *
 * Uses Decimal.js for precision-sensitive aggregation (PnL, balances) and
 * Number for display formatting. Always strips negative zero and clamps
 * subdollar drift below 0.005 to 0 to keep the UI clean.
 */

import chalk from 'chalk';
import { Decimal } from 'decimal.js';
import type { TradeSide } from '../types/index.js';

const SIDE_LONG = 'long';

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return 'N/A';
  const v = Math.abs(value) < 0.005 ? 0 : value;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`;
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatUsdExact(value: number): string {
  if (!Number.isFinite(value)) return 'N/A';
  const v = Math.abs(value) < 0.005 ? 0 : value;
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return 'N/A';
  if (value >= 1000) return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (value >= 1) return `$${value.toFixed(4)}`;
  if (value >= 0.0001) return `$${value.toFixed(6)}`;
  return `$${value.toExponential(2)}`;
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return 'N/A';
  // Lower the dead-zone to 0.0005% (0.5 bps). Anything above this is a real
  // move and should be visible; anything below is below the precision of
  // `.toFixed(2)` so it'd round to 0.00 anyway. The previous threshold
  // (0.005% = 0.5%) was hiding legitimate micro-moves on the monitor's
  // 24h-change column for low-volatility FX pairs.
  const v = Math.abs(value) < 0.0005 ? 0 : value;
  const sign = v > 0 ? '+' : v < 0 ? '' : '+';
  // Show 2 decimals normally; for sub-bp values display 4 so the user
  // sees something other than 0.00.
  const decimals = Math.abs(v) >= 0.01 ? 2 : 4;
  return `${sign}${v.toFixed(decimals)}%`;
}

export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  // Always seconds with 2 decimals — uniform with `latencyPill` so
  // dashboards mixing both don't show different units side-by-side.
  // Beyond 10s we drop to 1 decimal (header noise).
  const seconds = ms / 1000;
  return ms < 10_000 ? `${seconds.toFixed(2)}s` : `${seconds.toFixed(1)}s`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

export function colorPnl(value: number): string {
  const formatted = formatUsd(value);
  if (value > 0) return chalk.green(formatted);
  if (value < 0) return chalk.red(formatted);
  return chalk.dim(formatted);
}

export function colorPercent(value: number): string {
  const formatted = formatPercent(value);
  if (value > 0) return chalk.green(formatted);
  if (value < 0) return chalk.red(formatted);
  return chalk.dim(formatted);
}

export function colorSide(side: TradeSide | string): string {
  const isLong = String(side).toLowerCase() === SIDE_LONG;
  return isLong ? chalk.green.bold('LONG') : chalk.red.bold('SHORT');
}

export function shortAddress(address: string): string {
  if (!address || address.length <= 10) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Strip ANSI escape codes for accurate visible-width measurement.
 * Covers SGR (color) and CSI cursor codes.
 */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\[[0-9;]*[a-zA-Z]/g, '');
}

export function visibleLength(str: string): number {
  return stripAnsi(str).length;
}

export function padVisible(str: string, width: number): string {
  const pad = width - visibleLength(str);
  return pad > 0 ? str + ' '.repeat(pad) : str;
}

export function padVisibleStart(str: string, width: number): string {
  const pad = width - visibleLength(str);
  return pad > 0 ? ' '.repeat(pad) + str : str;
}

/** Sum a list of decimals safely without floating-point drift. */
export function sumDecimal(values: number[]): number {
  return values
    .reduce((acc, v) => (Number.isFinite(v) ? acc.plus(v) : acc), new Decimal(0))
    .toNumber();
}

/**
 * Convert raw SDK errors (often containing native token amounts at 6 decimals)
 * into human-friendly messages with USD values.
 */
export function humanizeSdkError(msg: string, collateral?: number, leverage?: number): string {
  const insufficientMatch = msg.match(/[Ii]nsufficient\s+[Ff]unds.*?need\s+more\s+(\d+)\s+tokens?/);
  if (insufficientMatch) {
    const rawAmount = parseInt(insufficientMatch[1], 10);
    if (Number.isFinite(rawAmount) && rawAmount > 0) {
      const usdAmount = rawAmount / 1_000_000;
      const parts: string[] = [`Insufficient funds — need ${formatUsd(usdAmount)} more USDC`];
      if (collateral && leverage) {
        const fees = (collateral * leverage * 8) / 10_000;
        parts.push(`(${formatUsd(collateral)} collateral + ~${formatUsd(fees)} fees at ${leverage}x)`);
      }
      return parts.join(' ');
    }
  }

  const needMoreMatch = msg.match(/need\s+more\s+(\d{6,})/);
  if (needMoreMatch) {
    const rawAmount = parseInt(needMoreMatch[1], 10);
    if (Number.isFinite(rawAmount) && rawAmount > 0) {
      const usdAmount = rawAmount / 1_000_000;
      return msg.replace(needMoreMatch[0], `need ${formatUsd(usdAmount)} more`);
    }
  }

  if (/InsufficientFunds|insufficient\s+funds/i.test(msg)) {
    return "Insufficient funds. Check USDC balance with 'wallet tokens'.";
  }
  if (/\b0x1\b|InsufficientBalance/i.test(msg)) {
    return 'Insufficient SOL for transaction fees. Top up your wallet.';
  }
  if (/MarketClosed/i.test(msg)) {
    return "Market is currently closed. Check 'markets'.";
  }
  if (/blockhash\s+not\s+found/i.test(msg)) {
    return 'Stale blockhash — retrying with a fresh one.';
  }
  return msg;
}
