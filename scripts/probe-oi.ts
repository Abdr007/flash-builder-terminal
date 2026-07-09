/**
 * Diagnostic — fetch ALL markets from L1 + ER and print sizeUsd per market.
 * Tells us which side has real OI data so the monitor can read from the right
 * source.  Run:  `npx tsx scripts/probe-oi.ts`
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { MagicTradePerpetualsClient, PoolConfig as MagicPoolConfig, MAGIC_TRADE_IDL } from '@flash_trade/magic-trade-client';
import { homedir } from 'os';
import { readFileSync } from 'fs';
import { join } from 'path';

const L1 = process.env.MAGIC_L1_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const ER = process.env.MAGIC_RPC_URL ?? 'https://flashtrade.magicblock.app/';

async function main() {
  const wallet = Keypair.generate();
  const conn = new Connection(L1, 'confirmed');
  const provider = new AnchorProvider(conn, new Wallet(wallet), { commitment: 'confirmed' });
  const pc = MagicPoolConfig.fromIdsByName('Pool.0', 'mainnet-beta');
  const sdk = new MagicTradePerpetualsClient(
    provider,
    MAGIC_TRADE_IDL as never,
    new PublicKey(pc.programId),
    {},
    ER,
  );

  const sources: Array<['L1', typeof sdk.accounts] | ['ER', typeof sdk.erAccounts]> = [
    ['L1', sdk.accounts],
    ...(sdk.erAccounts ? [['ER', sdk.erAccounts] as ['ER', typeof sdk.erAccounts]] : []),
  ];

  for (const [label, src] of sources) {
    if (!src) continue;
    process.stdout.write(`\n--- ${label} fetchAllMarkets ---\n`);
    try {
      const ms = await src.fetchAllMarkets(pc.poolId);
      process.stdout.write(`  count: ${ms.length}\n`);
      let nonZero = 0;
      for (const m of ms) {
        const sz = (m as unknown as { collectivePosition?: { sizeUsd?: { toString(): string } } }).collectivePosition?.sizeUsd;
        const sizeStr = sz ? sz.toString() : 'undefined';
        const sideStr = typeof m.side === 'string' ? m.side : Object.keys(m.side as object)[0];
        const target = (m as unknown as { targetCustody: PublicKey }).targetCustody.toBase58().slice(0, 6);
        if (sizeStr !== '0' && sizeStr !== 'undefined') nonZero++;
        if (sizeStr !== '0' && sizeStr !== 'undefined') {
          process.stdout.write(`  target=${target} side=${sideStr} sizeUsd=${sizeStr}\n`);
        }
      }
      process.stdout.write(`  non-zero markets: ${nonZero} / ${ms.length}\n`);
    } catch (err) {
      process.stdout.write(`  ERROR: ${(err as Error).message}\n`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
