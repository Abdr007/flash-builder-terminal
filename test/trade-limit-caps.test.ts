/**
 * Regression tests for the pre-launch audit's HIGH finding:
 *
 *   MAX_POSITION_SIZE / MAX_LEVERAGE / MAX_COLLATERAL_PER_TRADE were enforced
 *   ONLY on `openPosition`. Every other size/leverage-growing builder
 *   (increasePosition, reversePosition, removeCollateral) — and the auto-merge
 *   open→increase path — signed & submitted with the caps completely un-checked,
 *   because `deriveTradeLimits` returned null for them and `signV2` never passed
 *   an explicit `opts.tradeLimits`.
 *
 * The fix enforces caps on every risk-bearing builder via caller-supplied
 * `tradeLimits`, and FAILS CLOSED (refuses to sign) when a risk-bearing op
 * reaches the sign boundary with no resolvable limits while caps are configured.
 *
 * These tests drive the real signing chokepoint (`FlashV2BuilderClient.
 * signAndSubmit`) with a stubbed build+submit endpoint and assert:
 *   - over-cap increase / reverse / removeCollateral are REJECTED before submit
 *   - a risk-bearing op with NO tradeLimits + caps set fails CLOSED
 *   - within-cap ops still submit (no regression to legit trades)
 *   - with caps OFF, un-resolved risk-bearing ops still submit (behavior kept)
 *   - addCollateral (risk-reducing) is NEVER fail-closed-blocked
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Connection, Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { FlashV2BuilderClient, type TradeLimitParams } from '../src/client/flash-v2-builder.js';
import { initSigningGuard } from '../src/security/signing-guard.js';

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

function txB64(payer: Keypair): string {
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: [],
  }).compileToV0Message());
  return Buffer.from(tx.serialize()).toString('base64');
}

/** Stub the Flash API: build endpoints return a tx, submit returns a signature. */
function stubApi(owner: Keypair) {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes('submit-transaction')) {
      return new Response(JSON.stringify({ signature: 'SIG_' + '1'.repeat(80) }), { status: 200 });
    }
    return new Response(JSON.stringify({ transactionBase64: txB64(owner) }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const buildCalls = (m: ReturnType<typeof stubApi>, fragment: string) =>
  m.mock.calls.filter((c) => String(c[0]).includes(fragment)).length;
const submitCalls = (m: ReturnType<typeof stubApi>) =>
  m.mock.calls.filter((c) => String(c[0]).includes('submit-transaction')).length;

// Caps: leverage ≤ 10x, position ≤ $1000, collateral ≤ $100 per trade.
// Rate limit disabled so it never masks a cap result.
const CAPS = { maxLeverage: 10, maxPositionSize: 1000, maxCollateralPerTrade: 100, maxTradesPerMinute: 0, minDelayBetweenTradesMs: 0 };
const NO_CAPS = { maxLeverage: 0, maxPositionSize: 0, maxCollateralPerTrade: 0, maxTradesPerMinute: 0, minDelayBetweenTradesMs: 0 };

function client(): FlashV2BuilderClient {
  return new FlashV2BuilderClient({ baseUrl: 'https://flashapi.trade', l1Connection: connection });
}

afterEach(() => vi.restoreAllMocks());

describe('risk caps are enforced on EVERY size/leverage-growing builder', () => {
  const owner = Keypair.generate();
  const incBody = () => ({
    marketSymbol: 'SOL', side: 'long', sizeAmountUi: '100', collateralAmountUi: '5', owner: owner.publicKey.toBase58(),
  });
  const revBody = () => ({ marketSymbol: 'SOL', side: 'long', leverage: 2, owner: owner.publicKey.toBase58() });
  const rmBody = () => ({ marketSymbol: 'SOL', side: 'long', withdrawAmountUsdUi: '10', withdrawTokenSymbol: 'USDC', owner: owner.publicKey.toBase58() });
  const addBody = () => ({ marketSymbol: 'SOL', side: 'long', depositAmountUi: '10', depositTokenSymbol: 'USDC', owner: owner.publicKey.toBase58() });

  beforeEach(() => initSigningGuard(CAPS));

  it('EXPLOIT (old behavior) blocked: over-leverage increase is REJECTED before submit', async () => {
    const m = stubApi(owner);
    // Keep collateral & size under their caps so the LEVERAGE cap is what trips.
    const overLev: TradeLimitParams = { collateral: 5, leverage: 50, sizeUsd: 250, market: 'SOL' };
    await expect(
      client().signAndSubmit('increasePosition', incBody(), [owner], { tradeLimits: overLev }),
    ).rejects.toThrow(/Leverage 50x exceeds maximum 10x/);
    expect(buildCalls(m, 'increase-position')).toBe(1); // built (preview)…
    expect(submitCalls(m)).toBe(0);                      // …but NEVER signed/submitted
  });

  it('over-size increase is REJECTED (MAX_POSITION_SIZE)', async () => {
    const m = stubApi(owner);
    const overSize: TradeLimitParams = { collateral: 90, leverage: 8, sizeUsd: 720_000, market: 'SOL' };
    await expect(
      client().signAndSubmit('increasePosition', incBody(), [owner], { tradeLimits: overSize }),
    ).rejects.toThrow(/exceeds maximum \$1000/);
    expect(submitCalls(m)).toBe(0);
  });

  it('over-leverage reverse is REJECTED', async () => {
    const m = stubApi(owner);
    // collateral & size under caps so the LEVERAGE cap is what trips.
    const overLev: TradeLimitParams = { collateral: 5, leverage: 100, sizeUsd: 500, market: 'SOL' };
    await expect(
      client().signAndSubmit('reversePosition', revBody(), [owner], { tradeLimits: overLev }),
    ).rejects.toThrow(/Leverage 100x exceeds maximum 10x/);
    expect(submitCalls(m)).toBe(0);
  });

  it('removeCollateral that pushes resulting leverage over cap is REJECTED', async () => {
    const m = stubApi(owner);
    // Existing $1000 size on $150 collateral (6.6x); remove $100 → $50 coll → 20x.
    const resulting: TradeLimitParams = { collateral: 50, leverage: 20, sizeUsd: 1000, market: 'SOL' };
    await expect(
      client().signAndSubmit('removeCollateral', rmBody(), [owner], { tradeLimits: resulting }),
    ).rejects.toThrow(/Leverage 20x exceeds maximum 10x/);
    expect(submitCalls(m)).toBe(0);
  });

  it('FAIL-CLOSED: risk-bearing op with NO tradeLimits + caps set is REFUSED (the raw/unwired-path backstop)', async () => {
    const m = stubApi(owner);
    await expect(
      client().signAndSubmit('increasePosition', incBody(), [owner]),
    ).rejects.toThrow(/refusing to sign increasePosition: per-trade risk caps are configured/);
    expect(submitCalls(m)).toBe(0);
  });

  it('within-cap increase still submits (no regression to legit trades)', async () => {
    const m = stubApi(owner);
    const ok: TradeLimitParams = { collateral: 50, leverage: 4, sizeUsd: 200, market: 'SOL' };
    const r = await client().signAndSubmit('increasePosition', incBody(), [owner], { tradeLimits: ok });
    expect('signature' in r && r.signature).toBeTruthy();
    expect(submitCalls(m)).toBe(1);
  });

  it('addCollateral (risk-reducing) is NEVER fail-closed-blocked even with caps + no limits', async () => {
    const m = stubApi(owner);
    const r = await client().signAndSubmit('addCollateral', addBody(), [owner]);
    expect('signature' in r && r.signature).toBeTruthy(); // de-risking must never be blocked
    expect(submitCalls(m)).toBe(1);
  });
});

describe('caps OFF: behavior preserved', () => {
  const owner = Keypair.generate();
  const incBody = () => ({
    marketSymbol: 'SOL', side: 'long', sizeAmountUi: '100', collateralAmountUi: '5', owner: owner.publicKey.toBase58(),
  });

  beforeEach(() => initSigningGuard(NO_CAPS));

  it('risk-bearing op with no tradeLimits still submits when no cap is configured', async () => {
    const m = stubApi(owner);
    const r = await client().signAndSubmit('increasePosition', incBody(), [owner]);
    expect('signature' in r && r.signature).toBeTruthy();
    expect(submitCalls(m)).toBe(1); // capsConfigured()===false → no fail-closed
  });
});
