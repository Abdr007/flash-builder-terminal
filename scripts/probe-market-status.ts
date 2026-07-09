/** Verify per-market open/closed inference from Pyth publish staleness. */
import { getPythService } from '../src/data/pyth-prices.js';

async function main() {
  const pyth = getPythService();
  await pyth.init();

  const tickers = [
    'Crypto.SOL/USD', 'Crypto.BTC/USD', 'Crypto.ETH/USD',
    'Equity.US.AAPL/USD', 'Equity.US.TSLA/USD', 'Equity.US.NVDA/USD', 'Equity.US.SPY/USD',
    'FX.EUR/USD', 'FX.GBP/USD', 'FX.USD/JPY',
    'Metal.XAU/USD', 'Metal.XAG/USD',
    'Commodities.WTI1', 'Commodities.NG1',
  ];

  const map = await pyth.getPrices(tickers);
  process.stdout.write(`\n  Ticker                          Price       Stale     Status\n`);
  process.stdout.write(`  ───────────────────────────────────────────────────────────\n`);
  for (const t of tickers) {
    const p = map.get(t);
    if (!p) {
      process.stdout.write(`  ${t.padEnd(30)}  (no feed)\n`);
      continue;
    }
    const stale = p.staleSeconds < 0 ? 'unknown'
      : p.staleSeconds < 60 ? `${p.staleSeconds}s`
      : p.staleSeconds < 3600 ? `${Math.round(p.staleSeconds / 60)}m`
      : `${Math.round(p.staleSeconds / 3600)}h`;
    const status = p.staleSeconds < 0 ? '?'
      : p.staleSeconds <= 60 ? 'OPEN'
      : p.staleSeconds > 600 ? 'CLOSED'
      : 'OPEN (slow)';
    process.stdout.write(`  ${t.padEnd(30)}  ${('$' + p.price.toFixed(2)).padEnd(10)}  ${stale.padEnd(8)}  ${status}\n`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
