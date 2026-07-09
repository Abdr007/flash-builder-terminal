import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { FlashV2BuilderClient } from '../src/client/flash-v2-builder.js';
import { validateVersionedTxPrograms, assertRequiredSigners } from '../src/security/validate-programs.js';
import { initSigningGuard } from '../src/security/signing-guard.js';

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

function txWith(payer: Keypair, instructions: TransactionInstruction[]): VersionedTransaction {
  return new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
    instructions,
  }).compileToV0Message());
}

const openBody = (leverage: number) => ({
  inputTokenSymbol: 'USDC',
  outputTokenSymbol: 'SOL',
  inputAmountUi: '10',
  leverage,
  tradeType: 'LONG',
  owner: '', // filled per-test
});

afterEach(() => vi.restoreAllMocks());

describe('validateVersionedTxPrograms — blind-signing defense', () => {
  const owner = Keypair.generate();

  it('accepts a tx whose instructions target only allowlisted programs', () => {
    const tx = txWith(owner, [
      SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: owner.publicKey, lamports: 1 }),
    ]);
    expect(() => validateVersionedTxPrograms(tx, 'test')).not.toThrow();
  });

  it('rejects a tx that invokes an unknown program (the drainer case)', () => {
    const rogue = new PublicKey('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'); // not on allowlist
    const tx = txWith(owner, [
      new TransactionInstruction({ programId: rogue, keys: [], data: Buffer.alloc(0) }),
    ]);
    expect(() => validateVersionedTxPrograms(tx, 'openPosition')).toThrow(/unknown program/);
  });
});

describe('assertRequiredSigners — refuse unexpected authorities', () => {
  const owner = Keypair.generate();

  it('passes when the only required signer is an intended signer', () => {
    const tx = txWith(owner, []);
    expect(() => assertRequiredSigners(tx, [owner.publicKey.toBase58()], 'test')).not.toThrow();
  });

  it('rejects when the tx requires a signer we did not intend', () => {
    const tx = txWith(owner, []);
    const someoneElse = Keypair.generate().publicKey.toBase58();
    expect(() => assertRequiredSigners(tx, [someoneElse], 'withdraw')).toThrow(/not an intended signer/);
  });
});

describe('signAndSubmit — guards are actually wired into the money path', () => {
  const owner = Keypair.generate();

  beforeEach(() => {
    // Fresh guard each test: tight leverage cap, permissive rate limit so the
    // rate gate doesn't mask the assertions under test.
    initSigningGuard({
      maxLeverage: 5,
      maxCollateralPerTrade: 0,
      maxPositionSize: 0,
      maxTradesPerMinute: 1000,
      minDelayBetweenTradesMs: 0,
    });
  });

  function stubBuildReturning(tx: VersionedTransaction) {
    const b64 = Buffer.from(tx.serialize()).toString('base64');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ transactionBase64: b64 }), { status: 200 },
    )));
  }

  it('rejects an over-leverage open BEFORE signing (trade-limit gate)', async () => {
    stubBuildReturning(txWith(owner, [])); // clean tx; the block should be the limit
    const client = new FlashV2BuilderClient({ baseUrl: 'https://flashapi.trade', l1Connection: connection });
    await expect(
      client.signAndSubmit('openPosition', { ...openBody(50), owner: owner.publicKey.toBase58() }, [owner]),
    ).rejects.toThrow(/Leverage 50x exceeds maximum 5x/);
  });

  it('rejects a server tx that hides a rogue program BEFORE signing', async () => {
    const rogue = new PublicKey('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
    stubBuildReturning(txWith(owner, [
      new TransactionInstruction({ programId: rogue, keys: [], data: Buffer.alloc(0) }),
    ]));
    const client = new FlashV2BuilderClient({ baseUrl: 'https://flashapi.trade', l1Connection: connection });
    await expect(
      client.signAndSubmit('openPosition', { ...openBody(2), owner: owner.publicKey.toBase58() }, [owner]),
    ).rejects.toThrow(/unknown program/);
  });

  it('rejects a server tx requiring a foreign signer BEFORE signing', async () => {
    const stranger = Keypair.generate();
    // tx whose fee payer is a stranger → its required signer is not `owner`.
    stubBuildReturning(txWith(stranger, []));
    const client = new FlashV2BuilderClient({ baseUrl: 'https://flashapi.trade', l1Connection: connection });
    await expect(
      client.signAndSubmit('openPosition', { ...openBody(2), owner: owner.publicKey.toBase58() }, [owner]),
    ).rejects.toThrow(/not an intended signer/);
  });
});
