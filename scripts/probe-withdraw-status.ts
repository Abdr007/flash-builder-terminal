#!/usr/bin/env tsx
/**
 * Smoke-test the new `withdraw status` tool end-to-end. Builds a real
 * MagicTradeClient and exercises the same getMultipleAccountsInfo path
 * the tool uses, so any wrapper / SDK shape regression is caught here
 * before a user sees `Cannot read properties of undefined`.
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { MagicTradeClient } from '../src/client/magic-client.js';
import { loadConfig } from '../src/config/index.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const client = new MagicTradeClient({
    wallet: Keypair.generate(),
    l1Connection: new Connection(cfg.l1RpcUrl, 'confirmed'),
    network: cfg.network,
    poolName: cfg.poolName,
    erEndpoint: cfg.erRpcUrl,
    programIdOverride: cfg.programIdOverride,
    fastConfirm: true,
  });
  await new Promise((r) => setTimeout(r, 1500));

  const wrap = client as unknown as { l1Connection: Connection; programId: PublicKey };
  if (!wrap.l1Connection || typeof wrap.l1Connection.getMultipleAccountsInfo !== 'function') {
    throw new Error('client.l1Connection missing or not a Connection');
  }
  if (!wrap.programId || typeof wrap.programId.toBase58 !== 'function') {
    throw new Error('client.programId missing or not a PublicKey');
  }

  const custodies = client.poolConfig.custodies;
  const keys = custodies.map((cu) => cu.custodyAccount);
  const infos = await wrap.l1Connection.getMultipleAccountsInfo(keys, 'confirmed');
  const flashId = wrap.programId.toBase58();
  const ER_ID = 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh';

  let ready = 0, delegated = 0, unknown = 0;
  for (let i = 0; i < custodies.length; i++) {
    const info = infos[i];
    const owner = info?.owner.toBase58() ?? '<missing>';
    const status = !info ? 'missing' : owner === flashId ? 'ready' : owner === ER_ID ? 'delegated' : 'unknown';
    if (status === 'ready') ready++;
    else if (status === 'delegated') delegated++;
    else unknown++;
    process.stdout.write(`  ${custodies[i].symbol.padEnd(10)} ${status.padEnd(10)} ${owner}\n`);
  }
  process.stdout.write(`\n  ${ready} ready · ${delegated} delegated · ${unknown} unknown · ${custodies.length} total\n`);
  process.exit(0);
}

main().catch((err) => { process.stderr.write(`probe failed: ${err instanceof Error ? err.stack : String(err)}\n`); process.exit(1); });
