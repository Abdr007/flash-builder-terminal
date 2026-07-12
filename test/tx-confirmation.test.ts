/**
 * Regression tests for the deep-audit CRITICAL: a submitted trade that REVERTS
 * on-chain must NOT be reported as success. signAndSubmit now confirms the tx
 * reached a terminal on-chain state and throws on a revert; a confirm it can't
 * resolve in the window is 'pending' (fail-safe), never a false 'confirmed'.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Connection, Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { FlashV2BuilderClient, FlashV2TxRevertedError } from '../src/client/flash-v2-builder.js';
import { initSigningGuard } from '../src/security/signing-guard.js';

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const SIG = '5UQ4J7Q8i6QeZs7vT5gW4JrUqg1GJx4YkJx9T6fW3cP1tP2o8ZrHq4p6h2fLz8cG2wQ1eVn3mYpL9bD7sR1mA2';

function txB64(payer: Keypair): string {
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: [],
  }).compileToV0Message());
  return Buffer.from(tx.serialize()).toString('base64');
}

function stubOpenFetch(signer: Keypair): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/submit-transaction')) return new Response(JSON.stringify({ signature: SIG }), { status: 200 });
    return new Response(JSON.stringify({ transactionBase64: txB64(signer) }), { status: 200 });
  }));
}

const openArgs = { inputTokenSymbol: 'USDC', outputTokenSymbol: 'SOL', inputAmountUi: '5', leverage: 2, tradeType: 'LONG' as const };

// These verify the STRICT confirm-before-success path (instant/optimistic OFF).
beforeEach(() => {
  process.env.MAGIC_INSTANT = '0';
  initSigningGuard({ maxLeverage: 0, maxCollateralPerTrade: 0, maxPositionSize: 0, maxTradesPerMinute: 0, minDelayBetweenTradesMs: 0 });
});
afterEach(() => { delete process.env.MAGIC_INSTANT; });
afterEach(() => vi.restoreAllMocks());

describe('signAndSubmit on-chain confirmation', () => {
  it('THROWS FlashV2TxRevertedError when the tx reverts on-chain', async () => {
    const signer = Keypair.generate();
    stubOpenFetch(signer);
    vi.spyOn(connection, 'getSignatureStatus').mockResolvedValue(
      { value: { slot: 1, confirmations: 1, err: { InstructionError: [0, { Custom: 6001 }] }, confirmationStatus: 'confirmed' } } as never,
    );
    const client = new FlashV2BuilderClient({ baseUrl: 'https://flashapi.trade', l1Connection: connection });
    const promise = client.signAndSubmit('openPosition', { ...openArgs, owner: signer.publicKey.toBase58() }, [signer]);
    await expect(promise).rejects.toBeInstanceOf(FlashV2TxRevertedError);
    await expect(promise).rejects.toThrow(/reverted on-chain/);
  });

  it("returns confirmation='confirmed' when the tx lands with no error", async () => {
    const signer = Keypair.generate();
    stubOpenFetch(signer);
    vi.spyOn(connection, 'getSignatureStatus').mockResolvedValue(
      { value: { slot: 1, confirmations: 1, err: null, confirmationStatus: 'finalized' } } as never,
    );
    const client = new FlashV2BuilderClient({ baseUrl: 'https://flashapi.trade', l1Connection: connection });
    const result = await client.signAndSubmit('openPosition', { ...openArgs, owner: signer.publicKey.toBase58() }, [signer]);
    expect((result as { confirmation?: string }).confirmation).toBe('confirmed');
  });

  it("returns confirmation='pending' (fail-safe) when no terminal status appears", async () => {
    const signer = Keypair.generate();
    stubOpenFetch(signer);
    vi.spyOn(connection, 'getSignatureStatus').mockResolvedValue({ value: null } as never); // never lands in-window
    const client = new FlashV2BuilderClient({ baseUrl: 'https://flashapi.trade', l1Connection: connection });
    const result = await client.signAndSubmit(
      'openPosition',
      { ...openArgs, owner: signer.publicKey.toBase58() },
      [signer],
      { confirmAttempts: 2, confirmIntervalMs: 1 },
    );
    expect((result as { confirmation?: string }).confirmation).toBe('pending');
  });
});
