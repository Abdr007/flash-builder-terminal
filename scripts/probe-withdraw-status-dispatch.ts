#!/usr/bin/env tsx
/**
 * Sanity-check the new `withdraw status` parse path doesn't break the
 * existing `withdraw <token> <amount>` (or `... max`) variants. Runs the
 * interpreter directly with no network — pure unit-style.
 */

import { interpretCommand } from '../src/cli/interpreter.js';

const cases: Array<[string, { alias: string; params: Record<string, unknown> } | null]> = [
  ['withdraw status',          { alias: 'withdraw-status', params: {} }],
  ['Withdraw Status',          { alias: 'withdraw-status', params: {} }],
  ['withdraw watch',           { alias: 'withdraw-watch', params: {} }],
  ['Withdraw Watch',           { alias: 'withdraw-watch', params: {} }],
  ['withdraw usdc 10',         { alias: 'withdraw', params: { token: 'USDC', amount: 10 } }],
  ['withdraw usdc max',        { alias: 'withdraw', params: { token: 'USDC', amount: 'max' } }],
  ['withdraw usdc all',        { alias: 'withdraw', params: { token: 'USDC', amount: 'max' } }],
  ['withdraw usdc 100%',       { alias: 'withdraw', params: { token: 'USDC', amount: 'max' } }],
  ['withdraw 25 usdc',         { alias: 'withdraw', params: { token: 'USDC', amount: 25 } }],
  ['withdraw $25 usdc',        { alias: 'withdraw', params: { token: 'USDC', amount: 25 } }],
  ['withdraw max usdc',        { alias: 'withdraw', params: { token: 'USDC', amount: 'max' } }],
];

let ok = 0;
let fail = 0;
for (const [input, want] of cases) {
  const got = interpretCommand(input, undefined as never);
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) { ok++; process.stdout.write(`  ✓  ${input}\n`); }
  else { fail++; process.stdout.write(`  ✘  ${input}\n     got:  ${a}\n     want: ${b}\n`); }
}
process.stdout.write(`\n  ${ok}/${ok + fail} passed\n`);
process.exit(fail === 0 ? 0 : 1);
