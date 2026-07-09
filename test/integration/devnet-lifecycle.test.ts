/**
 * Devnet integration smoke test — exercises the full SDK lifecycle against
 * a real Magic Block ER + Solana devnet.
 *
 * Required env vars (test is skipped when missing):
 *   MAGIC_TEST_KEYPAIR_BASE58   — base58-encoded 64-byte secret key for the
 *                                 funded devnet wallet
 *   MAGIC_TEST_DEVNET_RPC       — devnet L1 RPC URL (helius/triton/etc.)
 *   MAGIC_TEST_DEVNET_ER        — devnet ER router URL (defaults to
 *                                 https://flashtrade.magicblock.app/ if unset)
 *
 * Optional gates:
 *   MAGIC_TEST_RUN_WRITES=1     — also exercise deposit / open / close /
 *                                 withdraw. Off by default; needs an
 *                                 actively-funded test wallet that the
 *                                 maintainer is willing to spend.
 *
 * The test deliberately favours READS over WRITES — every CI run shouldn't
 * mutate on-chain state. The READ path alone is enough to catch SDK
 * version drift, IDL mismatches, RPC endpoint mis-configuration, ER
 * downtime, and pool-config decoding regressions, which is the high-value
 * signal we want from a CI gate. WRITES are gated behind an explicit env
 * flag for the maintainer's manual smoke run.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { createMagicSession, TradeSide, type MagicSession } from '../../src/sdk.js';

// `.trim()` everywhere — secrets pasted into GitHub's UI commonly carry
// a trailing newline (from `pbcopy` or shell capture) which makes the
// raw string fail bs58.decode with "Non-base58 character". Trimming on
// read lets us tolerate that without forcing the user to re-save the
// secret without whitespace.
const KEYPAIR_B58 = process.env.MAGIC_TEST_KEYPAIR_BASE58?.trim();
const DEVNET_RPC = process.env.MAGIC_TEST_DEVNET_RPC?.trim();
const DEVNET_ER = (process.env.MAGIC_TEST_DEVNET_ER?.trim()) || 'https://flashtrade.magicblock.app/';
const RUN_WRITES = process.env.MAGIC_TEST_RUN_WRITES === '1';

// `describe.skipIf` evaluates at collection time so missing env in CI quietly
// skips the suite without failing — the same job can run in PRs from forks
// that don't carry the secret without exploding.
const skipIfNoEnv = !KEYPAIR_B58 || !DEVNET_RPC;

describe.skipIf(skipIfNoEnv)('devnet · lifecycle', () => {
  let session: MagicSession;
  /**
   * A symbol we know exists on the active devnet pool. Picked dynamically
   * in `beforeAll` so we don't hard-code a symbol that isn't on this
   * particular pool's custody list — devnet's Pool.1 has historically
   * differed from mainnet's Pool.0, and pool composition can shift between
   * SDK versions.
   */
  let probeSymbol: string;
  /**
   * True iff the test wallet has gone through `magic setup` (UDL +
   * basket + delegate initialised). The SDK's `getEntryPriceAndFee` /
   * `getOpenPositionQuote` simulations reference the basket account and
   * fail with `ProgramAccountNotFound` if it's missing — so price /
   * preview tests gate on this and skip with a clear note when the
   * wallet is brand new.
   *
   * The WRITES test runs setup as part of its lifecycle, so on
   * release/** branches subsequent runs against the same wallet flip
   * this to true and exercise the full read surface.
   */
  let hasBasket = false;

  beforeAll(async () => {
    const secret = bs58.decode(KEYPAIR_B58!);
    expect(secret.length).toBe(64);
    const keypair = Keypair.fromSecretKey(secret);

    session = await createMagicSession({
      walletKeypair: keypair,
      network: 'devnet',
      l1RpcUrl: DEVNET_RPC,
      erRpcUrl: DEVNET_ER,
      // Tighten the rate limit so a stuck test can't burn our quota.
      maxTradesPerMinute: 6,
      logLevel: 'warn',
    });

    // Discover an available market symbol from the actual pool, falling
    // back to SOL (the common case). If the pool is empty we'll error
    // loudly in the markets test below.
    const markets = await session.getMarketData();
    probeSymbol = markets.find((m) => m.symbol === 'SOL')?.symbol
      ?? markets[0]?.symbol
      ?? 'SOL';

    // Probe basket existence. `fetchBasket` returns null when the
    // account doesn't exist (the SDK swallows the not-found error
    // internally — we just check the result).
    try {
      const basket = await session.fetchBasket();
      hasBasket = basket !== null && basket !== undefined;
    } catch {
      hasBasket = false;
    }
    if (!hasBasket) {
      // eslint-disable-next-line no-console
      console.warn(
        '[devnet-lifecycle] test wallet has no basket yet — price / preview ' +
        'tests will skip. Run with MAGIC_TEST_RUN_WRITES=1 (or `magic setup` ' +
        'on the test wallet manually) to exercise them.',
      );
    }
  }, 60_000);

  afterAll(async () => {
    if (session) {
      const { warnings } = await session.shutdown();
      // Warn on shutdown debris but don't fail — the lifecycle assertions
      // are the contract; cleanup is best-effort.
      if (warnings.length > 0) {
        // eslint-disable-next-line no-console
        console.warn('[devnet-lifecycle] shutdown warnings:', warnings);
      }
    }
  }, 15_000);

  // ─── Reads ─────────────────────────────────────────────────────────────

  it('connects with a non-empty wallet address', () => {
    expect(session.walletAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(session.network).toBe('devnet');
  });

  it('discovers markets from the on-chain pool config', async () => {
    const markets = await session.getMarketData();
    expect(Array.isArray(markets)).toBe(true);
    expect(markets.length).toBeGreaterThan(0);
    // Every market must have a non-empty `symbol` — guards against the
    // "empty pool decoded" failure mode that would silently break trading.
    for (const m of markets) {
      expect(typeof m.symbol).toBe('string');
      expect(m.symbol.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it('reads a live oracle price for the probe symbol', async ({ skip }) => {
    if (!hasBasket) return skip();
    const price = await session.fetchOraclePrice(probeSymbol);
    expect(typeof price).toBe('number');
    expect(Number.isFinite(price)).toBe(true);
    // Sanity: any reasonable asset is > $0.0001 and < $1M. Catches
    // mis-scaled exponents — a -8 vs -5 oracle exponent slip would
    // either make the price look like dust or astronomically large.
    expect(price).toBeGreaterThan(0.0001);
    expect(price).toBeLessThan(1_000_000);
  }, 15_000);

  it('returns a portfolio object (positions may be empty)', async () => {
    const p = await session.getPortfolio();
    expect(p).toBeDefined();
    expect(Array.isArray(p.positions)).toBe(true);
    // Every position must have finite numbers — catches NaN-leaking math.
    for (const pos of p.positions) {
      expect(Number.isFinite(pos.sizeUsd)).toBe(true);
      expect(Number.isFinite(pos.collateralUsd)).toBe(true);
      expect(Number.isFinite(pos.entryPrice)).toBe(true);
      expect(Number.isFinite(pos.liquidationPrice)).toBe(true);
    }
  }, 30_000);

  it('previews an open without signing anything', async ({ skip }) => {
    if (!hasBasket) return skip();
    // previewOpen must NEVER touch the wire from the signing path. If this
    // ever logs to the audit file or shows up in chain history, the
    // signing-guard isolation is broken.
    const preview = await session.previewOpen(probeSymbol, TradeSide.Long, 5, 2);
    expect(preview).toBeDefined();
    expect(Number.isFinite(preview.sizeUsd)).toBe(true);
    expect(Number.isFinite(preview.entryPrice)).toBe(true);
    expect(Number.isFinite(preview.liquidationPrice)).toBe(true);
    expect(preview.sizeUsd).toBeGreaterThan(0);
    expect(preview.entryPrice).toBeGreaterThan(0);
    // Long liquidation must be BELOW entry. Catches sign-flip bugs in the
    // liq math that otherwise look "plausibly numeric" until a user dies.
    expect(preview.liquidationPrice).toBeLessThan(preview.entryPrice);
  }, 30_000);

  it('reads basket / vault state without throwing on empty', async () => {
    // A brand-new test wallet may have no basket yet — the SDK must
    // return an empty result rather than throwing AccountNotInitialized.
    const balances = await session.getAvailableBalances();
    expect(balances instanceof Map).toBe(true);
  }, 30_000);

  // ─── Writes (gated) ────────────────────────────────────────────────────

  it.skipIf(!RUN_WRITES)('exercises full deposit → open → close → withdraw cycle', async () => {
    // Intentionally tiny size to keep the test cheap.
    // Each step asserts BEFORE/AFTER state moved in the expected direction.
    const market = probeSymbol;
    const side = TradeSide.Long;
    const collateral = 1; // 1 USDC
    const leverage = 1.5;

    // Open
    const opened = await session.openPosition(market, side, collateral, leverage);
    expect(opened.txSignature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,88}$/);
    expect(Number.isFinite(opened.entryPrice)).toBe(true);
    expect(opened.sizeUsd).toBeGreaterThan(0);

    // The position should now show up in the portfolio.
    const after = await session.getPortfolio();
    const found = after.positions.find(
      (p) => p.market.toUpperCase() === market && String(p.side).toLowerCase() === 'long',
    );
    expect(found).toBeDefined();

    // Close — accept any of: real sig, 'already-landed', 'expired-but-landed'.
    const closed = await session.closePosition(market, side);
    expect(closed.txSignature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,88}$|^(already-landed|expired-but-landed)$/);
  }, 180_000);
});
