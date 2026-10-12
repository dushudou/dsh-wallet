/**
 * Pre-signing risk engine.
 *
 * Every operation that moves assets or grants permissions is described as a
 * {@link SecuritySubject} and run through a set of {@link RiskCheck}s in
 * parallel (each with its own time budget). Checks return structured
 * {@link RiskFinding}s; the strongest finding then *escalates* the signing
 * decision:
 *
 * ```text
 * critical → deny   (no rule and no human click can sign past it)
 * high     → ask    (even when a policy rule would auto-sign)
 * warn     → shown in the approval prompt and to the agent
 * info     → shown only
 * ```
 *
 * Escalation is monotonic: a security check can tighten a decision, never
 * loosen it — the same contract as the hard limits.
 *
 * @module dsh-web3-core/security
 */

import { readFile } from 'node:fs/promises';
import type { Intent } from './intent.js';
import type { PolicyDecision } from './policy/types.js';

/** How bad a finding is. */
export type RiskSeverity = 'info' | 'warn' | 'high' | 'critical';

/** One structured result of a risk check. */
export interface RiskFinding {
  /** Stable machine code, e.g. `ADDRESS_POISONING`, `DENYLISTED_ADDRESS`. */
  code: string;
  severity: RiskSeverity;
  /** Human/agent-readable explanation with full (never shortened) addresses. */
  message: string;
  /** Id of the check that produced it (`local`, `denylist`, `simulation` …). */
  check: string;
  /** The address the finding is about, when there is one. */
  address?: string;
}

/** Who an address is to the operation. */
export type CounterpartyRole = 'recipient' | 'spender' | 'contract' | 'verifying-contract';

/** What is about to be signed, in the shape every check consumes. */
export interface SecuritySubject {
  kind: 'transaction' | 'typed-data';
  chainId?: number;
  /** The signing account. */
  from: string;
  intent: Intent;
  /** The transaction as it will be signed (transactions only). */
  tx?: { to: string; value: bigint; data: string; gasLimit?: bigint };
  /** Addresses that receive assets, permissions, or the call itself. */
  counterparties: Array<{ role: CounterpartyRole; address: string }>;
}

/** Outcome of one check run. */
export interface CheckRun {
  id: string;
  status: 'ok' | 'skipped' | 'failed' | 'timeout';
  ms: number;
  /** Why it was skipped / how it failed. */
  note?: string;
}

/** A check's answer: findings, or an explicit skip (not applicable / unsupported). */
export type CheckResult = RiskFinding[] | { skipped: string; findings?: RiskFinding[] };

/** One pluggable risk check. */
export interface RiskCheck {
  id: string;
  /** Per-check time budget in ms (default {@link DEFAULT_CHECK_TIMEOUT_MS}). */
  timeoutMs?: number;
  run(subject: SecuritySubject, signal: AbortSignal): Promise<CheckResult>;
}

/** What to do when a check cannot complete (network error, timeout). */
export type OnUnavailable = 'warn' | 'ask' | 'deny';

/** The combined result of every check. */
export interface SecurityReport {
  /** Strongest finding severity, or `none`. */
  severity: RiskSeverity | 'none';
  /** Findings, strongest first. */
  findings: RiskFinding[];
  checks: CheckRun[];
}

/** Default per-check time budget. */
export const DEFAULT_CHECK_TIMEOUT_MS = 5_000;

const RANK: Record<RiskSeverity | 'none', number> = { none: 0, info: 1, warn: 2, high: 3, critical: 4 };

/** Numeric rank of a severity (`none` = 0 … `critical` = 4). */
export function severityRank(severity: RiskSeverity | 'none'): number {
  return RANK[severity];
}

/** The strongest severity among findings, or `none`. */
export function maxSeverity(findings: readonly RiskFinding[]): RiskSeverity | 'none' {
  let best: RiskSeverity | 'none' = 'none';
  for (const finding of findings) if (RANK[finding.severity] > RANK[best]) best = finding.severity;
  return best;
}

/** Build a finding (helper for checks). */
export function finding(check: string, code: string, severity: RiskSeverity, message: string, address?: string): RiskFinding {
  return { code, severity, message, check, ...(address !== undefined ? { address } : {}) };
}

/** Sort strongest first, dropping exact duplicates (same code + address + message). */
export function normalizeFindings(findings: readonly RiskFinding[]): RiskFinding[] {
  const seen = new Set<string>();
  const unique: RiskFinding[] = [];
  for (const entry of findings) {
    const key = `${entry.code}|${entry.address?.toLowerCase() ?? ''}|${entry.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
}

const UNAVAILABLE_SEVERITY: Record<OnUnavailable, RiskSeverity> = { warn: 'warn', ask: 'high', deny: 'critical' };

/**
 * Run every check in parallel, each under its own time budget.
 *
 * A check that throws or times out yields a `SECURITY_CHECK_UNAVAILABLE`
 * finding whose severity follows `onUnavailable` (warn → warn, ask → high,
 * deny → critical). A check that *skips* (not applicable, RPC lacks the
 * method) yields no finding.
 */
export async function runSecurityChecks(
  checks: readonly RiskCheck[],
  subject: SecuritySubject,
  options: { onUnavailable?: OnUnavailable; extraFindings?: readonly RiskFinding[] } = {},
): Promise<SecurityReport> {
  const onUnavailable = options.onUnavailable ?? 'warn';
  const runs: CheckRun[] = [];
  const collected: RiskFinding[] = [...(options.extraFindings ?? [])];
  await Promise.all(
    checks.map(async (check) => {
      const started = Date.now();
      const controller = new AbortController();
      const budget = check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve('timeout');
        }, budget);
        (timer as { unref?: () => void }).unref?.();
      });
      try {
        const result = await Promise.race([check.run(subject, controller.signal), timeout]);
        if (result === 'timeout') {
          runs.push({ id: check.id, status: 'timeout', ms: Date.now() - started, note: `no answer within ${String(budget)} ms` });
          collected.push(finding(check.id, 'SECURITY_CHECK_UNAVAILABLE', UNAVAILABLE_SEVERITY[onUnavailable], `security check "${check.id}" did not answer within ${String(budget)} ms`));
          return;
        }
        if (Array.isArray(result)) {
          runs.push({ id: check.id, status: 'ok', ms: Date.now() - started });
          collected.push(...result);
        } else {
          runs.push({ id: check.id, status: 'skipped', ms: Date.now() - started, note: result.skipped });
          collected.push(...(result.findings ?? []));
        }
      } catch (error) {
        const note = error instanceof Error ? error.message : String(error);
        runs.push({ id: check.id, status: 'failed', ms: Date.now() - started, note });
        collected.push(finding(check.id, 'SECURITY_CHECK_UNAVAILABLE', UNAVAILABLE_SEVERITY[onUnavailable], `security check "${check.id}" failed: ${note}`));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }),
  );
  const findings = normalizeFindings(collected);
  runs.sort((a, b) => a.id.localeCompare(b.id));
  return { severity: maxSeverity(findings), findings, checks: runs };
}

/**
 * Escalate a signing decision with a security report (never loosens it).
 *
 * - any `critical` finding → `deny` (ruleId `security:<CODE>`)
 * - any `high` finding turns an `allow` into `ask` (guardrail `security`)
 * - the decision always carries `risk` when there is a finding of `warn`+
 */
export function escalateDecision(decision: PolicyDecision, report: SecurityReport): PolicyDecision {
  const notable = report.findings.filter((entry) => RANK[entry.severity] >= RANK.warn);
  if (notable.length === 0) return decision;
  const risk = { severity: report.severity as RiskSeverity, codes: [...new Set(notable.map((entry) => entry.code))] };
  if (decision.effect === 'deny') return { ...decision, risk };
  const critical = report.findings.find((entry) => entry.severity === 'critical');
  if (critical !== undefined) {
    return {
      ...decision,
      effect: 'deny',
      ruleId: `security:${critical.code}`,
      reason: `Blocked by a security check: ${critical.message}. No approval can override this; only the user can change the security settings in DSH Settings → Web3 → Security.`,
      risk,
    };
  }
  const high = report.findings.find((entry) => entry.severity === 'high');
  if (high !== undefined && decision.effect === 'allow') {
    return {
      ...decision,
      effect: 'ask',
      guardrail: 'security',
      reason: `${decision.reason}; downgraded to human review by a security check: ${high.message}`,
      risk,
    };
  }
  return { ...decision, risk };
}

/** Prefix used when a finding is shown in plain text (approval prompts, warnings). */
export function severityMark(severity: RiskSeverity): string {
  return severity === 'critical' ? '⛔ CRITICAL' : severity === 'high' ? '⚠ HIGH RISK' : severity === 'warn' ? '⚠' : 'ℹ';
}

// ── settings (security.json) ───────────────────────────────────────────────

/** Built-in denylist feed ids. */
export type DenylistFeedId = 'ofac' | 'scamsniffer';

/** User-tunable security settings (`security.json` in the vault directory). */
export interface SecuritySettings {
  version: 1;
  updatedAt: string;
  /** Simulate transactions (`eth_simulateV1`) and reconcile against the intent. */
  simulation: boolean;
  /** Query the on-chain Chainalysis sanctions oracle where it is deployed. */
  sanctionsOracle: boolean;
  /** Downloaded denylists (refreshed daily). */
  feeds: Record<DenylistFeedId, boolean>;
  /** GoPlus address/token reputation (sends counterparty addresses to GoPlus). Off by default. */
  goplus: boolean;
  /** What a check that cannot answer means. */
  onUnavailable: OnUnavailable;
}

/** Defaults: every local/on-chain check on, external reputation off. */
export function defaultSecuritySettings(): SecuritySettings {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    simulation: true,
    sanctionsOracle: true,
    feeds: { ofac: true, scamsniffer: true },
    goplus: false,
    onUnavailable: 'warn',
  };
}

const ON_UNAVAILABLE: OnUnavailable[] = ['warn', 'ask', 'deny'];

/** Validate a candidate settings document; returns problems (empty = valid). */
export function validateSecuritySettings(raw: unknown): string[] {
  if (raw === null || typeof raw !== 'object') return ['settings must be an object'];
  const value = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (value.version !== undefined && value.version !== 1) errors.push('version must be 1');
  for (const key of ['simulation', 'sanctionsOracle', 'goplus'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') errors.push(`${key} must be a boolean`);
  }
  if (value.feeds !== undefined) {
    if (value.feeds === null || typeof value.feeds !== 'object') errors.push('feeds must be an object');
    else for (const [key, flag] of Object.entries(value.feeds)) if (typeof flag !== 'boolean') errors.push(`feeds.${key} must be a boolean`);
  }
  if (value.onUnavailable !== undefined && !ON_UNAVAILABLE.includes(value.onUnavailable as OnUnavailable)) {
    errors.push('onUnavailable must be warn, ask, or deny');
  }
  return errors;
}

/** Fill defaults into a (validated) settings document. */
export function normalizeSecuritySettings(raw: unknown): SecuritySettings {
  const defaults = defaultSecuritySettings();
  const value = (raw ?? {}) as Partial<SecuritySettings>;
  return {
    version: 1,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : defaults.updatedAt,
    simulation: value.simulation ?? defaults.simulation,
    sanctionsOracle: value.sanctionsOracle ?? defaults.sanctionsOracle,
    feeds: { ofac: value.feeds?.ofac ?? defaults.feeds.ofac, scamsniffer: value.feeds?.scamsniffer ?? defaults.feeds.scamsniffer },
    goplus: value.goplus ?? defaults.goplus,
    onUnavailable: value.onUnavailable ?? defaults.onUnavailable,
  };
}

/**
 * Whether `next` is at least as protective as `current`: no check turned
 * off and `onUnavailable` not relaxed. Turning GoPlus *on* adds a check, so
 * it counts as tightening (it is a privacy choice, not a weakening).
 */
export function isTighteningSecurity(current: SecuritySettings, next: SecuritySettings): boolean {
  if (current.simulation && !next.simulation) return false;
  if (current.sanctionsOracle && !next.sanctionsOracle) return false;
  if (current.goplus && !next.goplus) return false;
  for (const id of Object.keys(current.feeds) as DenylistFeedId[]) if (current.feeds[id] && !next.feeds[id]) return false;
  return ON_UNAVAILABLE.indexOf(next.onUnavailable) >= ON_UNAVAILABLE.indexOf(current.onUnavailable);
}

/** Load `security.json`; missing → defaults; invalid → throws (fail closed, like limits). */
export async function loadSecuritySettings(path: string): Promise<SecuritySettings> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    const errors = validateSecuritySettings(raw);
    if (errors.length > 0) throw new Error(`invalid security settings: ${errors.join('; ')}`);
    return normalizeSecuritySettings(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultSecuritySettings();
    throw error;
  }
}
