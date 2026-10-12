import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Denylist,
  escalateDecision,
  finding,
  isTighteningSecurity,
  defaultSecuritySettings,
  loadSecuritySettings,
  parseFeed,
  reconcileSimulation,
  runSecurityChecks,
  summarizeSimulation,
  NATIVE_PSEUDO_ADDRESS,
  TOPIC_APPROVAL,
  TOPIC_TRANSFER,
  type PolicyDecision,
  type RiskCheck,
  type SecuritySubject,
  type SimulationLog,
} from './index.js';

const ME = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ALICE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const BOB = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const subject: SecuritySubject = { kind: 'transaction', chainId: 8453, from: ME, intent: { kind: 'native-transfer' }, counterparties: [] };
const allow: PolicyDecision = { effect: 'allow', reason: 'rule r1', request: { type: 'signTransaction' } };

const topic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
const amountData = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
const transferLog = (token: string, from: string, to: string, value: bigint): SimulationLog => ({ address: token, topics: [TOPIC_TRANSFER, topic(from), topic(to)], data: amountData(value) });

describe('risk engine', () => {
  it('runs checks in parallel and turns failures and timeouts into unavailable findings', async () => {
    const checks: RiskCheck[] = [
      { id: 'ok', run: async () => [finding('ok', 'X', 'info', 'fine')] },
      { id: 'skip', run: async () => ({ skipped: 'not applicable' }) },
      { id: 'boom', run: async () => { throw new Error('network down'); } },
      { id: 'slow', timeoutMs: 20, run: () => new Promise(() => undefined) },
    ];
    const report = await runSecurityChecks(checks, subject, { onUnavailable: 'ask' });
    expect(report.checks.map((run) => `${run.id}:${run.status}`)).toEqual(['boom:failed', 'ok:ok', 'skip:skipped', 'slow:timeout']);
    const unavailable = report.findings.filter((entry) => entry.code === 'SECURITY_CHECK_UNAVAILABLE');
    expect(unavailable).toHaveLength(2);
    expect(unavailable.every((entry) => entry.severity === 'high')).toBe(true);
    expect(report.severity).toBe('high');
  });

  it('escalates monotonically: critical denies, high asks, nothing loosens', () => {
    const report = (severity: 'warn' | 'high' | 'critical') => ({ severity, findings: [finding('t', 'CODE', severity, 'bad thing')], checks: [] });
    expect(escalateDecision(allow, report('critical'))).toMatchObject({ effect: 'deny', ruleId: 'security:CODE', risk: { severity: 'critical', codes: ['CODE'] } });
    expect(escalateDecision(allow, report('high'))).toMatchObject({ effect: 'ask', guardrail: 'security' });
    expect(escalateDecision(allow, report('warn'))).toMatchObject({ effect: 'allow', risk: { severity: 'warn' } });
    const deny: PolicyDecision = { ...allow, effect: 'deny' };
    expect(escalateDecision(deny, report('warn')).effect).toBe('deny');
    expect(escalateDecision(allow, { severity: 'none', findings: [], checks: [] })).toBe(allow);
  });
});

describe('security settings', () => {
  it('treats turning anything off or relaxing onUnavailable as loosening', () => {
    const base = defaultSecuritySettings();
    expect(isTighteningSecurity(base, { ...base, goplus: true })).toBe(true);
    expect(isTighteningSecurity(base, { ...base, onUnavailable: 'deny' })).toBe(true);
    expect(isTighteningSecurity(base, { ...base, simulation: false })).toBe(false);
    expect(isTighteningSecurity(base, { ...base, feeds: { ofac: false, scamsniffer: true } })).toBe(false);
    expect(isTighteningSecurity({ ...base, onUnavailable: 'ask' }, base)).toBe(false);
  });

  it('fails closed on a corrupt security.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web3-sec-'));
    try {
      expect((await loadSecuritySettings(join(dir, 'security.json'))).simulation).toBe(true);
      await writeFile(join(dir, 'security.json'), JSON.stringify({ version: 1, simulation: 'yes' }));
      await expect(loadSecuritySettings(join(dir, 'security.json'))).rejects.toThrow(/invalid security settings/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('denylist', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-web3-deny-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses JSON-array and line feeds, keeping only valid addresses', () => {
    expect(parseFeed(JSON.stringify([ALICE, 'nope', 42, BOB.toLowerCase()]))).toEqual([ALICE.toLowerCase(), BOB.toLowerCase()]);
    expect(parseFeed(`${ALICE}\n\n0x123\n${BOB}\n`)).toHaveLength(2);
  });

  it('looks up user entries and enabled feeds only, and keeps the old list when a refresh fails', async () => {
    const list = new Denylist(dir);
    await list.load();
    await list.add({ address: BOB, label: 'scammer' });
    expect(list.lookup(BOB.toLowerCase(), {})).toMatchObject({ source: 'user', category: 'user', label: 'scammer' });

    let body = JSON.stringify([ALICE]);
    let ok = true;
    const fetcher = async () => ({ ok, status: ok ? 200 : 503, text: async () => body });
    await list.refreshFeeds({ enabled: { ofac: true }, fetcher });
    expect(list.lookup(ALICE, { ofac: true })).toMatchObject({ source: 'ofac', category: 'sanctioned' });
    expect(list.lookup(ALICE, { ofac: false })).toBeUndefined();

    // Fresh caches are not re-downloaded; forced refreshes that fail or come back empty keep the list.
    ok = false;
    await list.refreshFeeds({ enabled: { ofac: true }, fetcher });
    expect(list.feedStatus().find((feed) => feed.id === 'ofac')?.error).toBeUndefined();
    await list.refreshFeeds({ enabled: { ofac: true }, fetcher, force: true });
    ok = true;
    body = '[]';
    const status = await list.refreshFeeds({ enabled: { ofac: true }, fetcher, force: true });
    expect(status.find((feed) => feed.id === 'ofac')).toMatchObject({ count: 1, error: expect.stringContaining('no addresses') });
    expect(list.lookup(ALICE, { ofac: true })).toBeDefined();

    // Persisted across reloads.
    const reloaded = new Denylist(dir);
    await reloaded.load();
    expect(reloaded.lookup(ALICE, { ofac: true })).toBeDefined();
    expect(reloaded.lookup(BOB, {})).toBeDefined();
    expect(await reloaded.remove(BOB)).toMatchObject({ address: BOB });
    expect(reloaded.lookup(BOB, {})).toBeUndefined();
  });
});

describe('simulation reconciliation', () => {
  const nativeTx = { to: ALICE, value: 10n ** 16n };

  it('accepts a native transfer that does exactly what it says', () => {
    const summary = summarizeSimulation({ status: 'success', logs: [transferLog(NATIVE_PSEUDO_ADDRESS, ME, ALICE, 10n ** 16n)] }, ME);
    expect(reconcileSimulation({ intent: { kind: 'native-transfer' }, account: ME, chainId: 8453, tx: nativeTx, summary })).toEqual([]);
  });

  it('flags a recipient that forwards the funds onward (sweeper)', () => {
    const summary = summarizeSimulation(
      { status: 'success', logs: [transferLog(NATIVE_PSEUDO_ADDRESS, ME, BOB, 10n ** 16n), transferLog(NATIVE_PSEUDO_ADDRESS, BOB, ALICE, 10n ** 16n)] },
      ME,
    );
    const findings = reconcileSimulation({ intent: { kind: 'native-transfer' }, account: ME, chainId: 8453, tx: { to: BOB, value: 10n ** 16n }, summary });
    expect(findings).toEqual([expect.objectContaining({ code: 'RECIPIENT_FORWARDS_FUNDS', severity: 'high', address: BOB })]);
    expect(findings[0]!.message).toContain('0.01 ETH');
  });

  it('flags extra outflows, amount mismatches, and hidden approvals in a token transfer', () => {
    const intent = { kind: 'token-transfer' as const, method: 'transfer', token: USDC_BASE, recipient: ALICE, amount: '25000000' };
    const summary = summarizeSimulation(
      {
        status: 'success',
        logs: [
          transferLog(USDC_BASE, ME, ALICE, 24_000_000n),
          transferLog(USDC_BASE, ME, BOB, 1_000_000n),
          { address: USDC_BASE, topics: [TOPIC_APPROVAL, topic(ME), topic(BOB)], data: amountData(2n ** 255n) },
        ],
      },
      ME,
    );
    const codes = reconcileSimulation({ intent, account: ME, chainId: 8453, tx: { to: USDC_BASE, value: 0n }, summary }).map((entry) => entry.code);
    expect(codes).toEqual(expect.arrayContaining(['SIMULATION_AMOUNT_MISMATCH', 'SIMULATION_UNEXPECTED_OUTFLOW', 'SIMULATION_HIDDEN_APPROVAL']));
  });

  it('reports reverts and summarizes opaque contract calls', () => {
    expect(reconcileSimulation({ intent: { kind: 'contract-call' }, account: ME, tx: { to: BOB, value: 0n }, summary: summarizeSimulation({ status: 'reverted', error: 'nope', logs: [] }, ME) })[0]).toMatchObject({
      code: 'SIMULATION_REVERTED',
      severity: 'high',
    });
    const drain = summarizeSimulation({ status: 'success', logs: [transferLog(USDC_BASE, ME, ALICE, 5_000_000n)] }, ME);
    const codes = reconcileSimulation({ intent: { kind: 'contract-call' }, account: ME, chainId: 8453, tx: { to: BOB, value: 0n }, summary: drain }).map((entry) => `${entry.code}:${entry.severity}`);
    expect(codes).toEqual(['SIMULATION_ASSET_CHANGES:info', 'SIMULATION_NOTHING_BACK:warn']);
  });

  it('does not expect native logs when the RPC ignored traceTransfers', () => {
    const summary = summarizeSimulation({ status: 'success', logs: [] }, ME);
    expect(reconcileSimulation({ intent: { kind: 'native-transfer' }, account: ME, tx: nativeTx, summary })).toEqual([]);
  });
});
