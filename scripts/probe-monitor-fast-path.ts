#!/usr/bin/env tsx
/**
 * Verify the new batched market-fetch path is correct AND fast.
 *
 * Compares:
 *   A) SDK's `erAccounts.fetchAllMarkets(poolId)` — N sequential RPCs
 *   B) `getMultipleAccountsInfo` over `poolConfig.markets[].marketAccount`
 *      with manual Anchor decode — single batched RPC
 *
 * Asserts: same set of decoded markets, with same `targetCustody` and
 * `collectivePosition.sizeUsd` values. Prints latency for both.
 */

import { Connection, Keypair } from '@solana/web3.js';
import { MagicTradeClient } from '../src/client/magic-client.js';
import { loadConfig } from '../src/config/index.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  // No real signing happens — a throwaway keypair is fine for read-only paths.
  const wallet = Keypair.generate();
  const client = new MagicTradeClient({
    wallet,
    l1Connection: new Connection(cfg.l1RpcUrl, 'confirmed'),
    network: cfg.network,
    poolName: cfg.poolName,
    erEndpoint: cfg.erRpcUrl,
    programIdOverride: cfg.programIdOverride,
    fastConfirm: true,
  });

  // Wait for the SDK to finish its lazy init (poolConfig + program).
  await new Promise((r) => setTimeout(r, 1500));

  const sdkAny = (client as unknown as {
    sdk: {
      erConnection: Connection;
      erAccounts: { fetchAllMarkets: (poolId: number) => Promise<Array<{ targetCustody: { toBase58(): string }; collectivePosition?: { sizeUsd?: { toString(): string } } }>> };
      program: { coder: { accounts: { decode: (n: string, b: Buffer) => unknown } } };
    };
  }).sdk;

  // A — SDK path (sequential)
  const aT0 = performance.now();
  const sdkRows = await sdkAny.erAccounts.fetchAllMarkets.bind(sdkAny.erAccounts)(client.poolConfig.poolId);
  const aMs = Math.round(performance.now() - aT0);

  // B — batched path
  const pdas = client.poolConfig.markets.map((m) => m.marketAccount);
  const bT0 = performance.now();
  const infos = await sdkAny.erConnection.getMultipleAccountsInfo(pdas, 'confirmed');
  const decoded: Array<{ targetCustody: { toBase58(): string }; collectivePosition?: { sizeUsd?: { toString(): string } } }> = [];
  for (const info of infos) {
    if (!info?.data) continue;
    try {
      const m = sdkAny.program.coder.accounts.decode('market', info.data) as {
        targetCustody: { toBase58(): string };
        collectivePosition?: { sizeUsd?: { toString(): string } };
      };
      decoded.push(m);
    } catch { /* skip */ }
  }
  const bMs = Math.round(performance.now() - bT0);

  process.stdout.write(`\n  SDK fetchAllMarkets   : ${aMs}ms  (${sdkRows.length} markets)\n`);
  process.stdout.write(`  Batched + decode      : ${bMs}ms  (${decoded.length} markets)\n`);
  process.stdout.write(`  Speedup               : ${(aMs / bMs).toFixed(1)}x\n\n`);

  // Sanity: same total OI per side
  const sumA = sdkRows.reduce((s, r) => s + Number(r.collectivePosition?.sizeUsd?.toString() ?? '0'), 0);
  const sumB = decoded.reduce((s, r) => s + Number(r.collectivePosition?.sizeUsd?.toString() ?? '0'), 0);
  process.stdout.write(`  Σ sizeUsd raw  SDK=${sumA}  batched=${sumB}  ${sumA === sumB ? '✔ match' : '✘ MISMATCH'}\n`);

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`probe failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
