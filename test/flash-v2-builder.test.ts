import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { Connection, Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { FLASH_V2_BUILDERS, FLASH_V2_PREVIEWS, FlashV2BuilderClient } from '../src/client/flash-v2-builder.js';
import { initSigningGuard } from '../src/security/signing-guard.js';

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

beforeEach(() => {
  // signAndSubmit now funnels through the signing guard. These tests exercise
  // routing/field discipline, not rate limits, and fire several signs in quick
  // succession — init a permissive guard so the default 1s delay / 10-per-min
  // doesn't rate-limit them. (Production always calls initSigningGuard with the
  // user's real caps.)
  initSigningGuard({ maxLeverage: 0, maxCollateralPerTrade: 0, maxPositionSize: 0, maxTradesPerMinute: 0, minDelayBetweenTradesMs: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function serializedV0TxBase64(signer: Keypair): string {
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [],
  }).compileToV0Message());
  return Buffer.from(tx.serialize()).toString('base64');
}

describe('FlashV2BuilderClient field discipline', () => {
  it('rejects undocumented request keys before sending', async () => {
    const client = new FlashV2BuilderClient({ baseUrl: 'https://flashapi.trade', l1Connection: connection });
    expect(() => client.build('openPosition', {
      inputTokenSymbol: 'USDC',
      outputTokenSymbol: 'SOL',
      inputAmountUi: '5',
      leverage: 2,
      tradeType: 'LONG',
      hiddenReferralField: 'not-documented',
    })).toThrow(/undocumented field/);
  });

  it('accepts the documented referralAccount field', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(
      JSON.stringify({ transactionBase64: null, ok: true }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const client = new FlashV2BuilderClient({ baseUrl: 'https://flashapi.trade', l1Connection: connection });
    await client.build('openPosition', {
      inputTokenSymbol: 'USDC',
      outputTokenSymbol: 'SOL',
      inputAmountUi: '5',
      leverage: 2,
      tradeType: 'LONG',
      referralAccount: '11111111111111111111111111111111',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toContain('"referralAccount":"11111111111111111111111111111111"');
  });

  it('rejects missing documented required keys before sending', async () => {
    const client = new FlashV2BuilderClient({ baseUrl: 'https://flashapi.trade', l1Connection: connection });
    expect(() => client.build('withdraw', {
      owner: '11111111111111111111111111111111',
      tokenSymbol: 'USDC',
      amount: '1',
    })).toThrow(/missing required field/);
  });

  it('preserves orderId 0 exactly in builder payloads', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(
      JSON.stringify({ ok: true, transactionBase64: null }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const client = new FlashV2BuilderClient({ baseUrl: 'https://flashapi.trade', l1Connection: connection });
    await client.build('cancelLimitOrder', {
      owner: '11111111111111111111111111111111',
      marketSymbol: 'SOL',
      side: 'LONG',
      orderId: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toContain('"orderId":0');
  });
});

describe('FlashV2BuilderClient documented error payloads', () => {
  it('throws on a 200 payload containing err', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ err: 'stale oracle' }), { status: 200 })));
    const client = new FlashV2BuilderClient({ baseUrl: 'https://flashapi.trade', l1Connection: connection });
    await expect(client.health()).rejects.toMatchObject({
      name: 'FlashV2ApiPayloadError',
      message: 'stale oracle',
    });
  });

  it('throws on a 200 payload containing error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'bad request shape' }), { status: 200 })));
    const client = new FlashV2BuilderClient({ baseUrl: 'https://flashapi.trade', l1Connection: connection });
    await expect(client.health()).rejects.toMatchObject({
      name: 'FlashV2ApiPayloadError',
      message: 'bad request shape',
    });
  });
});

describe('FlashV2BuilderClient preview-only builders', () => {
  it('treats null transactionBase64 as preview-only and does not sign', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ transactionBase64: null, newEntryPrice: '77.00' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const signer = Keypair.generate();
    const client = new FlashV2BuilderClient({ baseUrl: 'https://flashapi.trade', l1Connection: connection });
    const result = await client.signAndSubmit('openPosition', {
      inputTokenSymbol: 'USDC',
      outputTokenSymbol: 'SOL',
      inputAmountUi: '5',
      leverage: 2,
      tradeType: 'LONG',
    }, [signer]);
    expect(result).toMatchObject({ previewOnly: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('FlashV2BuilderClient routing semantics', () => {
  it('submits trading builders through the V2 trading submit endpoint', async () => {
    const signer = Keypair.generate();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/transaction-builder/open-position')) {
        return new Response(JSON.stringify({ transactionBase64: serializedV0TxBase64(signer) }), { status: 200 });
      }
      if (url.endsWith('/transaction-builder/submit-transaction')) {
        return new Response(JSON.stringify({ signature: '5UQ4J7Q8i6QeZs7vT5gW4JrUqg1GJx4YkJx9T6fW3cP1tP2o8ZrHq4p6h2fLz8cG2wQ1eVn3mYpL9bD7sR1mA2', rpc: 'https://flashtrade.magicblock.app/' }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const sendRawSpy = vi.spyOn(connection, 'sendRawTransaction');
    const client = new FlashV2BuilderClient({ baseUrl: 'https://flashapi.trade', l1Connection: connection });

    const result = await client.signAndSubmit('openPosition', {
      inputTokenSymbol: 'USDC',
      outputTokenSymbol: 'SOL',
      inputAmountUi: '5',
      leverage: 2,
      tradeType: 'LONG',
    }, [signer]);

    expect('previewOnly' in result).toBe(false);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://flashapi.trade/transaction-builder/open-position',
      'https://flashapi.trade/transaction-builder/submit-transaction',
    ]);
    expect(sendRawSpy).not.toHaveBeenCalled();
  });

  it('routes funds builders to Solana RPC instead of the V2 trading submit endpoint', async () => {
    const signer = Keypair.generate();
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ transactionBase64: serializedV0TxBase64(signer) }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const sendRawSpy = vi.spyOn(connection, 'sendRawTransaction').mockResolvedValue(
      '5UQ4J7Q8i6QeZs7vT5gW4JrUqg1GJx4YkJx9T6fW3cP1tP2o8ZrHq4p6h2fLz8cG2wQ1eVn3mYpL9bD7sR1mA2',
    );
    const client = new FlashV2BuilderClient({ baseUrl: 'https://flashapi.trade', l1Connection: connection });

    const result = await client.signAndSubmit('deposit', {
      owner: signer.publicKey.toBase58(),
      tokenSymbol: 'USDC',
      amount: '1',
    }, [signer]);

    expect('previewOnly' in result).toBe(false);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://flashapi.trade/transaction-builder/deposit',
    ]);
    expect(sendRawSpy).toHaveBeenCalledTimes(1);
  });
});

describe('FlashV2BuilderClient surface coverage', () => {
  it('includes every required builder and preview operation in the V2 spec map', () => {
    expect(Object.keys(FLASH_V2_PREVIEWS).sort()).toEqual([
      'exitFee',
      'limitOrderFees',
      'margin',
      'tpSl',
    ]);
    expect(Object.keys(FLASH_V2_BUILDERS).sort()).toEqual(expect.arrayContaining([
      'addCollateral',
      'cancelAllTriggerOrders',
      'cancelLimitOrder',
      'cancelTriggerOrder',
      'closePosition',
      'custodySettlement',
      'decreasePosition',
      'delegateBasket',
      'deposit',
      'depositDirect',
      'editLimitOrder',
      'editTriggerOrder',
      'increasePosition',
      'initBasket',
      'initDepositLedger',
      'openPosition',
      'placeTpSl',
      'placeTriggerOrder',
      'removeCollateral',
      'requestWithdrawal',
      'reversePosition',
      'withdraw',
      'withdrawalSettle',
    ]));
  });

  it('routes documented read helpers to the canonical V2 URLs', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new FlashV2BuilderClient({ baseUrl: 'https://flashapi.trade', l1Connection: connection });

    await client.health();
    await client.tokens();
    await client.prices();
    await client.prices('sol');
    await client.poolData();
    await client.poolData('PoolPubkey');
    await client.raw('markets');
    await client.raw('custodies', 'CustodyPubkey');
    await client.rawBasket('BasketPubkey');
    await client.owner('OwnerPubkey');
    await client.positions('OwnerPubkey');
    await client.orders('OwnerPubkey');

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([
      'https://flashapi.trade/health',
      'https://flashapi.trade/tokens',
      'https://flashapi.trade/prices',
      'https://flashapi.trade/prices/SOL',
      'https://flashapi.trade/pool-data',
      'https://flashapi.trade/pool-data/PoolPubkey',
      'https://flashapi.trade/raw/markets',
      'https://flashapi.trade/raw/custodies/CustodyPubkey',
      'https://flashapi.trade/raw/baskets/BasketPubkey',
      'https://flashapi.trade/owner/OwnerPubkey',
      'https://flashapi.trade/positions/owner/OwnerPubkey',
      'https://flashapi.trade/orders/owner/OwnerPubkey',
    ]);
  });
});
