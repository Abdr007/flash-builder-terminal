/**
 * Regression tests for the audit's MEDIUM: the blockhash-expiry auto-retry must
 * not double-submit. A funds op (deposit/withdraw) is NEVER blind-retried; a
 * trading op is retried only when the original signature is provably not
 * on-chain.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Connection, Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { FlashV2BuilderClient } from '../src/client/flash-v2-builder.js';
import { initSigningGuard } from '../src/security/signing-guard.js';

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const EXPIRY = 'TransactionExpiredBlockheightExceededError: block height exceeded';

function txB64(payer: Keypair): string {
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: [],
  }).compileToV0Message());
  return Buffer.from(tx.serialize()).toString('base64');
}

beforeEach(() => initSigningGuard({ maxLeverage: 0, maxCollateralPerTrade: 0, maxPositionSize: 0, maxTradesPerMinute: 0, minDelayBetweenTradesMs: 0 }));
afterEach(() => vi.restoreAllMocks());

describe('blockhash-expiry retry never double-submits', () => {
  it('funds op (deposit) is never blind-retried on expiry', async () => {
    const owner = Keypair.generate();
    const buildFetch = vi.fn(async () => new Response(JSON.stringify({ transactionBase64: txB64(owner) }), { status: 200 }));
    vi.stubGlobal('fetch', buildFetch);
    const sendRaw = vi.spyOn(connection, 'sendRawTransaction').mockRejectedValue(new Error(EXPIRY));

    const client = new FlashV2BuilderClient({ baseUrl: 'https://flashapi.trade', l1Connection: connection });
    await expect(
      client.signAndSubmit('deposit', { owner: owner.publicKey.toBase58(), tokenSymbol: 'USDC', amount: '1' }, [owner], { retryExpiredBlockhash: true }),
    ).rejects.toThrow(/block height/);

    expect(buildFetch).toHaveBeenCalledTimes(1); // built once — no rebuild/resubmit
    expect(sendRaw).toHaveBeenCalledTimes(1);    // submitted at most once
  });

  it('trading op is NOT resubmitted if the original already landed', async () => {
    const owner = Keypair.generate();
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('submit-transaction')) throw new Error(EXPIRY);
      return new Response(JSON.stringify({ transactionBase64: txB64(owner) }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    // The signature IS on-chain → must not resubmit.
    vi.spyOn(connection, 'getSignatureStatus').mockResolvedValue({ value: { slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' } } as never);

    const client = new FlashV2BuilderClient({ baseUrl: 'https://flashapi.trade', l1Connection: connection });
    await expect(
      client.signAndSubmit('openPosition', { inputTokenSymbol: 'USDC', outputTokenSymbol: 'SOL', inputAmountUi: '5', leverage: 2, tradeType: 'LONG', owner: owner.publicKey.toBase58() }, [owner], { retryExpiredBlockhash: true }),
    ).rejects.toThrow(/block height/);

    const builds = fetchMock.mock.calls.filter((c) => String(c[0]).includes('open-position')).length;
    expect(builds).toBe(1); // landed → not rebuilt
  });

  it('trading op IS retried once when provably not on-chain', async () => {
    const owner = Keypair.generate();
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('submit-transaction')) throw new Error(EXPIRY);
      return new Response(JSON.stringify({ transactionBase64: txB64(owner) }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(connection, 'getSignatureStatus').mockResolvedValue({ value: null } as never); // not found

    const client = new FlashV2BuilderClient({ baseUrl: 'https://flashapi.trade', l1Connection: connection });
    await expect(
      client.signAndSubmit('openPosition', { inputTokenSymbol: 'USDC', outputTokenSymbol: 'SOL', inputAmountUi: '5', leverage: 2, tradeType: 'LONG', owner: owner.publicKey.toBase58() }, [owner], { retryExpiredBlockhash: true }),
    ).rejects.toThrow(/block height/);

    const builds = fetchMock.mock.calls.filter((c) => String(c[0]).includes('open-position')).length;
    expect(builds).toBe(2); // not on-chain → rebuilt exactly once more
  });
});
