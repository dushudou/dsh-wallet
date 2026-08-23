import { describe, expect, it } from 'vitest';
import { evaluatePolicy, orderedRules, selectorOfData, summarizeRequest, validatePolicy } from '../src/policy/evaluate.js';
import { policyPreset } from '../src/policy/presets.js';
import type { PolicyRequest, SigningPolicy } from '../src/policy/types.js';

const ACCOUNT = { address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' };
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function txRequest(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    type: 'signTransaction',
    account: ACCOUNT,
    chainId: 1,
    to: RECIPIENT,
    value: '1000000000000000',
    data: '0x',
    ...overrides,
  };
}

describe('policy evaluation', () => {
  it('falls back to the default effect when nothing matches', () => {
    const policy = policyPreset('strict');
    const decision = evaluatePolicy(policy, txRequest());
    expect(decision.effect).toBe('ask');
    expect(decision.ruleId).toBeUndefined();
    expect(decision.reason).toContain('no rule matched');
  });

  it('honors higher priority first', () => {
    const policy: SigningPolicy = {
      version: 1,
      updatedAt: new Date().toISOString(),
      defaultEffect: 'deny',
      rules: [
        { id: 'low', effect: 'allow', priority: 1, match: { type: 'signTransaction' } },
        { id: 'high', effect: 'deny', priority: 10, match: { type: 'signTransaction' } },
      ],
    };
    const decision = evaluatePolicy(policy, txRequest());
    expect(decision.effect).toBe('deny');
    expect(decision.ruleId).toBe('high');
  });

  it('skips disabled rules', () => {
    const policy: SigningPolicy = {
      version: 1,
      updatedAt: new Date().toISOString(),
      defaultEffect: 'deny',
      rules: [{ id: 'off', effect: 'allow', enabled: false, priority: 100, match: {} }],
    };
    expect(evaluatePolicy(policy, txRequest()).effect).toBe('deny');
  });

  it('matches chain ids case-sensitively and falls through on mismatch', () => {
    const policy: SigningPolicy = {
      version: 1,
      updatedAt: new Date().toISOString(),
      defaultEffect: 'ask',
      rules: [{ id: 'sepolia', effect: 'allow', priority: 10, match: { chainIds: [11155111] } }],
    };
    expect(evaluatePolicy(policy, txRequest({ chainId: 11155111 })).effect).toBe('allow');
    expect(evaluatePolicy(policy, txRequest({ chainId: 1 })).effect).toBe('ask');
  });

  it('matches recipient allowlists case-insensitively', () => {
    const policy: SigningPolicy = {
      version: 1,
      updatedAt: new Date().toISOString(),
      defaultEffect: 'deny',
      rules: [{ id: 'friend', effect: 'allow', priority: 10, match: { to: [RECIPIENT.toLowerCase()] } }],
    };
    expect(evaluatePolicy(policy, txRequest()).effect).toBe('allow');
    expect(evaluatePolicy(policy, txRequest({ to: '0x000000000000000000000000000000000000dead' })).effect).toBe('deny');
  });

  it('enforces per-transaction value caps', () => {
    const policy: SigningPolicy = {
      version: 1,
      updatedAt: new Date().toISOString(),
      defaultEffect: 'deny',
      rules: [{ id: 'cap', effect: 'allow', priority: 10, match: { maxTxValue: '1000000000000000' } }],
    };
    expect(evaluatePolicy(policy, txRequest({ value: '1000000000000000' })).effect).toBe('allow');
    expect(evaluatePolicy(policy, txRequest({ value: '1000000000000001' })).effect).toBe('deny');
  });

  it('matches large transfers via minTxValue for hard ceilings', () => {
    const policy: SigningPolicy = {
      version: 1,
      updatedAt: new Date().toISOString(),
      defaultEffect: 'ask',
      rules: [{ id: 'too-big', effect: 'deny', priority: 10, match: { minTxValue: '50000000000000000' } }],
    };
    expect(evaluatePolicy(policy, txRequest({ value: '49999999999999999' })).effect).toBe('ask');
    expect(evaluatePolicy(policy, txRequest({ value: '50000000000000000' })).effect).toBe('deny');
    expect(evaluatePolicy(policy, txRequest({ value: '100000000000000000' })).effect).toBe('deny');
  });

  it('enforces rolling-24h daily caps', () => {
    const policy: SigningPolicy = {
      version: 1,
      updatedAt: new Date().toISOString(),
      defaultEffect: 'deny',
      rules: [{ id: 'daily', effect: 'allow', priority: 10, match: { maxValuePerDay: '1000000000000000000' } }],
    };
    // Already spent 0.9 ETH; a 0.2 ETH tx breaches the 1 ETH daily cap.
    const decision = evaluatePolicy(policy, txRequest({ value: '200000000000000000' }), 900000000000000000n);
    expect(decision.ruleId).toBe('daily');
    expect(decision.withinDailyCap).toBe(false);
    expect(decision.reason).toContain('cap');
    // 0.05 ETH still fits.
    const ok = evaluatePolicy(policy, txRequest({ value: '50000000000000000' }), 900000000000000000n);
    expect(ok.effect).toBe('allow');
    expect(ok.withinDailyCap).toBe(true);
    expect(ok.spentLast24hWei).toBe('900000000000000000');
  });

  it('matches calldata selectors', () => {
    const transferSelector = '0xa9059cbb'; // transfer(address,uint256)
    const policy: SigningPolicy = {
      version: 1,
      updatedAt: new Date().toISOString(),
      defaultEffect: 'ask',
      rules: [
        { id: 'erc20', effect: 'allow', priority: 10, match: { selectors: [transferSelector] } },
      ],
    };
    const data = `${transferSelector}${'00'.repeat(64)}`;
    expect(evaluatePolicy(policy, txRequest({ data, to: '0x000000000000000000000000000000000000dead' })).effect).toBe('allow');
    expect(evaluatePolicy(policy, txRequest({ data: '0xdeadbeef' })).effect).toBe('ask');
  });

  it('separates message and typed-data operations', () => {
    const policy: SigningPolicy = {
      version: 1,
      updatedAt: new Date().toISOString(),
      defaultEffect: 'deny',
      rules: [{ id: 'msg-only', effect: 'allow', priority: 10, match: { type: 'signMessage' } }],
    };
    expect(evaluatePolicy(policy, { type: 'signMessage', account: ACCOUNT, message: 'hello' }).effect).toBe('allow');
    expect(evaluatePolicy(policy, { type: 'signTypedData', account: ACCOUNT, typedData: '{}' }).effect).toBe('deny');
    expect(evaluatePolicy(policy, txRequest()).effect).toBe('deny');
  });

  it('binds rules to signer addresses', () => {
    const policy: SigningPolicy = {
      version: 1,
      updatedAt: new Date().toISOString(),
      defaultEffect: 'deny',
      rules: [{ id: 'only-me', effect: 'allow', priority: 10, match: { from: [ACCOUNT.address] } }],
    };
    expect(evaluatePolicy(policy, txRequest()).effect).toBe('allow');
    expect(
      evaluatePolicy(policy, txRequest({ account: { address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' } })).effect,
    ).toBe('deny');
  });
});

describe('policy utilities', () => {
  it('extracts selectors from calldata', () => {
    expect(selectorOfData('0xa9059cbb' + '00'.repeat(64))).toBe('0xa9059cbb');
    expect(selectorOfData('0x')).toBeUndefined();
    expect(selectorOfData(undefined)).toBeUndefined();
    expect(selectorOfData('nothex')).toBeUndefined();
  });

  it('summarizes requests without secrets', () => {
    const summary = summarizeRequest(txRequest({ data: '0xdeadbeef' }));
    expect(summary.from).toBe(ACCOUNT.address);
    expect(summary.valueWei).toBe('1000000000000000');
    expect(summary.dataLengthBytes).toBe(4);
    expect(summary.selector).toBe('0xdeadbeef');
  });

  it('orders rules by priority then id', () => {
    const policy: SigningPolicy = {
      version: 1,
      updatedAt: new Date().toISOString(),
      defaultEffect: 'ask',
      rules: [
        { id: 'b', effect: 'allow', priority: 5, match: {} },
        { id: 'a', effect: 'deny', priority: 5, match: {} },
        { id: 'z', effect: 'allow', priority: 50, match: {} },
        { id: 'disabled', effect: 'allow', priority: 500, enabled: false, match: {} },
      ],
    };
    expect(orderedRules(policy).map((rule) => rule.id)).toEqual(['z', 'a', 'b']);
  });

  it('validates policy documents', () => {
    const good = policyPreset('strict');
    expect(validatePolicy(good)).toEqual([]);
    expect(validatePolicy({ ...good, defaultEffect: 'maybe' as never })).not.toEqual([]);
    expect(validatePolicy({ ...good, rules: [...good.rules, good.rules[0]!] })).not.toEqual([]);
    expect(
      validatePolicy({
        ...good,
        rules: [{ id: 'bad', effect: 'allow', match: { maxTxValue: 'not-a-number' } }],
      }),
    ).not.toEqual([]);
  });
});

describe('presets', () => {
  it('locked denies everything', () => {
    const policy = policyPreset('locked');
    expect(evaluatePolicy(policy, txRequest()).effect).toBe('deny');
    expect(evaluatePolicy(policy, { type: 'signMessage', account: ACCOUNT, message: 'hi' }).effect).toBe('deny');
  });

  it('strict auto-signs only on localhost chains', () => {
    const policy = policyPreset('strict');
    expect(evaluatePolicy(policy, txRequest({ chainId: 31337 })).effect).toBe('allow');
    expect(evaluatePolicy(policy, txRequest({ chainId: 1 })).effect).toBe('ask');
  });

  it('strict hard-denies transfers of 0.05 ether or more', () => {
    const policy = policyPreset('strict');
    const decision = evaluatePolicy(policy, txRequest({ chainId: 31337, value: '50000000000000000' }));
    expect(decision.effect).toBe('deny');
    expect(decision.ruleId).toBe('deny-large-transfers');
  });

  it('testnet auto-signs capped testnet transfers but prompts on mainnet', () => {
    const policy = policyPreset('testnet');
    expect(evaluatePolicy(policy, txRequest({ chainId: 11155111, value: '1000' })).effect).toBe('allow');
    expect(evaluatePolicy(policy, txRequest({ chainId: 1 })).effect).toBe('ask');
    const overCap = evaluatePolicy(policy, txRequest({ chainId: 11155111, value: '2000000000000000000' }));
    expect(overCap.effect).not.toBe('allow');
  });
});
