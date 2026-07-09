/**
 * Snapshot tests for `cli/magic-theme.ts:renderCard`.
 *
 * Cards are the primary user-facing surface for trade results. A
 * regression in column alignment, accent bar placement, or row order
 * is *visible* — the snapshot pins it so a refactor that breaks the
 * visual contract fails CI before a user sees it.
 *
 * `chalk.level` is forced to 0 inside the test so colour codes don't
 * end up in the snapshot (they'd vary by terminal capability).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import chalk from 'chalk';
import { renderCard } from '../src/cli/magic-theme.js';

beforeAll(() => {
  // Disable colour at the chalk level so snapshots are stable across
  // local / CI / piped invocations. We restore at process end implicitly.
  chalk.level = 0;
});

describe('renderCard', () => {
  it('renders a single-column open-trade card', () => {
    expect(renderCard({
      status: 'Position Opened',
      tone: 'open',
      subtitle: 'SOL · LONG',
      columns: 1,
      rows: [
        { label: 'Side',       value: 'LONG' },
        { label: 'Leverage',   value: '2.0x' },
        { label: 'Size',       value: '$10.00' },
        { label: 'Collateral', value: '$5.00' },
        { label: 'Entry',      value: '$200.00' },
      ],
      url: 'https://solscan.io/tx/abc123',
    })).toMatchSnapshot();
  });

  it('renders a two-column dashboard-style card', () => {
    expect(renderCard({
      status: 'Vault Summary',
      tone: 'info',
      subtitle: 'overview',
      columns: 2,
      rows: [
        { label: 'USDC',  value: '$1,250.00' },
        { label: 'SOL',   value: '5.50 SOL' },
        { label: 'BTC',   value: '0.025 BTC' },
        { label: 'Total', value: '$2,950.00' },
      ],
    })).toMatchSnapshot();
  });

  it('renders a warn-toned card with latency footer', () => {
    expect(renderCard({
      status: 'Triggers Set',
      tone: 'warn',
      subtitle: 'SOL · LONG',
      columns: 1,
      rows: [
        { label: 'TP', value: '$100.00' },
        { label: 'SL', value: '$70.00' },
      ],
      latencyMs: 247,
    })).toMatchSnapshot();
  });

  it('renders a card with a sentinel-aware "no link" url', () => {
    expect(renderCard({
      status: 'Withdrawn',
      tone: 'close',
      subtitle: 'USDC',
      columns: 1,
      rows: [{ label: 'Amount', value: '$25.00' }],
      url: '(no link — recovered via chain-truth check)',
    })).toMatchSnapshot();
  });

  it('renders a partial-failure (settle) card', () => {
    expect(renderCard({
      status: 'Settle Partial',
      tone: 'warn',
      subtitle: '⬗  2/3 settled · 1 failed',
      columns: 1,
      rows: [
        { label: 'USDC', value: 'https://solscan.io/tx/aaa' },
        { label: 'SOL',  value: 'https://solscan.io/tx/bbb' },
        { label: 'BTC',  value: '✖ AccountNotInitialized' },
      ],
    })).toMatchSnapshot();
  });
});
