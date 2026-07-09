#!/usr/bin/env tsx
/**
 * Quick verification that the Pyth schedule parser correctly classifies
 * a sample of feeds. Walks the live registry, parses every schedule, and
 * spot-checks a few well-known equity / crypto / FX feeds.
 *
 * Run: npx tsx scripts/probe-pyth-schedule.ts
 */

import { getPythService, parseSchedule, evaluateSchedule, describeWeekly } from '../src/data/pyth-prices.js';

async function main(): Promise<void> {
  const pyth = getPythService();
  await pyth.init();

  const samples = [
    'Crypto.SOL/USD',
    'Crypto.BTC/USD',
    'Equity.US.TSLA/USD',
    'Equity.US.AAPL/USD',
    'FX.EUR/USD',
    'Metal.XAU/USD',
    'Commodities.WTI1/USD',
  ];

  for (const ticker of samples) {
    const session = pyth.marketSession(ticker);
    const hint = pyth.marketHoursHint(ticker);
    process.stdout.write(`${ticker.padEnd(28)} ${session.state.padEnd(8)} ${session.label.padEnd(10)}  ${hint.hours}\n`);
    if (hint.nextOpen) process.stdout.write(`${' '.repeat(28)} ${hint.nextOpen}\n`);
  }

  // Sanity-test the parser directly.
  const sample = 'America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;0101/C,1225/C';
  const parsed = parseSchedule(sample);
  if (!parsed) throw new Error('parser returned null on a known-good schedule');
  process.stdout.write(`\nparser sanity:\n  ${describeWeekly(parsed)}\n`);
  const ev = evaluateSchedule(parsed);
  process.stdout.write(`  current state: ${ev.state}${ev.nextOpenIso ? ` (next: ${ev.nextOpenIso})` : ''}\n`);
}

main().catch((err) => {
  process.stderr.write(`probe failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
