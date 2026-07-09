/**
 * Map an L1-instruction-bundle context string (`'magic.deposit'`,
 * `'magic.initBasket'`, …) to the SigningAuditEntry.type discriminant.
 *
 * Keeping the matcher in one place means a future audit-type addition
 * (e.g. a new `'rebalance'` flow) gets recorded forensically without
 * every L1 caller having to plumb an audit-type field through its
 * call signature. Also means the matcher is unit-testable.
 */

import type { SigningAuditEntry } from '../security/signing-guard.js';

export function inferL1AuditType(context: string): SigningAuditEntry['type'] {
  if (context.includes('initUDL')) return 'init_udl';
  if (context.includes('initBasket')) return 'init_basket';
  if (context.includes('delegateBasket')) return 'delegate_basket';
  if (context.includes('deposit')) return 'deposit';
  if (context.includes('Withdraw') || context.includes('withdraw')) return 'withdraw';
  if (context.includes('settle') || context.includes('Settle')) return 'settle';
  // Fallback — better than throwing. "deposit" is the closest semantic
  // neutral for an L1 ix bundle whose intent we couldn't classify.
  return 'deposit';
}
