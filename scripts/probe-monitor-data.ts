/**
 * End-to-end probe — replicates exactly what the monitor does after the
 * binding fix. If this prints non-zero OI per asset, the monitor will too.
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { MagicTradePerpetualsClient, PoolConfig as MagicPoolConfig, MAGIC_TRADE_IDL } from '@flash_trade/magic-trade-client';

const L1 = process.env.MAGIC_L1_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const ER = process.env.MAGIC_RPC_URL ?? 'https://flashtrade.magicblock.app/';
const USD_POWER = 1_000_000;

async function main() {
  const wallet = Keypair.generate();
  const conn = new Connection(L1, 'confirmed');
  const provider = new AnchorProvider(conn, new Wallet(wallet), { commitment: 'confirmed' });
  const pc = MagicPoolConfig.fromIdsByName('Pool.0', 'mainnet-beta');
  const sdk = new MagicTradePerpetualsClient(provider, MAGIC_TRADE_IDL as never, new PublicKey(pc.programId), {}, ER);

  const sdkAny = sdk as unknown as {
    erAccounts: { fetchAllMarkets?: (poolId: number) => Promise<unknown[]> } | null;
    accounts: { fetchAllMarkets: (poolId: number) => Promise<unknown[]> };
  };
  const marketFetcher = sdkAny.erAccounts?.fetchAllMarkets
    ? sdkAny.erAccounts.fetchAllMarkets.bind(sdkAny.erAccounts)
    : sdkAny.accounts.fetchAllMarkets.bind(sdkAny.accounts);

  const markets = await marketFetcher(pc.poolId);
  process.stdout.write(`fetched ${markets.length} markets\n`);

  // Aggregate by target → long/short USD
  const byTarget = new Map<string, { long: number; short: number }>();
  for (const m of markets as Array<{ targetCustody: PublicKey; side: string | object; collectivePosition?: { sizeUsd?: { toString(): string } } }>) {
    const sizeRaw = m.collectivePosition?.sizeUsd ? Number(m.collectivePosition.sizeUsd.toString()) : 0;
    if (sizeRaw <= 0) continue;
    const sideStr = (typeof m.side === 'string' ? m.side : Object.keys(m.side as object)[0] ?? '').toLowerCase();
    const key = m.targetCustody.toBase58();
    const cur = byTarget.get(key) ?? { long: 0, short: 0 };
    if (sideStr === 'short') cur.short += sizeRaw / USD_POWER;
    else cur.long += sizeRaw / USD_POWER;
    byTarget.set(key, cur);
  }

  // Map each target custody → symbol
  const symByCustody = new Map<string, string>();
  for (const cu of pc.custodies) symByCustody.set(cu.custodyAccount.toBase58(), cu.symbol);

  process.stdout.write(`\n  Symbol      Long OI         Short OI       Total OI       Long%\n`);
  process.stdout.write(`  ──────────────────────────────────────────────────────────────────\n`);
  const rows = [...byTarget.entries()].map(([cust, oi]) => ({
    symbol: symByCustody.get(cust) ?? cust.slice(0, 8),
    long: oi.long,
    short: oi.short,
    total: oi.long + oi.short,
  })).sort((a, b) => b.total - a.total);
  for (const r of rows) {
    const longPct = r.total > 0 ? Math.round((r.long / r.total) * 100) : 50;
    process.stdout.write(
      `  ${r.symbol.padEnd(10)}  ${'$' + r.long.toFixed(2).padStart(12)}  ${'$' + r.short.toFixed(2).padStart(12)}  ` +
      `${'$' + r.total.toFixed(2).padStart(12)}   ${String(longPct) + '%'}\n`,
    );
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
