/** Verify the trading-side market-hours gate. */
import { getPythService } from '../src/data/pyth-prices.js';

async function main() {
  const pyth = getPythService();
  await pyth.init();

  const tickers = [
    'Crypto.SOL/USD', 'Crypto.BTC/USD',
    'Equity.US.AAPL/USD', 'Equity.US.TSLA/USD',
    'FX.EUR/USD', 'FX.USD/JPY',
    'Metal.XAU/USD',
  ];

  for (const t of tickers) {
    const status = await pyth.isMarketOpen(t);
    const hint = pyth.marketHoursHint(t);
    const verdict = status.open ? 'OPEN' : 'CLOSED';
    process.stdout.write(`${t.padEnd(28)} ${verdict.padEnd(7)} stale=${status.staleSeconds}s\n`);
    if (!status.open) process.stdout.write(`  → ${hint.hours} — ${hint.nextOpen}\n`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
