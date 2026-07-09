/**
 * Regression test for the audit's HIGH: the Flash /prices fallback must not
 * present a frozen cache as a LIVE quote during an outage. The service now
 * exposes `ageMs()` (time since last SUCCESSFUL fetch) and applies a failure
 * backoff so it doesn't hammer a down endpoint every tick. The monitor gates
 * "flashLive" on `ageMs() <= FLASH_MAX_LIVE_AGE_MS`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FlashPriceService } from '../src/data/flash-prices.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ok = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200 });

describe('FlashPriceService freshness + backoff', () => {
  it('ages from the last SUCCESS and never advances age on failure', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const svc = new FlashPriceService('https://flashapi.trade');

    fetchMock.mockResolvedValueOnce(ok({ SOL: { priceUi: 100, marketSession: 'regular' } }));
    const m1 = await svc.getPrices();
    expect(m1.get('SOL')?.price).toBe(100);
    expect(svc.ageMs()).toBe(0); // just fetched

    // 5s later the endpoint fails — cache is still served but is now STALE.
    vi.setSystemTime(5_000);
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const m2 = await svc.getPrices();
    expect(m2.get('SOL')?.price).toBe(100); // last good value retained
    expect(svc.ageMs()).toBe(5_000); // > FLASH_MAX_LIVE_AGE_MS (4s) → monitor treats as not-live
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('backs off after failure instead of refetching every call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const svc = new FlashPriceService('https://flashapi.trade');

    fetchMock.mockResolvedValueOnce(ok({ SOL: { priceUi: 100 } }));
    await svc.getPrices(); // success @0, call #1

    vi.setSystemTime(5_000);
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await svc.getPrices(); // fail @5s, call #2 → backoff until ~7s

    // Within the backoff window: no new network call.
    vi.setSystemTime(5_500);
    await svc.getPrices();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Past the backoff window: it retries and recovers.
    vi.setSystemTime(8_000);
    fetchMock.mockResolvedValueOnce(ok({ SOL: { priceUi: 110 } }));
    const m = await svc.getPrices();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(m.get('SOL')?.price).toBe(110);
    expect(svc.ageMs()).toBe(0); // fresh again
  });

  it('never-fetched service reports infinite age (so it is never "live")', () => {
    const svc = new FlashPriceService('https://flashapi.trade');
    expect(svc.ageMs()).toBe(Number.POSITIVE_INFINITY);
  });
});
