/**
 * Ready-made policy presets users can switch between with one call.
 *
 * @module dsh-web3-core/policy/presets
 */

import { randomUUID } from 'node:crypto';
import type { PolicyRule, SigningPolicy } from './types.js';

export type PolicyPresetId = 'locked' | 'strict' | 'testnet' | 'power';

function nowIso(): string {
  return new Date().toISOString();
}

function rule(rule: Omit<PolicyRule, 'id'> & { id?: string }): PolicyRule {
  return { id: rule.id ?? `r-${randomUUID().slice(0, 8)}`, ...rule };
}

/** Fresh copies of each preset. */
export function policyPreset(id: PolicyPresetId): SigningPolicy {
  switch (id) {
    case 'locked':
      // Read-only: every signing request is refused outright.
      return {
        version: 1,
        updatedAt: nowIso(),
        defaultEffect: 'deny',
        rules: [
          rule({
            id: 'deny-all',
            description: 'wallet is locked: all signing is disabled',
            priority: 1000,
            effect: 'deny',
            match: {},
          }),
        ],
      };
    case 'strict':
      // Recommended default: nothing signs without a human approval prompt.
      return {
        version: 1,
        updatedAt: nowIso(),
        defaultEffect: 'ask',
        rules: [
          rule({
            id: 'deny-large-transfers',
            description: 'hard ceiling: refuse transfers of 0.05 ether-equivalent or more outright',
            priority: 900,
            effect: 'deny',
            match: { type: 'signTransaction', minTxValue: '50000000000000000' },
          }),
          rule({
            id: 'allow-localhost',
            description: 'sign freely on local dev chains (anvil/hardhat)',
            priority: 500,
            effect: 'allow',
            match: { type: 'signTransaction', chainIds: [31337] },
          }),
        ],
      };
    case 'testnet':
      // Testnet autonomy with caps; mainnet still prompts.
      return {
        version: 1,
        updatedAt: nowIso(),
        defaultEffect: 'ask',
        rules: [
          rule({
            id: 'allow-testnet-transfers',
            description: 'auto-sign testnet transfers up to 1 native unit per tx and 5 per day',
            priority: 800,
            effect: 'allow',
            match: {
              type: 'signTransaction',
              chainIds: [11155111, 80002, 84532, 421614, 11155420, 17000, 31337],
              maxTxValue: '1000000000000000000',
              maxValuePerDay: '5000000000000000000',
            },
          }),
          rule({
            id: 'allow-testnet-signing',
            description: 'auto-sign plain messages and typed data on testnets',
            priority: 700,
            effect: 'allow',
            match: {
              type: ['signMessage', 'signTypedData'],
              chainIds: [11155111, 80002, 84532, 421614, 11155420, 17000, 31337],
            },
          }),
        ],
      };
    case 'power':
      // Autonomy everywhere, but value-capped on mainnets.
      return {
        version: 1,
        updatedAt: nowIso(),
        defaultEffect: 'ask',
        rules: [
          rule({
            id: 'mainnet-small-transfers',
            description: 'auto-sign mainnet transfers up to 0.01 ether per tx, 0.05 ether per day',
            priority: 800,
            effect: 'allow',
            match: {
              type: 'signTransaction',
              chainIds: [1, 10, 56, 100, 137, 8453, 42161, 43114],
              maxTxValue: '10000000000000000',
              maxValuePerDay: '50000000000000000',
            },
          }),
          rule({
            id: 'mainnet-free-messages',
            description: 'auto-sign personal messages on mainnets (typed data still prompts)',
            priority: 700,
            effect: 'allow',
            match: { type: 'signMessage' },
          }),
          rule({
            id: 'allow-testnet-everything',
            description: 'auto-sign everything on testnets with a per-day value cap',
            priority: 600,
            effect: 'allow',
            match: {
              chainIds: [11155111, 80002, 84532, 421614, 11155420, 17000, 31337],
              maxValuePerDay: '10000000000000000000',
            },
          }),
        ],
      };
  }
}

/** The preset id a policy document was generated from, when detectable. */
export function detectPreset(policy: SigningPolicy): PolicyPresetId | undefined {
  const presets: PolicyPresetId[] = ['locked', 'strict', 'testnet', 'power'];
  for (const id of presets) {
    const preset = policyPreset(id);
    const a = JSON.stringify({ ...preset, updatedAt: 0, rules: preset.rules.map((r) => ({ ...r, id: 'x', description: r.description })) });
    const b = JSON.stringify({ ...policy, updatedAt: 0, rules: policy.rules.map((r) => ({ ...r, id: 'x', description: r.description })) });
    if (a === b) return id;
  }
  return undefined;
}
