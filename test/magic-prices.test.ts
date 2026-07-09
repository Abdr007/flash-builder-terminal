import { afterEach, describe, expect, it, vi } from 'vitest';
import { magicPrices } from '../src/tools/magic-tools.js';
import type { MagicConfig, ToolContext } from '../src/types/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const config: MagicConfig = {
  network: 'mainnet-beta',
  poolName: 'Pool.0',
  erRpcUrl: 'https://flashtrade.magicblock.app/',
  flashApiUrl: 'https://flashapi.trade',
  l1RpcUrl: 'https://api.mainnet-beta.solana.com',
  walletPath: '~/.config/solana/id.json',
  computeUnitPrice: 0,
  autoConfirm: true,
  fastConfirm: true,
  maxCollateralPerTrade: 0,
  maxPositionSize: 0,
  maxLeverage: 0,
  maxTradesPerMinute: 0,
  minDelayBetweenTradesMs: 0,
};

const context: ToolContext = {
  walletManager: { getKeypair: () => null } as ToolContext['walletManager'],
  config,
};

describe('magicPrices', () => {
  it('preserves symbol labels when /prices returns a keyed object', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      SOL: { priceUi: 77.0819 },
      BTC: { priceUi: 62183.76 },
    }), { status: 200 })));

    const result = await magicPrices.execute({}, context);
    expect(result.success).toBe(true);
    expect(result.message).toContain('SOL');
    expect(result.message).toContain('BTC');
    expect(result.message).toContain('$77.0819');
    expect(result.message).toContain('$62,183.76');
  });
});
