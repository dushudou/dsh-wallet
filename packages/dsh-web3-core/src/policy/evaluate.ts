/**
 * Pure policy evaluation: (policy, request, spend) -> decision.
 *
 * Deterministic and side-effect free so it can be unit-tested exhaustively,
 * replayed in audit reviews, and dry-run (`wallet_prepare_transaction`)
 * without ever touching a key.
 *
 * @module dsh-web3-core/policy/evaluate
 */

import type {
  PolicyDecision,
  PolicyEffect,
  PolicyRequest,
  PolicyRule,
  PolicySummary,
  SigningPolicy,
} from './types.js';

/** Extract the 4-byte selector from calldata, or undefined. */
export function selectorOfData(data: string | undefined): string | undefined {
  if (data === undefined) return undefined;
  const trimmed = data.trim();
  if (!trimmed.startsWith('0x') || trimmed.length < 10) return undefined;
  if (!/^0x[0-9a-fA-F]+$/.test(trimmed)) return undefined;
  return `0x${trimmed.slice(2, 10).toLowerCase()}`;
}

/** Build the secret-free summary of a request. */
export function summarizeRequest(request: PolicyRequest): PolicySummary {
  return {
    type: request.type,
    from: request.account?.address,
    chainId: request.chainId,
    to: request.to,
    valueWei: request.value,
    dataLengthBytes: request.data !== undefined ? (request.data.length - 2) / 2 : undefined,
    selector: request.selector ?? selectorOfData(request.data),
    messageLengthBytes:
      request.message !== undefined
        ? Buffer.byteLength(request.message, 'utf8')
        : request.typedData !== undefined
          ? Buffer.byteLength(request.typedData, 'utf8')
          : undefined,
  };
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function addressList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [value];
  const normalized = list.map(normalizeAddress);
  return normalized.length > 0 ? normalized : undefined;
}

function matchOneRule(rule: PolicyRule, request: PolicyRequest, spentLast24hWei: bigint): {
  matched: boolean;
  withinDailyCap: boolean;
  reason: string;
} {
  const match = rule.match ?? {};

  const types = match.type === undefined ? undefined : Array.isArray(match.type) ? match.type : [match.type];
  if (types !== undefined && !types.includes(request.type)) {
    return { matched: false, withinDailyCap: true, reason: `operation type ${request.type} not in rule` };
  }

  if (match.chainIds !== undefined && request.chainId === undefined) {
    return { matched: false, withinDailyCap: true, reason: 'request has no chain id' };
  }
  if (match.chainIds !== undefined && request.chainId !== undefined && !match.chainIds.includes(request.chainId)) {
    return { matched: false, withinDailyCap: true, reason: `chain ${String(request.chainId)} not in rule` };
  }

  const toList = addressList(match.to);
  if (toList !== undefined) {
    if (request.to === undefined) return { matched: false, withinDailyCap: true, reason: 'request has no recipient' };
    if (!toList.includes(normalizeAddress(request.to))) {
      return { matched: false, withinDailyCap: true, reason: 'recipient not in rule allowlist' };
    }
  }

  const fromList = addressList(match.from);
  if (fromList !== undefined) {
    const from = request.account?.address;
    if (from === undefined) return { matched: false, withinDailyCap: true, reason: 'request has no signer' };
    if (!fromList.includes(normalizeAddress(from))) {
      return { matched: false, withinDailyCap: true, reason: 'signer not in rule allowlist' };
    }
  }

  if (match.selectors !== undefined && match.selectors.length > 0) {
    const selector = request.selector ?? selectorOfData(request.data);
    if (selector === undefined) return { matched: false, withinDailyCap: true, reason: 'request has no selector' };
    const wanted = match.selectors.map((entry) => entry.trim().toLowerCase());
    if (!wanted.includes(selector.toLowerCase())) {
      return { matched: false, withinDailyCap: true, reason: 'selector not in rule list' };
    }
  }

  if (match.minTxValue !== undefined) {
    const floor = BigInt(match.minTxValue);
    const value = BigInt(request.value ?? '0');
    if (value < floor) {
      return { matched: false, withinDailyCap: true, reason: `value below the rule's minimum threshold` };
    }
  }

  if (match.maxTxValue !== undefined) {
    const cap = BigInt(match.maxTxValue);
    const value = BigInt(request.value ?? '0');
    if (value > cap) {
      return { matched: false, withinDailyCap: true, reason: `value exceeds per-tx cap` };
    }
  }

  let withinDailyCap = true;
  if (match.maxValuePerDay !== undefined) {
    const cap = BigInt(match.maxValuePerDay);
    const value = BigInt(request.value ?? '0');
    withinDailyCap = spentLast24hWei + value <= cap;
    if (!withinDailyCap) {
      // The rule still "matched" - the cap is part of its scope - but the
      // aggregate gate fails, so we surface it instead of falling through to
      // unrelated rules.
      return { matched: true, withinDailyCap: false, reason: `rolling-24h value cap of ${match.maxValuePerDay} wei exceeded` };
    }
  }

  if (match.maxDataLength !== undefined) {
    const length = request.data !== undefined ? (request.data.length - 2) / 2 : 0;
    if (length > match.maxDataLength) {
      return { matched: false, withinDailyCap: true, reason: 'calldata longer than rule allows' };
    }
  }

  if (match.maxMessageLength !== undefined) {
    const length =
      request.message !== undefined
        ? Buffer.byteLength(request.message, 'utf8')
        : request.typedData !== undefined
          ? Buffer.byteLength(request.typedData, 'utf8')
          : 0;
    if (length > match.maxMessageLength) {
      return { matched: false, withinDailyCap: true, reason: 'message longer than rule allows' };
    }
  }

  return { matched: true, withinDailyCap: true, reason: 'all rule matchers satisfied' };
}

/** Sort rules for evaluation: enabled first, then higher priority, then stable by id. */
export function orderedRules(policy: SigningPolicy): PolicyRule[] {
  return [...policy.rules]
    .filter((rule) => rule.enabled !== false)
    .sort((a, b) => {
      const pa = a.priority ?? 0;
      const pb = b.priority ?? 0;
      if (pa !== pb) return pb - pa;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/**
 * Evaluate a signing request against the policy.
 *
 * @param policy - the persisted policy document.
 * @param request - the signing request to authorize.
 * @param spentLast24hWei - rolling-24h already-signed value (transactions).
 * @returns the decision, always; the caller maps `ask` to a human approval.
 */
export function evaluatePolicy(
  policy: SigningPolicy,
  request: PolicyRequest,
  spentLast24hWei = 0n,
): PolicyDecision {
  const summary = summarizeRequest(request);
  for (const rule of orderedRules(policy)) {
    const outcome = matchOneRule(rule, request, spentLast24hWei);
    if (!outcome.matched) continue;
    const description = rule.description !== undefined ? ` (${rule.description})` : '';
    return {
      effect: rule.effect,
      ruleId: rule.id,
      reason: `matched rule "${rule.id}"${description}: ${outcome.reason}`,
      request: summary,
      ...(rule.match.maxValuePerDay !== undefined ? { withinDailyCap: outcome.withinDailyCap } : {}),
      ...(request.type === 'signTransaction' ? { spentLast24hWei: spentLast24hWei.toString() } : {}),
    };
  }
  const fallback: PolicyEffect = policy.defaultEffect;
  return {
    effect: fallback,
    reason: `no rule matched; policy default is "${fallback}"`,
    request: summary,
    ...(request.type === 'signTransaction' ? { spentLast24hWei: spentLast24hWei.toString() } : {}),
  };
}

/** Structural validation used before persisting a policy document. */
export function validatePolicy(policy: SigningPolicy): string[] {
  const errors: string[] = [];
  if (policy.version !== 1) errors.push('policy.version must be 1');
  if (!['allow', 'deny', 'ask'].includes(policy.defaultEffect)) {
    errors.push(`invalid defaultEffect ${JSON.stringify(policy.defaultEffect)}`);
  }
  if (!Array.isArray(policy.rules)) errors.push('policy.rules must be an array');
  const seen = new Set<string>();
  for (const [index, rule] of (policy.rules ?? []).entries()) {
    if (typeof rule.id !== 'string' || rule.id.length === 0) errors.push(`rules[${String(index)}].id missing`);
    if (seen.has(rule.id)) errors.push(`duplicate rule id "${rule.id}"`);
    seen.add(rule.id);
    if (!['allow', 'deny', 'ask'].includes(rule.effect)) {
      errors.push(`rules[${String(index)}].effect invalid: ${JSON.stringify(rule.effect)}`);
    }
    if (rule.match.minTxValue !== undefined && !/^\d+$/.test(rule.match.minTxValue)) {
      errors.push(`rules[${String(index)}].match.minTxValue must be a decimal wei string`);
    }
    if (rule.match.maxTxValue !== undefined && !/^\d+$/.test(rule.match.maxTxValue)) {
      errors.push(`rules[${String(index)}].match.maxTxValue must be a decimal wei string`);
    }
    if (rule.match.maxValuePerDay !== undefined && !/^\d+$/.test(rule.match.maxValuePerDay)) {
      errors.push(`rules[${String(index)}].match.maxValuePerDay must be a decimal wei string`);
    }
  }
  return errors;
}
