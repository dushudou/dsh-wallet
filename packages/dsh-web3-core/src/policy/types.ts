/**
 * Types for the declarative signing-policy engine.
 *
 * A {@link SigningPolicy} decides, for every signing request, whether the
 * wallet signs autonomously (`allow`), refuses (`deny`), or surfaces a human
 * approval prompt (`ask`). Rules are evaluated in priority order and the
 * first match wins; requests matching no rule fall back to
 * {@link SigningPolicy.defaultEffect}.
 *
 * @module dsh-web3-core/policy/types
 */

import type { AccountMeta } from '../types.js';
import type { Intent, IntentKind } from '../intent.js';

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
  /** Maximum number of signed operations over a rolling 24h window (transactions counted). */
  maxCountPerDay?: number;
  /** Minimum seconds between two operations to the same recipient. */
  cooldownSeconds?: number;
  /** Only allow operations whose target (tx `to` / typed-data verifying contract) is in this allowlist. */
  allowedAssets?: string[];
  /** Force human approval for recipients not seen before (and not in the `to` allowlist). */
  firstSeenAsk?: boolean;
  /** Maximum calldata length in bytes (inclusive). */
  maxDataLength?: number;
  /** Maximum message/typed-data payload length in bytes (inclusive). */
  maxMessageLength?: number;
  /**
   * Restrict the rule to decoded intents (see `classifyTransaction` /
   * `classifyTypedData`). An `allow` rule only auto-signs an asset-moving or
   * permission-granting intent (token/NFT transfer, approval, permit,
   * transfer authorization, order) when that intent is listed here — rules
   * written for native value never silently cover token moves.
   */
  intents?: IntentKind[];
  /**
   * Final asset recipients this rule covers: the decoded recipient for token
   * transfers / transfer authorizations, the tx `to` otherwise. Checksummed.
   */
  recipients?: string[];
  /**
   * Per-token amount caps for fungible-token intents. An `allow` rule only
   * auto-signs a token amount when the token is listed here and the amount
   * fits both caps; otherwise the decision is downgraded to `ask`.
   */
  tokenLimits?: TokenLimit[];
}

/** Amount caps for one fungible token, in its atomic units. */
export interface TokenLimit {
  /** Token contract address. */
  token: string;
  /** Optional display symbol (informational). */
  symbol?: string;
  /** Maximum amount per operation (decimal atomic units). */
  maxPerTx?: string;
  /** Maximum aggregate amount over a rolling 24h window (decimal atomic units). */
  maxPerDay?: string;
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
  /** Decoded effect; derived from `data` / `typedData` when omitted. */
  intent?: Intent;
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
  /** Built-in guardrail that downgraded an `allow` to `ask`, when one fired. */
  guardrail?: string;
  /** Hard wallet limit that refused the request (see `checkLimits`), when one fired. */
  limit?: { code: 'RECIPIENT_NOT_WHITELISTED' | 'LIMIT_EXCEEDED'; name: string };
  /** Security findings (warn or stronger) that shaped the decision (see `escalateDecision`). */
  risk?: { severity: 'info' | 'warn' | 'high' | 'critical'; codes: string[] };
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
  /** Decoded intent kind. */
  intent?: IntentKind;
  /** Token contract for token intents. */
  token?: string;
  /** Final asset recipient, when decoded. */
  recipient?: string;
  /** Spender / operator for approvals and permits. */
  spender?: string;
  /** Token amount in atomic units, when decoded. */
  amount?: string;
  /** Effectively unlimited approval / permit. */
  unlimited?: boolean;
}
