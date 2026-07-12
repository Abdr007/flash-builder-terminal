/**
 * Token/FAF surface — parser routing (stake / unstake / claim / referral).
 * Verifies the verbs map to the right alias + params so they reach the
 * correct verified builder. (On-chain execution is money-path and tested live.)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { interpretCommand, configureSymbols } from '../src/cli/interpreter.js';

beforeAll(() => configureSymbols(new Set(['SOL', 'BTC']), new Map()));

describe('token/FAF command parsing', () => {
  it('stake <amount>', () => {
    expect(interpretCommand('stake 100')).toEqual({ alias: 'stake', params: { amount: 100 } });
    expect(interpretCommand('stake 100 FAF')).toEqual({ alias: 'stake', params: { amount: 100 } });
    expect(interpretCommand('stake 12.5')).toEqual({ alias: 'stake', params: { amount: 12.5 } });
  });

  it('unstake <amount>', () => {
    expect(interpretCommand('unstake 50')).toEqual({ alias: 'unstake', params: { amount: 50 } });
    expect(interpretCommand('unstake 50 faf')).toEqual({ alias: 'unstake', params: { amount: 50 } });
  });

  it('claim + variants', () => {
    expect(interpretCommand('claim')).toEqual({ alias: 'claim', params: { kind: 'revenue' } });
    expect(interpretCommand('claim revenue')).toEqual({ alias: 'claim', params: { kind: 'revenue' } });
    expect(interpretCommand('claim rewards')).toEqual({ alias: 'claim', params: { kind: 'rewards' } });
    expect(interpretCommand('claim reward')).toEqual({ alias: 'claim', params: { kind: 'reward' } });
    expect(interpretCommand('claim rebate')).toEqual({ alias: 'claim', params: { kind: 'rebate' } });
  });

  it('referral: no-arg uses default, address override preserves base58 case', () => {
    expect(interpretCommand('referral')).toEqual({ alias: 'referral', params: {} });
    const addr = 'Dvvzg9rwaNfUqBSscoMZJa5CHFv8Lm94ngZrRyLGLfmK';
    expect(interpretCommand(`referral ${addr}`)).toEqual({ alias: 'referral', params: { referrer: addr } });
  });

  it('does NOT misfire on unrelated input', () => {
    expect(interpretCommand('stakeholder 5')).not.toMatchObject({ alias: 'stake' });
    expect(interpretCommand('claiming')).not.toMatchObject({ alias: 'claim' });
  });
});

describe('earn/FLP command parsing', () => {
  it('flp overview + aliases', () => {
    expect(interpretCommand('flp')).toEqual({ alias: 'flp', params: {} });
    expect(interpretCommand('earn')).toEqual({ alias: 'flp', params: {} });
    expect(interpretCommand('pools')).toEqual({ alias: 'flp', params: {} });
  });
  it('flp deposit — both arg orders', () => {
    expect(interpretCommand('flp deposit USDC 50')).toEqual({ alias: 'flp-deposit', params: { token: 'USDC', amount: 50 } });
    expect(interpretCommand('flp deposit 50 usdc')).toEqual({ alias: 'flp-deposit', params: { token: 'USDC', amount: 50 } });
  });
  it('flp withdraw + claim', () => {
    expect(interpretCommand('flp withdraw USDC 10')).toEqual({ alias: 'flp-withdraw', params: { token: 'USDC', amount: 10 } });
    expect(interpretCommand('flp claim')).toEqual({ alias: 'flp-claim', params: {} });
  });
});
