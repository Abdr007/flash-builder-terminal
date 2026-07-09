import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { magicBuilder } from '../src/tools/magic-tools.js';
import type { MagicConfig, ToolContext } from '../src/types/index.js';

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

describe('magicBuilder', () => {
  it('fails early when signing open-position without owner', async () => {
    const context: ToolContext = {
      walletManager: { getKeypair: () => Keypair.generate() } as ToolContext['walletManager'],
      config,
    };
    const result = await magicBuilder.execute({
      operation: 'open-position',
      sign: true,
      body: JSON.stringify({
        inputTokenSymbol: 'USDC',
        outputTokenSymbol: 'SOL',
        inputAmountUi: '5',
        leverage: 2,
        tradeType: 'LONG',
      }),
    }, context);

    expect(result.success).toBe(false);
    expect(result.message).toContain('preview-only mode');
    expect(result.message).toContain('owner');
  });

  it('fails early when signing withdraw with a feePayer that does not match the local withdrawal signer', async () => {
    const owner = Keypair.generate();
    const context: ToolContext = {
      walletManager: { getKeypair: () => owner } as ToolContext['walletManager'],
      config,
    };
    const result = await magicBuilder.execute({
      operation: 'withdraw',
      sign: true,
      body: JSON.stringify({
        owner: owner.publicKey.toBase58(),
        tokenSymbol: 'USDC',
        amount: '1',
        feePayer: owner.publicKey.toBase58(),
      }),
    }, context);

    expect(result.success).toBe(false);
    expect(result.message).toContain('body.feePayer');
    expect(result.message).toContain('withdraw');
  });

  it('fails early when signing request-withdrawal with a feePayer that does not match the local withdrawal signer', async () => {
    const owner = Keypair.generate();
    const context: ToolContext = {
      walletManager: { getKeypair: () => owner } as ToolContext['walletManager'],
      config,
    };
    const result = await magicBuilder.execute({
      operation: 'request-withdrawal',
      sign: true,
      body: JSON.stringify({
        owner: owner.publicKey.toBase58(),
        tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        amount: '1',
        feePayer: owner.publicKey.toBase58(),
      }),
    }, context);

    expect(result.success).toBe(false);
    expect(result.message).toContain('body.feePayer');
    expect(result.message).toContain('withdraw');
  });

  it('fails early when signing with a body.owner that does not match the loaded wallet', async () => {
    const owner = Keypair.generate();
    const other = Keypair.generate();
    const context: ToolContext = {
      walletManager: { getKeypair: () => owner } as ToolContext['walletManager'],
      config,
    };
    const result = await magicBuilder.execute({
      operation: 'deposit',
      sign: true,
      body: JSON.stringify({
        owner: other.publicKey.toBase58(),
        tokenSymbol: 'USDC',
        amount: '1',
      }),
    }, context);

    expect(result.success).toBe(false);
    expect(result.message).toContain('body.owner');
    expect(result.message).toContain('loaded wallet');
  });
});
