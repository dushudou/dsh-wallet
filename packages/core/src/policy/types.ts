/**
 * Types for the declarative signing-policy engine.
 *
 * A {@link SigningPolicy} decides, for every signing request, whether the
 * wallet signs autonomously (`allow`), refuses (`deny`), or surfaces a human
 * approval prompt (`ask`). Rules are evaluated in priority order and the
 * first match wins; requests matching no rule fall back to
 * {@link SigningPolicy.defaultEffect}.
 *
 * @module @dsh-wallet/core/policy/types
 */

import type { AccountMeta } from '../types.js';

/** What the policy decided. */
export type PolicyEffect = 'allow' | 'deny' | 'ask';

/** The kind of signing operation being authorized. */
export type SigningOperationType = 'signTransaction' | 'signMessage' | 'signTypedData';

/** Matchers for one rule. Every present field must match (AND). */
export interface PolicyRuleMatch {
  /** Restrict to operation types. */
  type?: SigningOperationType | SigningOperationType[];
  /** Restrict to chain ids (transactions and typed data only). */
  chainIds?: number[];
  /** Recipient address (transaction `to`, typed-data verifying contract). Checksummed. */
  to?: string | string[];
  /** Signer account address. Checksummed. */
  from?: string | string[];
  /** Calldata method selectors this rule covers (0x + 4 bytes hex). */
  selectors?: string[];
  /** Minimum transaction value in wei per operation (inclusive) - matches large transfers. */
  minTxValue?: string;
  /** Maximum transaction value in wei per operation (inclusive). */
  maxTxValue?: string;
  /** Maximum aggregate signed value in wei over a rolling 24h window. */
  maxValuePerDay?: string;
  /** Maximum calldata length in bytes (inclusive). */
  maxDataLength?: number;
  /** Maximum message/typed-data payload length in bytes (inclusive). */
  maxMessageLength?: number;
}

/** One policy rule. */
export interface PolicyRule {
  /** Stable rule id. */
  id: string;
  /** Human explanation shown in approval prompts and audit entries. */
  description?: string;
  /** Disable without deleting. Defaults to true. */
  enabled?: boolean;
  /** Higher priority evaluates first. Defaults to 0. */
  priority?: number;
  effect: PolicyEffect;
  match: PolicyRuleMatch;
}

/** The whole policy document persisted as `policy.json`. */
export interface SigningPolicy {
  version: 1;
  updatedAt: string;
  /** Decision for requests no rule matched. Defaults to `ask`. */
  defaultEffect: PolicyEffect;
  rules: PolicyRule[];
}

/** The request being authorized. */
export interface PolicyRequest {
  type: SigningOperationType;
  /** Signer account. */
  account: Pick<AccountMeta, 'address'> & Partial<AccountMeta>;
  /** Chain id for transactions and typed data. */
  chainId?: number;
  /** Transaction recipient or typed-data verifying contract. */
  to?: string;
  /** Transaction value in wei. */
  value?: string;
  /** Transaction calldata (0x hex). */
  data?: string;
  /** Method selector extracted from calldata, when present. */
  selector?: string;
  /** Human-readable message for signMessage. */
  message?: string;
  /** Serialized typed-data payload for signTypedData. */
  typedData?: string;
}

/** Why and how the policy decided. */
export interface PolicyDecision {
  effect: PolicyEffect;
  /** Id of the matched rule, when one matched. */
  ruleId?: string;
  /** Human-readable explanation safe for logs and UI. */
  reason: string;
  /** The request as evaluated (already secret-free). */
  request: PolicySummary;
  /** Rolling-24h spend in wei at decision time (transactions only). */
  spentLast24hWei?: string;
  /** Whether the request stays inside the matched rule's daily cap. */
  withinDailyCap?: boolean;
}

/** Secret-free summary of a request, used in decisions and audit entries. */
export interface PolicySummary {
  type: SigningOperationType;
  from?: string;
  chainId?: number;
  to?: string;
  valueWei?: string;
  dataLengthBytes?: number;
  selector?: string;
  messageLengthBytes?: number;
}
