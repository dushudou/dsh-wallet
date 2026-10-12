/**
 * The built-in pre-signing risk checks.
 *
 * | check       | source                                   | network            |
 * |-------------|------------------------------------------|--------------------|
 * | `local`     | address book, history, on-chain code     | chain RPC only     |
 * | `denylist`  | user denylist + cached OFAC / ScamSniffer | none (cache)       |
 * | `sanctions` | Chainalysis sanctions oracle (on-chain)  | chain RPC only     |
 * | `simulation`| `eth_simulateV1` reconciled with intent  | chain RPC only     |
 * | `goplus`    | GoPlus address / token reputation        | GoPlus API (opt-in)|
 *
 * Checks are built per operation by {@link buildRiskChecks}; the engine in
 * `dsh-web3-core/security` runs them in parallel and escalates the decision.
 *
 * @module dsh-web3/security
 */

import {
  DENYLIST_FEEDS,
  SimulationUnsupportedError,
  finding,
  findKnownToken,
  reconcileSimulation,
  summarizeSimulation,
  type ChainProvider,
  type Denylist,
  type DenylistHit,
  type RiskCheck,
  type RiskFinding,
  type SecuritySettings,
  type SecuritySubject,
  type SimulationSummary,
} from 'dsh-web3-core';
import { lookAlikeOf, type ResolvedRecipient } from './assets.js';

/** Chains where the Chainalysis sanctions oracle is deployed (verified via eth_getCode). */
export const SANCTIONS_ORACLE_CHAINS: readonly number[] = [1, 10, 56, 137, 42161, 43114];
/** Chainalysis SanctionsList oracle (same address on every supported chain). */
export const SANCTIONS_ORACLE_ADDRESS = '0x40C57923924B5c5c5455c48D93317139ADDaC8fb';
/** `isSanctioned(address)` selector. */
const IS_SANCTIONED_SELECTOR = '0xdf592f7d';

const GOPLUS_BASE = 'https://api.gopluslabs.io/api/v1';
const CACHE_TTL_MS = 10 * 60_000;
const PERMIT_LONG_DEADLINE_S = 30 * 24 * 60 * 60;

/** Minimal JSON fetch (injectable for tests). */
export type JsonFetcher = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** What the checks need from the wallet service. */
export interface SecurityDeps {
  settings(): SecuritySettings;
  providerFor(chainId: number): Promise<ChainProvider>;
  denylist: Denylist;
  /** Lower-cased counterparties the account has dealt with (contacts, own accounts, past recipients). */
  knownCounterparties(from: string): Set<string>;
  isOwnAccount(address: string): boolean;
  isTrustedContact(address: string): boolean;
  /** GoPlus fetcher (defaults to global fetch). */
  fetchJson?: JsonFetcher;
  /** Shared TTL cache for network lookups. */
  cache: Map<string, { at: number; value: unknown }>;
}

/** Per-operation context that is not part of the subject. */
export interface SecurityHints {
  /** How the recipient was resolved (ENS / address book / own account). */
  recipient?: ResolvedRecipient;
}

/** Checks for one operation, plus the simulation they produced (if any). */
export interface BuiltChecks {
  checks: RiskCheck[];
  /** Resolves after the simulation check ran (undefined when it did not). */
  simulation(): Promise<SimulationSummary | undefined>;
}

/** Build the enabled checks for one operation. */
export function buildRiskChecks(deps: SecurityDeps, subject: SecuritySubject, hints: SecurityHints = {}): BuiltChecks {
  const settings = deps.settings();
  let resolveSimulation: (value: SimulationSummary | undefined) => void = () => undefined;
  const simulationDone = new Promise<SimulationSummary | undefined>((resolve) => {
    resolveSimulation = resolve;
  });
  const checks: RiskCheck[] = [localCheck(deps, hints), denylistCheck(deps)];
  if (settings.sanctionsOracle) checks.push(sanctionsCheck(deps));
  if (settings.simulation && subject.kind === 'transaction' && subject.tx !== undefined) checks.push(simulationCheck(deps, resolveSimulation));
  else resolveSimulation(undefined);
  if (settings.goplus) checks.push(goplusCheck(deps, simulationDone));
  return { checks, simulation: () => simulationDone };
}

// ── helpers ───────────────────────────────────────────────────────────────

function enabledFeeds(settings: SecuritySettings): Partial<Record<(typeof DENYLIST_FEEDS)[number]['id'], boolean>> {
  return { ...settings.feeds };
}

function denylistFinding(check: string, hit: DenylistHit, role: string): RiskFinding {
  const why =
    hit.source === 'user'
      ? `is on your denylist${hit.label !== undefined ? ` ("${hit.label}")` : ''}`
      : hit.category === 'sanctioned'
        ? `is on the OFAC sanctions list (${hit.source} feed)`
        : `is reported as a scam address (${hit.source} feed)`;
  return finding(check, 'DENYLISTED_ADDRESS', 'critical', `${role} ${hit.address} ${why}`, hit.address);
}

/** Cached async lookup. */
async function cached<T>(deps: SecurityDeps, key: string, load: () => Promise<T>): Promise<T> {
  const hit = deps.cache.get(key);
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  const value = await load();
  deps.cache.set(key, { at: Date.now(), value });
  return value;
}

/** Contract code classification: plain EOA, EIP-7702 delegated EOA, or contract. */
function codeKind(code: string): 'eoa' | 'delegated' | 'contract' {
  if (code === '0x' || code === '') return 'eoa';
  return code.toLowerCase().startsWith('0xef0100') ? 'delegated' : 'contract';
}

const ROLE_TEXT: Record<string, string> = { recipient: 'recipient', spender: 'spender', contract: 'contract', 'verifying-contract': 'signing domain contract' };

// ── local ─────────────────────────────────────────────────────────────────

function localCheck(deps: SecurityDeps, hints: SecurityHints): RiskCheck {
  return {
    id: 'local',
    async run(subject) {
      const out: RiskFinding[] = [];
      const { intent, chainId } = subject;
      const known = deps.knownCounterparties(subject.from);
      const provider = chainId !== undefined ? await deps.providerFor(chainId).catch(() => undefined) : undefined;
      const codeOf = async (address: string) => (provider !== undefined ? await provider.getCode(address).catch(() => undefined) : undefined);

      for (const { role, address } of subject.counterparties) {
        if (role !== 'recipient' && role !== 'spender') continue;
        const lower = address.toLowerCase();
        if (lower === subject.from.toLowerCase()) {
          if (role === 'recipient') out.push(finding('local', 'SELF_SEND', 'info', 'sending to your own address (this account)', address));
          continue;
        }
        const lookAlike = lookAlikeOf(address, known);
        if (lookAlike !== undefined) {
          out.push(
            finding(
              'local',
              'ADDRESS_POISONING',
              'high',
              `ADDRESS POISONING RISK: ${ROLE_TEXT[role]} ${address} looks like known address ${lookAlike} (same first/last characters) but is different — confirm every character with the user`,
              address,
            ),
          );
        }
        const trusted = deps.isOwnAccount(address) || deps.isTrustedContact(address) || hints.recipient?.via === 'address-book' || hints.recipient?.via === 'own-account';
        if (role === 'recipient' && !trusted && !known.has(lower)) {
          out.push(finding('local', 'FIRST_RECIPIENT', 'warn', `first transfer to ${address} — confirm the full address with the user`, address));
        }
        if (role === 'recipient' && hints.recipient?.via === 'ens' && hints.recipient.address.toLowerCase() === lower) {
          out.push(finding('local', 'ENS_RESOLVED', 'info', `recipient resolved from ENS name ${hints.recipient.label ?? hints.recipient.input} → ${address}`, address));
        }
        if (role === 'recipient' && chainId !== undefined && findKnownToken(chainId, address) !== undefined) {
          out.push(finding('local', 'TOKEN_CONTRACT_RECIPIENT', 'high', `recipient ${address} is itself a token contract — tokens sent there are usually lost`, address));
        }
      }

      // Native coin to an address with code.
      if (intent.kind === 'native-transfer' && subject.tx !== undefined && subject.tx.to.toLowerCase() !== subject.from.toLowerCase()) {
        const code = await codeOf(subject.tx.to);
        if (code !== undefined && codeKind(code) !== 'eoa') {
          const kind = codeKind(code) === 'delegated' ? 'an EIP-7702 delegated account' : 'a contract';
          out.push(finding('local', 'CONTRACT_RECIPIENT', 'warn', `recipient ${subject.tx.to} is ${kind}; make sure it can receive and is controlled by the payee`, subject.tx.to));
        }
      }

      // Permissions granted to plain wallets: the classic drainer pattern.
      const grants = ['token-approve', 'nft-approval', 'permit', 'permit-transfer'].includes(intent.kind);
      if (grants && intent.spender !== undefined && intent.spender.toLowerCase() !== subject.from.toLowerCase()) {
        const code = await codeOf(intent.spender);
        if (code !== undefined && codeKind(code) !== 'contract' && !deps.isOwnAccount(intent.spender)) {
          out.push(
            finding(
              'local',
              'APPROVAL_TO_EOA',
              'high',
              `spender ${intent.spender} is a ${codeKind(code) === 'delegated' ? 'delegated wallet' : 'plain wallet'}, not a dApp contract — legitimate apps ask you to approve their contracts; approvals to wallets are how drainers take tokens`,
              intent.spender,
            ),
          );
        }
      }
      if (grants && intent.unlimited === true) {
        out.push(finding('local', 'UNLIMITED_APPROVAL', 'high', 'UNLIMITED approval: the spender can take the entire balance of this token, now and in the future', intent.spender));
      }

      if (subject.kind === 'typed-data') {
        const permitLike = ['permit', 'permit-transfer', 'transfer-authorization', 'order'].includes(intent.kind);
        if (permitLike && chainId === undefined) {
          out.push(finding('local', 'TYPED_DATA_NO_CHAIN', 'warn', 'the signature does not name a chain, so it may be replayable on other networks'));
        }
        const now = Math.floor(Date.now() / 1000);
        if ((intent.kind === 'permit' || intent.kind === 'permit-transfer') && intent.deadline !== undefined && intent.deadline - now > PERMIT_LONG_DEADLINE_S) {
          const years = (intent.deadline - now) / (365 * 24 * 60 * 60);
          out.push(
            finding('local', 'PERMIT_LONG_DEADLINE', 'warn', years > 10 ? 'this permit effectively never expires' : `this permit stays valid until ${new Date(intent.deadline * 1000).toISOString().slice(0, 10)}`),
          );
        }
        const domain = subject.counterparties.find((entry) => entry.role === 'verifying-contract');
        if (domain !== undefined && permitLike) {
          const code = await codeOf(domain.address);
          if (code !== undefined && codeKind(code) === 'eoa') {
            out.push(finding('local', 'VERIFYING_CONTRACT_NOT_DEPLOYED', 'warn', `signing domain contract ${domain.address} has no code on this chain — check the network`, domain.address));
          }
        }
      }
      return out;
    },
  };
}

// ── denylist ──────────────────────────────────────────────────────────────

function denylistCheck(deps: SecurityDeps): RiskCheck {
  return {
    id: 'denylist',
    async run(subject) {
      const enabled = enabledFeeds(deps.settings());
      const out: RiskFinding[] = [];
      for (const { role, address } of subject.counterparties) {
        const hit = deps.denylist.lookup(address, enabled);
        if (hit !== undefined) out.push(denylistFinding('denylist', hit, ROLE_TEXT[role] ?? role));
      }
      return out;
    },
  };
}

// ── sanctions oracle ──────────────────────────────────────────────────────

function sanctionsCheck(deps: SecurityDeps): RiskCheck {
  return {
    id: 'sanctions',
    async run(subject) {
      const chainId = subject.chainId;
      if (chainId === undefined || !SANCTIONS_ORACLE_CHAINS.includes(chainId)) return { skipped: `no sanctions oracle on chain ${String(chainId ?? 'unknown')}` };
      const provider = await deps.providerFor(chainId);
      const unique = [...new Map(subject.counterparties.filter((entry) => entry.role === 'recipient' || entry.role === 'spender').map((entry) => [entry.address.toLowerCase(), entry])).values()];
      const out: RiskFinding[] = [];
      await Promise.all(
        unique.map(async ({ role, address }) => {
          const sanctioned = await cached(deps, `sanctions:${String(chainId)}:${address.toLowerCase()}`, async () => {
            const data = `${IS_SANCTIONED_SELECTOR}${address.slice(2).toLowerCase().padStart(64, '0')}`;
            const raw = await provider.call({ to: SANCTIONS_ORACLE_ADDRESS, data });
            if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`unexpected oracle answer ${raw.slice(0, 20)}`);
            return BigInt(raw) !== 0n;
          });
          if (sanctioned) out.push(finding('sanctions', 'SANCTIONED_ADDRESS', 'critical', `${ROLE_TEXT[role]} ${address} is flagged by the on-chain sanctions oracle (Chainalysis)`, address));
        }),
      );
      return out;
    },
  };
}

// ── simulation ────────────────────────────────────────────────────────────

function simulationCheck(deps: SecurityDeps, done: (summary: SimulationSummary | undefined) => void): RiskCheck {
  return {
    id: 'simulation',
    timeoutMs: 8_000,
    async run(subject, signal) {
      try {
        if (subject.tx === undefined || subject.chainId === undefined) return { skipped: 'nothing to simulate' };
        const provider = await deps.providerFor(subject.chainId);
        if (provider.simulate === undefined) return { skipped: 'provider cannot simulate' };
        let result;
        try {
          result = await provider.simulate({ from: subject.from, to: subject.tx.to, value: subject.tx.value, data: subject.tx.data, ...(subject.tx.gasLimit !== undefined ? { gas: subject.tx.gasLimit } : {}) }, signal);
        } catch (error) {
          if (error instanceof SimulationUnsupportedError) {
            return { skipped: error.message, findings: [finding('simulation', 'SIMULATION_UNAVAILABLE', 'info', 'this network\'s RPC cannot simulate transactions; asset changes were not previewed')] };
          }
          throw error;
        }
        const summary = summarizeSimulation(result, subject.from);
        done(summary);
        const out = reconcileSimulation({ intent: subject.intent, account: subject.from, ...(subject.chainId !== undefined ? { chainId: subject.chainId } : {}), tx: subject.tx, summary });
        // Funds that end up at a denylisted address, however many hops away.
        const enabled = enabledFeeds(deps.settings());
        const flagged = new Set<string>();
        for (const movement of summary.movements) {
          const target = movement.to.toLowerCase();
          if (flagged.has(target) || target === subject.from.toLowerCase()) continue;
          const hit = deps.denylist.lookup(movement.to, enabled);
          if (hit !== undefined) {
            flagged.add(target);
            out.push(denylistFinding('simulation', hit, 'funds flow to'));
          }
        }
        return out;
      } finally {
        done(undefined); // no-op when already resolved with a summary
      }
    },
  };
}

// ── GoPlus (opt-in) ───────────────────────────────────────────────────────

const GOPLUS_CRITICAL = ['stealing_attack', 'phishing_activities', 'sanctioned'];
const GOPLUS_HIGH = [
  'blacklist_doubt',
  'cybercrime',
  'money_laundering',
  'financial_crime',
  'darkweb_transactions',
  'blackmail_activities',
  'fake_kyc',
  'malicious_mining_activities',
  'honeypot_related_address',
  'fake_token',
  'fake_standard_interface',
];
const GOPLUS_WARN = ['mixer', 'gas_abuse', 'reinit'];

/** Map one GoPlus address_security result to a finding (or none). */
export function goplusAddressFinding(address: string, role: string, result: Record<string, unknown>): RiskFinding | undefined {
  const flagged = (keys: string[]) => keys.filter((key) => String(result[key] ?? '0') === '1');
  const critical = flagged(GOPLUS_CRITICAL);
  const high = flagged(GOPLUS_HIGH);
  if (Number(result.number_of_malicious_contracts_created ?? 0) > 0) high.push('created malicious contracts');
  const warn = flagged(GOPLUS_WARN);
  const all = [...critical, ...high, ...warn];
  if (all.length === 0) return undefined;
  const severity = critical.length > 0 ? 'critical' : high.length > 0 ? 'high' : 'warn';
  const source = typeof result.data_source === 'string' && result.data_source !== '' ? ` (data: ${result.data_source})` : '';
  return finding('goplus', 'MALICIOUS_ADDRESS', severity, `${role} ${address} is flagged by GoPlus: ${all.map((key) => key.replace(/_/g, ' ')).join(', ')}${source}`, address);
}

/** Map one GoPlus token_security result for a token you would receive. */
export function goplusTokenFindings(token: string, result: Record<string, unknown>): RiskFinding[] {
  if (String(result.trust_list ?? '0') === '1') return [];
  const name = typeof result.token_symbol === 'string' ? `${result.token_symbol} (${token})` : token;
  const out: RiskFinding[] = [];
  const flag = (key: string) => String(result[key] ?? '0') === '1';
  if (flag('is_honeypot')) out.push(finding('goplus', 'TOKEN_HONEYPOT', 'high', `you would receive ${name}, which GoPlus reports as a honeypot (it cannot be sold)`, token));
  if (flag('cannot_sell_all')) out.push(finding('goplus', 'TOKEN_CANNOT_SELL', 'high', `${name} cannot be sold in full (GoPlus)`, token));
  if (flag('owner_change_balance')) out.push(finding('goplus', 'TOKEN_OWNER_CAN_CHANGE_BALANCE', 'high', `the owner of ${name} can change balances (GoPlus)`, token));
  if (flag('is_airdrop_scam')) out.push(finding('goplus', 'TOKEN_AIRDROP_SCAM', 'high', `${name} is reported as an airdrop scam (GoPlus)`, token));
  const sellTax = Number(result.sell_tax ?? 0);
  if (Number.isFinite(sellTax) && sellTax >= 0.1) out.push(finding('goplus', 'TOKEN_HIGH_TAX', 'warn', `${name} charges a ${String(Math.round(sellTax * 100))}% sell tax (GoPlus)`, token));
  if (flag('hidden_owner')) out.push(finding('goplus', 'TOKEN_HIDDEN_OWNER', 'warn', `${name} has a hidden owner (GoPlus)`, token));
  return out;
}

function goplusCheck(deps: SecurityDeps, simulation: Promise<SimulationSummary | undefined>): RiskCheck {
  const fetchJson = deps.fetchJson ?? (globalThis.fetch as unknown as JsonFetcher);
  const get = async (url: string, signal: AbortSignal): Promise<unknown> => {
    const response = await fetchJson(url, { signal });
    if (!response.ok) throw new Error(`GoPlus HTTP ${String(response.status)}`);
    const body = (await response.json()) as { code?: number; message?: string; result?: unknown };
    if (body.code !== 1) throw new Error(`GoPlus error ${String(body.code)}: ${body.message ?? 'unknown'}`);
    return body.result;
  };
  return {
    id: 'goplus',
    timeoutMs: 8_000,
    async run(subject, signal) {
      const chainId = subject.chainId;
      const out: RiskFinding[] = [];
      const parties = [
        ...new Map(
          subject.counterparties
            .filter((entry) => (entry.role === 'recipient' || entry.role === 'spender') && !deps.isOwnAccount(entry.address))
            .map((entry) => [entry.address.toLowerCase(), entry]),
        ).values(),
      ];
      await Promise.all(
        parties.map(async ({ role, address }) => {
          const result = await cached(deps, `goplus:addr:${String(chainId ?? '')}:${address.toLowerCase()}`, async () =>
            get(`${GOPLUS_BASE}/address_security/${address}${chainId !== undefined ? `?chain_id=${String(chainId)}` : ''}`, signal),
          );
          const hit = goplusAddressFinding(address, ROLE_TEXT[role] ?? role, (result ?? {}) as Record<string, unknown>);
          if (hit !== undefined) out.push(hit);
        }),
      );
      // Tokens the simulation says you would receive (waiting at most 5 s for it).
      const summary = await Promise.race([
        simulation,
        new Promise<undefined>((resolve) => {
          (setTimeout(() => resolve(undefined), 5_000) as { unref?: () => void }).unref?.();
        }),
      ]);
      const incoming = [...new Set((summary?.incoming ?? []).filter((movement) => movement.standard === 'erc20').map((movement) => movement.asset))];
      if (chainId !== undefined && incoming.length > 0) {
        const lowered = incoming.map((token) => token.toLowerCase());
        const result = (await cached(deps, `goplus:tokens:${String(chainId)}:${lowered.join(',')}`, async () =>
          get(`${GOPLUS_BASE}/token_security/${String(chainId)}?contract_addresses=${lowered.join(',')}`, signal),
        )) as Record<string, Record<string, unknown>> | undefined;
        for (const token of incoming) {
          const entry = result?.[token.toLowerCase()];
          if (entry !== undefined) out.push(...goplusTokenFindings(token, entry));
        }
      }
      return out;
    },
  };
}
