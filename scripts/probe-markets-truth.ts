/**
 * Cross-check: read mainnet Pool.0 directly from the SDK's bundled config
 * and dump every (target, side, lockSymbol, maxLev, degenMaxLev) tuple so
 * we can verify the `magic markets` command isn't misreporting anything.
 *
 * Run:  npx tsx scripts/probe-markets-truth.ts
 */
import { PoolConfig } from '@flash_trade/magic-trade-client';

function main(): void {
  const pc = PoolConfig.fromIdsByName('Pool.0', 'mainnet-beta');
  const rows: Array<{
    target: string;
    side: string;
    lockSym: string;
    maxLev: number;
    degenMaxLev: number;
  }> = [];
  for (const m of pc.markets) {
    const target = pc.custodies.find((c) => c.custodyAccount.equals(m.targetCustody));
    const lock = pc.custodies.find((c) => c.custodyAccount.equals(m.collateralCustody));
    if (!target) continue;
    const side = typeof m.side === 'string' ? m.side : Object.keys(m.side as object)[0];
    rows.push({
      target: target.symbol,
      side,
      lockSym: lock?.symbol ?? '?',
      maxLev: (m as { maxLev: number }).maxLev,
      degenMaxLev: (m as { degenMaxLev: number }).degenMaxLev,
    });
  }
  rows.sort((a, b) => a.target.localeCompare(b.target) || a.side.localeCompare(b.side));
  process.stdout.write(`pool=${pc.poolName} program=${pc.programId} markets=${rows.length}\n`);
  process.stdout.write(`target  side    lock    max   degen\n`);
  for (const r of rows) {
    process.stdout.write(
      `${r.target.padEnd(8)}${r.side.padEnd(8)}${r.lockSym.padEnd(8)}${String(r.maxLev).padStart(4)}x  ${String(r.degenMaxLev).padStart(4)}x\n`,
    );
  }
}
main();
