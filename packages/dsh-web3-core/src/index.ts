/**
 * dsh-web3-core - agent-safe EVM wallet core.
 *
 * Everything key-related is local and encrypted at rest; every signing
 * operation is authorized by a declarative policy before a key is touched.
 *
 * @module dsh-web3-core
 */

export * from './types.js';
export * from './crypto.js';
export * from './account.js';
export * from './chains.js';
export * from './redact.js';
export * from './audit.js';
export { WalletVault, VaultLockedError, AccountNotFoundError } from './vault.js';
export type { AccountSecret, UnlockedAccount, VaultConfig } from './vault.js';
export * from './signer.js';
export * from './provider.js';
export * from './policy/types.js';
export { evaluatePolicy, validatePolicy, summarizeRequest, selectorOfData, orderedRules } from './policy/evaluate.js';
export { policyPreset, detectPreset } from './policy/presets.js';
export type { PolicyPresetId } from './policy/presets.js';
export { SpendTracker } from './policy/spend.js';
