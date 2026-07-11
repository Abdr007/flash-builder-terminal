/**
 * Pending-card honesty (deep-audit-#3, MED).
 *
 * signAndSubmit THROWS on an on-chain revert, so any success card means the tx
 * either 'confirmed' or is 'pending' (couldn't be confirmed in the poll window).
 * A 'pending' mutation must NEVER render a definitive "Position Closed /
 * Reversed / Increased / collateral changed" — the user could believe they're
 * flat/flipped/funded while the tx hasn't actually landed.
 *
 * These assert the three shared helpers every mutation card now routes through.
 */
import { describe, it, expect } from 'vitest';
import {
  isPendingConfirm,
  pendingRows,
  confirmStatus,
} from '../src/tools/magic-tools.js';
import type { FlashV2BuilderResult } from '../src/client/flash-v2-builder.js';

const signed = (confirmation: 'confirmed' | 'pending'): FlashV2BuilderResult =>
  ({
    signature: 'Sig11111111111111111111111111111111111111111',
    route: 'l1' as never,
    response: {},
    signedTransactionBase64: '',
    confirmation,
  }) as FlashV2BuilderResult;

const previewOnly = (): FlashV2BuilderResult =>
  ({ previewOnly: true, response: {} }) as FlashV2BuilderResult;

describe('pending-card honesty helpers', () => {
  it('isPendingConfirm: only a non-confirmed signed result is pending', () => {
    expect(isPendingConfirm(signed('confirmed'))).toBe(false);
    expect(isPendingConfirm(signed('pending'))).toBe(true);
    // A preview-only result has no `confirmation` field → never "pending".
    expect(isPendingConfirm(previewOnly())).toBe(false);
  });

  it('confirmStatus: definitive title only when confirmed', () => {
    expect(confirmStatus(signed('confirmed'), 'Position Closed', 'Close Submitted')).toBe('Position Closed');
    expect(confirmStatus(signed('pending'), 'Position Closed', 'Close Submitted')).toBe('Close Submitted');
  });

  it('pendingRows: appends a confirming-status row iff pending', () => {
    expect(pendingRows(signed('confirmed'))).toEqual([]);
    const rows = pendingRows(signed('pending'));
    expect(rows).toHaveLength(1);
    // Row must actually communicate the not-yet-landed state.
    expect(rows[0].value).toMatch(/confirming|submitted/i);
  });

  it('a pending result NEVER yields a definitive title AND never an empty row', () => {
    const p = signed('pending');
    expect(confirmStatus(p, 'DONE', 'SUBMITTED')).toBe('SUBMITTED');
    expect(pendingRows(p).length).toBeGreaterThan(0);
  });
});
