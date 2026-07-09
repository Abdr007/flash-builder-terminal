/**
 * PoolConfig parse cache.
 *
 * `PoolConfig.fromIdsByName(poolName, cluster)` walks the bundled JSON,
 * decodes the program ID, builds 27 custody/market objects with PublicKey
 * instances. ~10ms cold; we hit it from at least 4 call sites every boot.
 *
 * The result is fully deterministic given (poolName, cluster), so a single
 * module-level cache is correct. Two competing instances with the same key
 * would be functionally identical anyway, but only one needs to exist.
 */

import { PoolConfig } from '@flash_trade/magic-trade-client';

const cache = new Map<string, PoolConfig>();

export function getPoolConfig(poolName: string, cluster: 'mainnet-beta' | 'devnet'): PoolConfig {
  const key = `${cluster}:${poolName}`;
  let pc = cache.get(key);
  if (pc) return pc;
  pc = PoolConfig.fromIdsByName(poolName, cluster);
  cache.set(key, pc);
  return pc;
}

/** Clear the cache. Used by tests or by tooling that swaps pools at runtime. */
export function clearPoolConfigCache(): void {
  cache.clear();
}
