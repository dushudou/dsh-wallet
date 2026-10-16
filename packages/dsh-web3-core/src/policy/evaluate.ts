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
  TokenLimit,
} from './types.js';
import {
  AMOUNT_INTENTS,
  SENSITIVE_INTENTS,
  classifySerializedTypedData,
  classifyTransaction,
  type Intent,
  type IntentKind,
} from '../intent.js';

const INTENT_KINDS: readonly IntentKind[] = [
  'native-transfer',
  'token-transfer',
  'token-approve',
  'token-revoke',
  'nft-transfer',
  'nft-approval',
  'contract-call',
  'permit',
  'permit-transfer',
  'transfer-authorization',
  'order',
  'typed-data',
  'message',
];

/** Intents whose amount counts toward a token's rolling-24h cap (value leaves the wallet). */
const SPENDING_INTENTS: readonly IntentKind[] = ['token-transfer', 'permit-transfer', 'transfer-authorization'];

/**
 * Coerce a chain id that may arrive as a numeric string or bigint (model
 * arguments, JSON typed-data domains) into a number, so `chainIds` matchers —
 * deny rules included — cannot be sidestepped by a type mismatch.
 */
export function normalizeChainId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(value.trim())) return Number(BigInt(value.trim()));
  return undefined;
}

/** The decoded intent of a request (explicit, or derived from its payload). */
export function intentOf(request: PolicyRequest): Intent | undefined {
  if (request.intent !== undefined) return request.intent;
  if (request.type === 'signTransaction') return classifyTransaction({ to: request.to, value: request.value, data: request.data });
  if (request.type === 'signTypedData') return classifySerializedTypedData(request.typedData) ?? { kind: 'typed-data' };
  return { kind: 'message' };
}

/** Where assets actually go: the decoded recipient, else the tx `to`. */
function effectiveRecipient(request: PolicyRequest): string | undefined {
  return request.intent?.recipient ?? request.to;
}

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
  const intent = intentOf(request);
  return {
    type: request.type,
    from: request.account?.address,
    chainId: normalizeChainId(request.chainId),
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
    ...(intent !== undefined ? { intent: intent.kind } : {}),
    ...(intent?.token !== undefined ? { token: intent.token } : {}),
    ...(intent?.recipient !== undefined ? { recipient: intent.recipient } : {}),
    ...(intent?.spender !== undefined ? { spender: intent.spender } : {}),
    ...(intent?.amount !== undefined ? { amount: intent.amount } : {}),
    ...(intent?.unlimited === true ? { unlimited: true } : {}),
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

/** Minimal view of a signed operation, for count / cooldown / first-seen checks. */
export interface PolicyEventView {
  ts: number;
  from: string;
  to?: string;
}

/** Extra evaluation inputs beyond the request (spend-derived history). */
export interface PolicyContext {
  /** Rolling-24h already-signed value (transactions), wei. */
  spentLast24hWei?: bigint;
  /** Signed-operation history for count / cooldown / first-seen checks. */
  events?: PolicyEventView[];
  /** Evaluation timestamp (defaults to Date.now()); pass a fixed value for determinism. */
  now?: number;
  /** Rolling-24h amount already spent of the intent's token (atomic units). */
  tokenSpentLast24h?: bigint;
}

function matchOneRule(
  rule: PolicyRule,
  request: PolicyRequest,
  spentLast24hWei: bigint,
  events: PolicyEventView[] = [],
  now = Date.now(),
): {
  matched: boolean;
  withinDailyCap: boolean;
  forceAsk?: boolean;
  reason: string;
} {
  const match = rule.match ?? {};

  const types = match.type === undefined ? undefined : Array.isArray(match.type) ? match.type : [match.type];
  if (types !== undefined && !types.includes(request.type)) {
    return { matched: false, withinDailyCap: true, reason: `operation type ${request.type} not in rule` };
  }

  if (match.intents !== undefined && match.intents.length > 0) {
    const kind = request.intent?.kind;
    if (kind === undefined || !match.intents.includes(kind)) {
      return { matched: false, withinDailyCap: true, reason: `intent ${String(kind)} not in rule` };
    }
  }

  const recipientList = addressList(match.recipients);
  if (recipientList !== undefined) {
    const recipient = effectiveRecipient(request);
    if (recipient === undefined || !recipientList.includes(normalizeAddress(recipient))) {
      return { matched: false, withinDailyCap: true, reason: 'recipient not in rule recipients' };
    }
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

  // Per-asset allowlist: tx `to` / typed-data verifying contract must be whitelisted.
  if (match.allowedAssets !== undefined && match.allowedAssets.length > 0) {
    const target = request.to;
    if (target === undefined) {
      return { matched: false, withinDailyCap: true, reason: 'request has no asset target' };
    }
    const wanted = match.allowedAssets.map(normalizeAddress);
    if (!wanted.includes(normalizeAddress(target))) {
      return { matched: false, withinDailyCap: true, reason: 'asset target not in rule allowlist' };
    }
  }

  // Daily operation-count gate (transactions only; spend history is tx-scoped).
  if (match.maxCountPerDay !== undefined && request.type === 'signTransaction') {
    const floor = now - 24 * 60 * 60 * 1000;
    const from = request.account?.address?.toLowerCase() ?? '';
    let count = 0;
    for (const event of events) {
      if (event.ts >= floor && event.from.toLowerCase() === from) count += 1;
    }
    if (count + 1 > match.maxCountPerDay) {
      return {
        matched: true,
        withinDailyCap: false,
        reason: `rolling-24h operation count cap of ${String(match.maxCountPerDay)} exceeded`,
      };
    }
  }

  // Per-recipient cooldown (transactions only).
  const recipient = effectiveRecipient(request);
  if (match.cooldownSeconds !== undefined && recipient !== undefined && request.type === 'signTransaction') {
    const from = request.account?.address?.toLowerCase() ?? '';
    const to = normalizeAddress(recipient);
    let lastTs = 0;
    for (const event of events) {
      if (event.from.toLowerCase() === from && event.to !== undefined && normalizeAddress(event.to) === to && event.ts > lastTs) {
        lastTs = event.ts;
      }
    }
    if (now - lastTs < match.cooldownSeconds * 1000) {
      return {
        matched: true,
        withinDailyCap: false,
        reason: `recipient in cooldown (${String(match.cooldownSeconds)}s since last op)`,
      };
    }
  }

  // First-seen gate: force approval for recipients never seen before (and not allowlisted).
  if (match.firstSeenAsk === true && recipient !== undefined) {
    const from = request.account?.address?.toLowerCase() ?? '';
    const to = normalizeAddress(recipient);
    const allowlisted = (addressList(match.to)?.includes(to) ?? false) || (recipientList?.includes(to) ?? false);
    let seen = false;
    for (const event of events) {
      if (event.from.toLowerCase() === from && event.to !== undefined && normalizeAddress(event.to) === to) {
        seen = true;
        break;
      }
    }
    if (!allowlisted && !seen) {
      return { matched: true, withinDailyCap: true, forceAsk: true, reason: 'recipient not seen before; requiring approval' };
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
  context: PolicyContext = {},
): PolicyDecision {
  // Normalize before matching: a string chain id or an undecoded payload must
  // never let a request slip past a deny rule or a guardrail.
  const chainId = normalizeChainId(request.chainId);
  const normalized: PolicyRequest = { ...request, ...(chainId !== undefined ? { chainId } : {}) };
  if (request.chainId !== undefined && chainId === undefined) delete normalized.chainId;
  const intent = intentOf(normalized);
  if (intent !== undefined) normalized.intent = intent;

  const summary = summarizeRequest(normalized);
  const events = context.events ?? [];
  const now = context.now ?? Date.now();
  const gateMatch =
    (rule: PolicyRule): boolean =>
      rule.match.maxValuePerDay !== undefined ||
      rule.match.maxCountPerDay !== undefined ||
      rule.match.cooldownSeconds !== undefined ||
      rule.match.firstSeenAsk === true;
  for (const rule of orderedRules(policy)) {
    const outcome = matchOneRule(rule, normalized, spentLast24hWei, events, now);
    if (!outcome.matched) continue;
    // A matched allow rule is downgraded to `ask` when a gate (daily value/count
    // cap, cooldown, first-seen) is tripped; first-seen also forces approval.
    const gated = outcome.forceAsk === true || (rule.effect === 'allow' && outcome.withinDailyCap === false);
    let effect: PolicyEffect = gated ? 'ask' : rule.effect;
    let reason = outcome.reason;
    let guardrail: string | undefined;
    if (effect === 'allow' && intent !== undefined) {
      const tripped = guardrailFor(rule, intent, context.tokenSpentLast24h ?? 0n);
      if (tripped !== undefined) {
        effect = 'ask';
        guardrail = tripped.id;
        reason = tripped.reason;
      }
    }
    const description = rule.description !== undefined ? ` (${rule.description})` : '';
    return {
      effect,
      ruleId: rule.id,
      reason: `matched rule "${rule.id}"${description}: ${reason}`,
      request: summary,
      ...(gateMatch(rule) ? { withinDailyCap: outcome.withinDailyCap } : {}),
      ...(guardrail !== undefined ? { guardrail } : {}),
      ...(request.type === 'signTransaction' ? { spentLast24hWei: spentLast24hWei.toString() } : {}),
    };
  }
  const fallback: PolicyEffect = policy.defaultEffect;
  // The default effect is a blanket rule: it never auto-signs sensitive intents.
  if (fallback === 'allow' && intent !== undefined && SENSITIVE_INTENTS.includes(intent.kind)) {
    return {
      effect: 'ask',
      reason: `no rule matched; default "allow" does not cover ${intent.kind} (requires an explicit rule)`,
      request: summary,
      guardrail: 'intent-not-covered',
      ...(request.type === 'signTransaction' ? { spentLast24hWei: spentLast24hWei.toString() } : {}),
    };
  }
  return {
    effect: fallback,
    reason: `no rule matched; policy default is "${fallback}"`,
    request: summary,
    ...(request.type === 'signTransaction' ? { spentLast24hWei: spentLast24hWei.toString() } : {}),
  };
}

function limitFor(limits: TokenLimit[] | undefined, token: string | undefined): TokenLimit | undefined {
  if (limits === undefined) return undefined;
  const wanted = token?.toLowerCase();
  return (
    (wanted !== undefined ? limits.find((limit) => limit.token.toLowerCase() === wanted) : undefined) ??
    limits.find((limit) => limit.token === '*')
  );
}

/**
 * Built-in guardrails applied on top of an `allow` rule. Rules written for
 * native value (`maxTxValue`, `chainIds` …) must not silently authorize token
 * moves or permissions, because those carry `value: 0`.
 */
function guardrailFor(rule: PolicyRule, intent: Intent, tokenSpentLast24h: bigint): { id: string; reason: string } | undefined {
  if (!SENSITIVE_INTENTS.includes(intent.kind)) return undefined;
  if (intent.unlimited === true) {
    return { id: 'unlimited-permission', reason: `${intent.kind} grants an unlimited permission; always requires human approval` };
  }
  if (!(rule.match.intents ?? []).includes(intent.kind)) {
    return { id: 'intent-not-covered', reason: `${intent.kind} is not explicitly listed in the rule's intents; requiring approval` };
  }
  if (!AMOUNT_INTENTS.includes(intent.kind)) return undefined;
  const limit = limitFor(rule.match.tokenLimits, intent.token);
  if (limit === undefined) {
    return { id: 'token-not-limited', reason: `token ${String(intent.token)} has no tokenLimits entry in the rule; requiring approval` };
  }
  const amount = BigInt(intent.amount ?? '0');
  if (limit.maxPerTx !== undefined && amount > BigInt(limit.maxPerTx)) {
    return { id: 'token-per-tx-cap', reason: `token amount ${amount.toString()} exceeds the per-operation cap ${limit.maxPerTx}` };
  }
  if (limit.maxPerDay !== undefined && SPENDING_INTENTS.includes(intent.kind) && tokenSpentLast24h + amount > BigInt(limit.maxPerDay)) {
    return { id: 'token-daily-cap', reason: `rolling-24h token cap ${limit.maxPerDay} would be exceeded` };
  }
  return undefined;
}

/** Structural validation used before persisting a policy document. */
export function validatePolicy(policy: SigningPolicy): string[] {
  const errors: string[] = [];
  if (policy.version !== 1) errors.push('policy.version must be 1');
  if (!['allow', 'deny', 'ask'].includes(policy.defaultEffect)) {
    errors.push(`invalid defaultEffect ${JSON.stringify(policy.defaultEffect)}`);
  }
  if (!Array.isArray(policy.rules)) errors.push('policy.rules must be an array');
  if (policy.autonomy !== undefined && policy.autonomy !== 'semi' && policy.autonomy !== 'full') {
    errors.push(`invalid autonomy ${JSON.stringify(policy.autonomy)}`);
  }
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
    if (rule.match.maxCountPerDay !== undefined && (!Number.isInteger(rule.match.maxCountPerDay) || rule.match.maxCountPerDay < 0)) {
      errors.push(`rules[${String(index)}].match.maxCountPerDay must be a non-negative integer`);
    }
    if (rule.match.cooldownSeconds !== undefined && (!Number.isInteger(rule.match.cooldownSeconds) || rule.match.cooldownSeconds < 0)) {
      errors.push(`rules[${String(index)}].match.cooldownSeconds must be a non-negative integer`);
    }
    if (rule.match.allowedAssets !== undefined && !Array.isArray(rule.match.allowedAssets)) {
      errors.push(`rules[${String(index)}].match.allowedAssets must be an array of addresses`);
    }
    if (rule.match.firstSeenAsk !== undefined && typeof rule.match.firstSeenAsk !== 'boolean') {
      errors.push(`rules[${String(index)}].match.firstSeenAsk must be a boolean`);
    }
    if (rule.match.intents !== undefined) {
      if (!Array.isArray(rule.match.intents) || rule.match.intents.some((kind) => !INTENT_KINDS.includes(kind))) {
        errors.push(`rules[${String(index)}].match.intents must list known intents (${INTENT_KINDS.join(', ')})`);
      }
    }
    if (rule.match.recipients !== undefined && !Array.isArray(rule.match.recipients)) {
      errors.push(`rules[${String(index)}].match.recipients must be an array of addresses`);
    }
    if (rule.match.tokenLimits !== undefined) {
      if (!Array.isArray(rule.match.tokenLimits)) {
        errors.push(`rules[${String(index)}].match.tokenLimits must be an array`);
      } else {
        for (const [limitIndex, limit] of rule.match.tokenLimits.entries()) {
          const where = `rules[${String(index)}].match.tokenLimits[${String(limitIndex)}]`;
          if (typeof limit?.token !== 'string' || (limit.token !== '*' && !/^0x[0-9a-fA-F]{40}$/.test(limit.token))) {
            errors.push(`${where}.token must be a 0x address or "*"`);
          }
          for (const key of ['maxPerTx', 'maxPerDay'] as const) {
            if (limit?.[key] !== undefined && !/^\d+$/.test(String(limit[key]))) {
              errors.push(`${where}.${key} must be a decimal atomic-unit string`);
            }
          }
        }
      }
    }
  }
  return errors;
}
