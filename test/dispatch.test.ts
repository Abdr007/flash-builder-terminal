/**
 * Dispatch smoke test — every command listed in the in-app `help` reference
 * must parse to a payload that the registered tool's Zod schema accepts.
 * Catches regressions where the parser and the tool schema drift apart.
 */

import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import { parseCommandForTest } from '../src/cli/terminal.js';
import { magicTools } from '../src/tools/magic-tools.js';
import type { ToolDefinition, MagicConfig } from '../src/types/index.js';

const config: MagicConfig = {
  network: 'mainnet-beta',
  poolName: 'Pool.0',
  // Remaining fields aren't read by parseCommand; cast keeps the test focused.
} as unknown as MagicConfig;

const toolByAlias = new Map<string, ToolDefinition>();
function toAlias(name: string): string {
  const stripped = name.startsWith('magic') ? name.slice(5) : name;
  return stripped
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[A-Z]/g, (m, idx) => (idx === 0 ? m.toLowerCase() : m))
    .toLowerCase();
}
for (const t of magicTools) toolByAlias.set(toAlias(t.name), t);

const HELP_COMMANDS: { line: string; expectedAlias: string }[] = [
  { line: 'long SOL 5 2x',                expectedAlias: 'open' },
  { line: 'open sol long 2x 10 tp 100 sl 65', expectedAlias: 'open' },
  { line: 'OPEN SOL LONG 5 2X',             expectedAlias: 'open' },
  { line: 'CLOSE SOL LONG',                 expectedAlias: 'close' },
  { line: 'ADD SOL LONG 5',                 expectedAlias: 'add-collateral' },
  { line: 'LIMIT SOL LONG 80 50 2X',        expectedAlias: 'place-limit' },
  { line: 'SET SOL LONG TP 100 SL 70',      expectedAlias: 'set-triggers' },
  { line: 'CANCEL ALL',                     expectedAlias: 'cancel' },
  { line: 'DEPOSIT USDC 50',                expectedAlias: 'deposit' },
  { line: 'ALERTS ON',                      expectedAlias: 'alerts' },
  { line: 'PRICE SOL',                      expectedAlias: 'price' },
  { line: 'MARKETS CRYPTO',                 expectedAlias: 'markets' },
  { line: 'SETTLE USDC',                    expectedAlias: 'settle' },

  // ─── Flexible interpreter: free word order ──────────────────────────
  { line: 'long sol 2x 10',                 expectedAlias: 'open' },
  { line: 'short btc 3x 50',                expectedAlias: 'open' },
  { line: 'sol long 2x 10',                 expectedAlias: 'open' },
  { line: 'long 10 sol 2x',                 expectedAlias: 'open' },
  { line: 'short 3x btc 50',                expectedAlias: 'open' },
  { line: '10 usd sol long 2x',             expectedAlias: 'open' },
  { line: 'open sol long $10 2x',           expectedAlias: 'open' },
  { line: 'buy sol 2x 10',                  expectedAlias: 'open' },

  // ─── Greeting / filler tolerance ────────────────────────────────────
  { line: 'yo open a sol long for 10 usd at 2x',           expectedAlias: 'open' },
  { line: 'please long sol using ten dollars leverage two', expectedAlias: 'open' },
  { line: 'enter a 2x long on sol with 10 bucks',          expectedAlias: 'open' },

  // ─── Number words ──────────────────────────────────────────────────
  { line: 'long sol 2x ten dollars',        expectedAlias: 'open' },

  // ─── Inline TP/SL ──────────────────────────────────────────────────
  { line: 'long sol 2x 10 tp 95 sl 80',     expectedAlias: 'open' },
  { line: 'open 5x long SOL $50 sl $70 tp $120', expectedAlias: 'open' },
  { line: 'buy 2x long sol $100 tp $95 sl $80', expectedAlias: 'open' },

  // ─── TP/SL shortcuts ───────────────────────────────────────────────
  { line: 'tp sol 160',                     expectedAlias: 'trigger-order' },
  { line: 'sl btc 60000',                   expectedAlias: 'trigger-order' },
  { line: 'tp eth $2500',                   expectedAlias: 'trigger-order' },

  // ─── Set TP/SL natural ─────────────────────────────────────────────
  { line: 'set tp SOL long $95',            expectedAlias: 'trigger-order' },
  { line: 'set sl btc short to 60000',      expectedAlias: 'trigger-order' },

  // ─── Limit ─────────────────────────────────────────────────────────
  { line: 'limit long SOL 2x $100 @ $82',   expectedAlias: 'place-limit' },
  { line: 'limit order sol 2x for 100 dollars long at 82', expectedAlias: 'place-limit' },

  // ─── Reverse / Flip ────────────────────────────────────────────────
  { line: 'reverse SOL',                    expectedAlias: 'reverse' },
  { line: 'flip SOL long',                  expectedAlias: 'reverse' },

  // ─── Close variants ────────────────────────────────────────────────
  { line: 'close all',                      expectedAlias: 'close-all' },
  { line: 'close sol long',                 expectedAlias: 'close' },
  { line: 'close 50% of SOL long',          expectedAlias: 'partial-close' },
  { line: 'close $20 of BTC short',         expectedAlias: 'partial-close' },
  { line: 'close SOL long 50%',             expectedAlias: 'partial-close' },

  // ─── Add / remove collateral natural ───────────────────────────────
  { line: 'add $50 to SOL long',            expectedAlias: 'add-collateral' },
  { line: 'add 50 to SOL long',             expectedAlias: 'add-collateral' },
  { line: 'remove $20 from ETH long',       expectedAlias: 'remove-collateral' },

  // ─── Fuzzy typo correction ─────────────────────────────────────────
  { line: 'lon sol 2x 10',                  expectedAlias: 'open' },
  { line: 'solan long 2x 10',               expectedAlias: 'open' },

  // ─── Positions / portfolio variants ────────────────────────────────
  { line: 'my positions',                   expectedAlias: 'portfolio' },
  { line: 'show positions',                 expectedAlias: 'portfolio' },
  { line: 'open positions',                 expectedAlias: 'portfolio' },
  { line: 'holdings',                       expectedAlias: 'portfolio' },

  // ─── Deposit / withdraw natural ────────────────────────────────────
  { line: 'deposit 50 USDC',                expectedAlias: 'deposit' },
  { line: 'fund 50 USDC',                   expectedAlias: 'deposit' },
  { line: 'withdraw 25 USDC',               expectedAlias: 'withdraw' },
  { line: 'withdraw USDC 25',               expectedAlias: 'withdraw' },

  // ─── Increase variants ─────────────────────────────────────────────
  { line: 'size up SOL long 10',            expectedAlias: 'increase' },
  { line: 'grow SOL long 5',                expectedAlias: 'increase' },
  { line: 'scale SOL long 10',              expectedAlias: 'increase' },

  // ─── Remove TP/SL natural (auto-find orderId) ──────────────────────
  { line: 'remove tp SOL long',             expectedAlias: 'cancel-trigger' },
  { line: 'cancel sl btc',                  expectedAlias: 'cancel-trigger' },

  // ─── Asset aliases ─────────────────────────────────────────────────
  { line: 'long bitcoin 2x 10',             expectedAlias: 'open' },
  { line: 'long ethereum 3x 50',            expectedAlias: 'open' },
  { line: 'gold price',                     expectedAlias: 'price' },
  { line: 'oil price',                      expectedAlias: 'price' },
  { line: 'long crude 2x 10',               expectedAlias: 'open' },
  { line: 'long crude oil 2x 10',           expectedAlias: 'open' },
  { line: 'long natural gas 2x 10',         expectedAlias: 'open' },
  { line: 'short BTC 100 3x',             expectedAlias: 'open' },
  { line: 'open SOL long 5 2',            expectedAlias: 'open' },
  { line: 'close SOL long',               expectedAlias: 'close' },
  { line: 'reverse SOL long',             expectedAlias: 'reverse' },
  { line: 'increase SOL long 10',         expectedAlias: 'increase' },
  { line: 'partial SOL long 5',           expectedAlias: 'partial-close' },
  { line: 'add SOL long 5',               expectedAlias: 'add-collateral' },
  { line: 'remove SOL long 5',            expectedAlias: 'remove-collateral' },
  { line: 'limit SOL long 80 50 2',       expectedAlias: 'place-limit' },
  { line: 'limit order SOL long 80 50 2 set tp 100 sl 70', expectedAlias: 'place-limit' },
  { line: 'orders',                       expectedAlias: 'orders' },
  { line: 'orders 11111111111111111111111111111111', expectedAlias: 'orders' },
  { line: 'cancel 0',                     expectedAlias: 'cancel' },
  { line: 'cancel order 0',               expectedAlias: 'cancel' },
  { line: 'cancel all',                   expectedAlias: 'cancel' },
  { line: 'cancel 0..4',                  expectedAlias: 'cancel' },
  { line: 'tp SOL long 95',               expectedAlias: 'trigger-order' },
  { line: 'sl SOL long 80',               expectedAlias: 'trigger-order' },
  { line: 'trigger SOL long 95 tp',       expectedAlias: 'trigger-order' },
  { line: 'set SOL long tp 100 sl 70',    expectedAlias: 'set-triggers' },
  { line: 'set tp 100 and sl 50 to sol long', expectedAlias: 'set-triggers' },
  { line: 'cancel-limit SOL long 0',      expectedAlias: 'cancel-limit' },
  { line: 'cancel-trigger SOL 0 tp',      expectedAlias: 'cancel-trigger' },
  { line: 'deposit USDC 50',              expectedAlias: 'deposit' },
  { line: 'deposit-direct EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 50', expectedAlias: 'deposit-direct' },
  { line: 'deposit direct EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 50', expectedAlias: 'deposit-direct' },
  { line: 'deposit SOL 0.1',              expectedAlias: 'deposit' },
  { line: 'withdraw USDC 25',             expectedAlias: 'withdraw' },
  { line: 'request-withdrawal EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 25', expectedAlias: 'request-withdrawal' },
  { line: 'request withdrawal EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 25', expectedAlias: 'request-withdrawal' },
  { line: 'withdrawal-settle EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', expectedAlias: 'withdrawal-settle' },
  { line: 'withdrawal settle EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', expectedAlias: 'withdrawal-settle' },
  { line: 'vault',                        expectedAlias: 'vault' },
  { line: 'account',                      expectedAlias: 'account' },
  { line: 'acc',                          expectedAlias: 'account' },
  { line: 'settle',                       expectedAlias: 'settle' },
  { line: 'settle USDC',                  expectedAlias: 'settle' },
  { line: 'custody-settlement USDC',      expectedAlias: 'settle' },
  { line: 'custody settlement USDC',      expectedAlias: 'settle' },
  { line: 'init-deposit-ledger',          expectedAlias: 'init-deposit-ledger' },
  { line: 'init deposit ledger',          expectedAlias: 'init-deposit-ledger' },
  { line: 'init-basket',                  expectedAlias: 'init-basket' },
  { line: 'init basket',                  expectedAlias: 'init-basket' },
  { line: 'delegate-basket',              expectedAlias: 'delegate-basket' },
  { line: 'delegate basket',              expectedAlias: 'delegate-basket' },
  { line: 'delegate',                     expectedAlias: 'delegate-basket' },
  { line: 'portfolio',                    expectedAlias: 'portfolio' },
  { line: 'positions',                    expectedAlias: 'positions' },
  { line: 'positions 11111111111111111111111111111111', expectedAlias: 'positions' },
  { line: 'dashboard',                    expectedAlias: 'dashboard' },
  { line: 'history',                      expectedAlias: 'history' },
  { line: 'markets',                      expectedAlias: 'markets' },
  { line: 'markets crypto',               expectedAlias: 'markets' },
  { line: 'markets sol',                  expectedAlias: 'markets' },
  { line: 'price SOL',                    expectedAlias: 'price' },
  { line: 'verify',                       expectedAlias: 'verify' },
  { line: 'delegation',                   expectedAlias: 'delegation' },
  { line: 'er-health',                    expectedAlias: 'er-health' },
  { line: 'health',                       expectedAlias: 'api-health' },
  { line: 'api-health',                   expectedAlias: 'api-health' },
  { line: 'tokens',                       expectedAlias: 'tokens' },
  { line: 'prices',                       expectedAlias: 'prices' },
  { line: 'prices SOL',                   expectedAlias: 'prices' },
  { line: 'pool-data',                    expectedAlias: 'pool-data' },
  { line: 'pool-data HfF7GCcEc76xubFCHLLXRdYcgRzwjEPdfKWqzRS8Ncog', expectedAlias: 'pool-data' },
  { line: 'raw markets',                  expectedAlias: 'raw' },
  { line: 'raw basket 7Gv4abc111111111111111111111111111111111', expectedAlias: 'raw' },
  { line: 'snapshot',                     expectedAlias: 'snapshot' },
  { line: 'snapshot 11111111111111111111111111111111', expectedAlias: 'snapshot' },
  { line: 'preview margin {"marketSymbol":"SOL","side":"LONG","marginDeltaUsdUi":"1","action":"ADD","owner":"11111111111111111111111111111111"}', expectedAlias: 'preview' },
  { line: 'builder open-position {"inputTokenSymbol":"USDC","outputTokenSymbol":"SOL","inputAmountUi":"5","leverage":2,"tradeType":"LONG"}', expectedAlias: 'builder' },
  { line: 'builder sign deposit {"owner":"11111111111111111111111111111111","tokenSymbol":"USDC","amount":"1"}', expectedAlias: 'builder' },
  { line: 'stream 11111111111111111111111111111111 1000 2', expectedAlias: 'basket-stream' },
  { line: 'alerts on',                    expectedAlias: 'alerts' },
  { line: 'alerts off',                   expectedAlias: 'alerts' },
  { line: 'alerts status',                expectedAlias: 'alerts' },
  { line: 'status',                       expectedAlias: 'status' },
  { line: 'setup',                        expectedAlias: 'setup' },
  { line: 'faucet',                       expectedAlias: 'faucet' },
  { line: 'liquidate 7Gv4abc111111111111111111111111111111111 SOL long', expectedAlias: 'liquidate' },
  // Tolerance: leading `magic ` prefix
  { line: 'magic vault',                  expectedAlias: 'vault' },
  { line: 'magic deposit USDC 50',        expectedAlias: 'deposit' },
];

describe('parseCommand → tool schema', () => {
  for (const { line, expectedAlias } of HELP_COMMANDS) {
    it(`"${line}" dispatches to ${expectedAlias} with valid params`, () => {
      const parsed = parseCommandForTest(line, config);
      expect(parsed, `parser returned null for "${line}"`).not.toBeNull();
      expect(parsed!.alias).toBe(expectedAlias);
      const tool = toolByAlias.get(expectedAlias);
      expect(tool, `no tool registered for alias ${expectedAlias}`).toBeDefined();
      if (tool!.parameters) {
        const result = (tool!.parameters as z.ZodTypeAny).safeParse(parsed!.params);
        if (!result.success) {
          throw new Error(
            `schema rejected params for "${line}": ${JSON.stringify(parsed!.params)}\n` +
              result.error.issues.map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`).join('\n'),
          );
        }
      }
    });
  }
});

describe('market command parameters', () => {
  it('keeps category filters distinct from symbol filters', () => {
    expect(parseCommandForTest('markets crypto', config)).toMatchObject({
      alias: 'markets',
      params: { category: 'crypto' },
    });
    expect(parseCommandForTest('markets sol', config)).toMatchObject({
      alias: 'markets',
      params: { filter: 'SOL' },
    });
  });
});
