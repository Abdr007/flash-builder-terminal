import { describe, it, expect } from 'vitest';
import { inferL1AuditType } from '../src/client/audit-type.js';

describe('inferL1AuditType', () => {
  const cases: Array<[string, ReturnType<typeof inferL1AuditType>]> = [
    ['magic.initUDL',          'init_udl'],
    ['magic.initBasket',       'init_basket'],
    ['magic.delegateBasket',   'delegate_basket'],
    ['magic.deposit',          'deposit'],
    ['magic.executeWithdraw',  'withdraw'],
    ['magic.requestWithdraw',  'withdraw'],
    ['magic.executeSettle',    'settle'],
    ['Settle.foo',             'settle'],
    ['unknown-bundle',         'deposit'], // fallback
  ];
  for (const [ctx, expected] of cases) {
    it(`maps "${ctx}" → ${expected}`, () => {
      expect(inferL1AuditType(ctx)).toBe(expected);
    });
  }
});
