import { afterEach, describe, expect, it, vi } from 'vitest';
import { magicBasketStream } from '../src/tools/magic-tools.js';
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

describe('magicBasketStream', () => {
  it('accepts an initial basket frame, counts metrics, and surfaces close info', async () => {
    class FakeWebSocket {
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;
      constructor(_url: string) {
        queueMicrotask(() => {
          this.onmessage?.({ data: JSON.stringify({ type: 'basket', data: { owner: 'owner' } }) });
          this.onmessage?.({ data: JSON.stringify({ type: 'metrics', data: {} }) });
          this.onclose?.({ code: 1000, reason: 'normal' });
        });
      }
      close(): void {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);

    const result = await magicBasketStream.execute({
      owner: 'OwnerPubkey',
      updateIntervalMs: 1000,
      maxMessages: 2,
    }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('First');
    expect(result.message).toContain('basket');
    expect(result.message).toContain('1 basket');
    expect(result.message).toContain('1 metrics');
    expect(result.message).toContain('1000');
    expect(result.message).toContain('normal');
  });

  it('fails when the first received frame is not the required basket snapshot', async () => {
    class FakeWebSocket {
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;
      constructor(_url: string) {
        queueMicrotask(() => {
          this.onmessage?.({ data: JSON.stringify({ type: 'metrics', data: {} }) });
          this.onclose?.({ code: 1008, reason: 'connection limit' });
        });
      }
      close(): void {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);

    const result = await magicBasketStream.execute({
      owner: 'OwnerPubkey',
      updateIntervalMs: 1000,
      maxMessages: 1,
    }, context);

    expect(result.success).toBe(false);
    expect(result.message).toContain('metrics');
    expect(result.message).toContain('connection limit');
    expect(result.message).toContain('1008');
  });
});
