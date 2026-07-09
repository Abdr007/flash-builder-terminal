/** End-to-end check: separated timings, USDC filtered, ER OI flowing. */
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { MagicTradePerpetualsClient, PoolConfig as MagicPoolConfig, MAGIC_TRADE_IDL } from '@flash_trade/magic-trade-client';
import { getPythService } from '../src/data/pyth-prices.js';

async function main() {
  const wallet = Keypair.generate();
  const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  const provider = new AnchorProvider(conn, new Wallet(wallet), { commitment: 'confirmed' });
  const pc = MagicPoolConfig.fromIdsByName('Pool.0', 'mainnet-beta');
  const sdk = new MagicTradePerpetualsClient(provider, MAGIC_TRADE_IDL as never, new PublicKey(pc.programId), {}, 'https://flashtrade.magicblock.app/');
  const erConn = (sdk as unknown as { erConnection: Connection }).erConnection;
  const erAccs = (sdk as unknown as { erAccounts: { fetchAllMarkets: (id: number) => Promise<unknown[]> } }).erAccounts;
  const pyth = getPythService();
  await pyth.init();

  const targetSet = new Set(pc.markets.map((m) => m.targetCustody.toBase58()));
  const filteredCustodies = pc.custodies.filter((cu) => cu.pythTicker && targetSet.has(cu.custodyAccount.toBase58()));
  const tickers = filteredCustodies.map((cu) => cu.pythTicker!);

  process.stdout.write(`Filtered (target-only) symbols: ${filteredCustodies.length}\n`);
  process.stdout.write(`  Symbols: ${filteredCustodies.map((cu) => cu.symbol).join(', ')}\n`);
  process.stdout.write(`  USDC excluded: ${!filteredCustodies.find((cu) => cu.symbol === 'USDC')}\n\n`);

  const timed = async <T,>(label: string, p: Promise<T>): Promise<{ value: T; ms: number }> => {
    const t0 = performance.now();
    const value = await p;
    const ms = Math.round(performance.now() - t0);
    process.stdout.write(`  ${label.padEnd(10)} ${ms}ms\n`);
    return { value, ms };
  };

  process.stdout.write(`Per-call timings:\n`);
  const [oracle, markets, rpc] = await Promise.all([
    timed('oracle', pyth.getPrices(tickers).catch(() => new Map())),
    timed('markets', erAccs.fetchAllMarkets.bind(erAccs)(pc.poolId).catch(() => [])),
    timed('rpc', erConn.getSlot('confirmed').catch(() => -1)),
  ]);

  process.stdout.write(`\nResults:\n`);
  process.stdout.write(`  oracle  : ${oracle.value instanceof Map ? oracle.value.size + ' price entries' : 'failed'}\n`);
  process.stdout.write(`  markets : ${Array.isArray(markets.value) ? markets.value.length + ' market accounts' : 'failed'}\n`);
  process.stdout.write(`  rpc/slot: ${rpc.value}\n`);
}
main().catch((e) => { console.error(e); process.exit(1); });
