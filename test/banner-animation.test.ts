/**
 * Guards the invariant the whole first-run animation rests on: in any
 * NON-interactive context (agents/NO_DNA, CI, pipes/redirects, NO_COLOR — i.e.
 * `process.stdout.isTTY` falsey, which is the case under vitest), the animated
 * entrypoints MUST emit the exact static output, instantly, with no cursor
 * escape codes. A regression here would spam agents/CI logs with ANSI motion
 * sequences or hang a pipeline on the reveal delays.
 */
import { describe, it, expect } from 'vitest';
import {
  animateHero,
  renderHero,
  bootSequence,
  animateSession,
  renderSession,
} from '../src/cli/banner.js';

async function capture(fn: () => Promise<void>): Promise<{ out: string; ms: number }> {
  let out = '';
  const real = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    out += s;
    return true;
  };
  const t0 = Date.now();
  try {
    await fn();
  } finally {
    (process.stdout as unknown as { write: typeof real }).write = real;
  }
  return { out, ms: Date.now() - t0 };
}

const SESSION = {
  network: 'mainnet-beta' as const,
  pool: 'FLASH6',
  programId: 'FLASH6Lo6h3iasJKWDs2F8TkW2UKz3sZyQhwFbY7YzKZ',
  walletAddress: '5RaP1EXTEHU6SqzSt4x5uBbzZKz4Q2yEok3jEfDSkE5j',
  erUrl: 'https://flashtrade.magicblock.app/',
};

describe('first-run animation — non-TTY fallback is static + instant', () => {
  it('animateHero() === renderHero() byte-for-byte (no motion for agents/CI/pipe)', async () => {
    const { out, ms } = await capture(() => animateHero());
    expect(out).toBe(await renderHero());
    expect(ms).toBeLessThan(100); // instant — no reveal delays
  });

  it('animateSession() === renderSession() byte-for-byte', async () => {
    const { out, ms } = await capture(() => animateSession(SESSION));
    expect(out).toBe(renderSession(SESSION));
    expect(ms).toBeLessThan(100);
  });

  it('bootSequence() prints checkmark rows with no spinner/cursor escapes', async () => {
    const { out, ms } = await capture(() =>
      bootSequence([
        { label: 'Network', detail: 'mainnet-beta · FLASH6' },
        { label: 'RPC', detail: 'Helius' },
        { label: 'Router', detail: 'flashtrade.magicblock.app' },
      ]),
    );
    expect(out).toContain('Network');
    expect(out).toContain('Router');
    expect(out).toContain('✓'); // resolved checkmarks
    // No cursor hide/show or line-clear escapes leaked to a non-TTY sink.
    expect(out).not.toContain('\x1b[?25l');
    expect(out).not.toContain('\x1b[?25h');
    expect(out).not.toContain('\x1b[2K');
    // No braille spinner frames in the static path.
    expect(out).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(ms).toBeLessThan(100);
  });
});
