/**
 * Pre-signing security checks, end to end through the agent tools:
 * escalation (critical → deny, high → ask), every check source, the
 * execution-time re-check, typed data / x402, and who may loosen what.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbiCoder } from 'ethers';
import { NATIVE_PSEUDO_ADDRESS, TOPIC_TRANSFER, WalletVault, encodeErc20Read, policyPreset, type SimulationLog } from 'dsh-web3-core';
import { WalletService } from '../src/service.js';
import { buildTools, type WalletTool } from '../src/tools.js';
import { WALLET_PASSPHRASE_REF } from '../src/passphrase.js';
import { SANCTIONS_ORACLE_ADDRESS, goplusAddressFinding, type JsonFetcher } from '../src/security.js';
import { MockChainProvider, ApprovalStub } from '../src/testing.js';

const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';
const ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ALICE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const BOB = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const MALLORY = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const abi = AbiCoder.defaultAbiCoder();

let dir: string;
let provider: MockChainProvider;
let service: WalletService;
let approval: ApprovalStub;
let tools: WalletTool[];
let feedBody: Record<string, string>;
let goplus: Record<string, Record<string, unknown>> | Error;

async function run(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const found = tools.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return (await found.execute(args, {})) as Record<string, unknown>;
}

const codes = (result: Record<string, unknown>): string[] =>
  ((result.security as { findings: Array<{ code: string }> } | undefined)?.findings ?? []).map((entry) => entry.code);

const topic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
const native = (from: string, to: string, value: bigint): SimulationLog => ({ address: NATIVE_PSEUDO_ADDRESS, topics: [TOPIC_TRANSFER, topic(from), topic(to)], data: `0x${value.toString(16).padStart(64, '0')}` });

function mockUsdc(balance: bigint): void {
  const key = (data: string) => `${USDC_BASE.toLowerCase()}:${data}`;
  provider.codes.set(USDC_BASE.toLowerCase(), '0x6080');
  provider.calls.set(key(encodeErc20Read('decimals')), abi.encode(['uint8'], [6]));
  provider.calls.set(key(encodeErc20Read('balanceOf', [ACCOUNT_0])), abi.encode(['uint256'], [balance]));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-web3-security-'));
  await writeFile(join(dir, 'policy.json'), JSON.stringify(policyPreset('strict')), { mode: 0o600 });
  await writeFile(
    join(dir, 'limits.json'),
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), whitelistOnly: false, usd: {}, native: {} }),
    { mode: 0o600 },
  );
  const vault = await WalletVault.open({ directory: dir, kdf: { N: 1024, r: 8, p: 1 } });
  provider = new MockChainProvider(8453);
  approval = new ApprovalStub();
  feedBody = {};
  goplus = {};
  const fetchJson: JsonFetcher = async (url) => {
    if (goplus instanceof Error) throw goplus;
    const address = url.match(/address_security\/(0x[0-9a-fA-F]{40})/)?.[1]?.toLowerCase();
    return { ok: true, status: 200, json: async () => ({ code: 1, message: 'ok', result: (goplus as Record<string, Record<string, unknown>>)[address ?? ''] ?? {} }) };
  };
  service = new WalletService(vault, {
    vaultPath: dir,
    passphraseMode: 'manual',
    env: { [WALLET_PASSPHRASE_REF]: 'pw' },
    rpcOverrides: {},
    tokens: {},
    createProvider: () => provider,
    fetchJson,
    feedFetcher: async (url) => ({ ok: true, status: 200, text: async () => feedBody[url.includes('scamsniffer') ? 'scamsniffer' : 'ofac'] ?? '[]' }),
  });
  tools = buildTools({ service, approval });
  const secretFile = join(dir, 'secret.txt');
  await writeFile(secretFile, HARDHAT_MNEMONIC, { mode: 0o600 });
  await service.importAccount({ source: 'mnemonic', secretFile, label: 'main' });
});

afterEach(async () => {
  vi.useRealTimers();
  service.vault.lock();
  await rm(dir, { recursive: true, force: true });
});

describe('escalation', () => {
  it('makes an address-poisoning look-alike reach a human even when the policy would auto-sign', async () => {
    await service.setPolicy(policyPreset('power'));
    approval.outcome = 'allowed-once';
    await run('wallet_address_book', { action: 'add', label: 'Alice', address: ALICE });
    approval.requests = [];
    approval.outcome = 'rejected';
    const lookAlike = '0x70997970000000000000000000000000000079C8';
    const result = await run('wallet_transfer', { account: 'main', chainId: 8453, to: lookAlike, amount: '0.001' });
    expect(result.status).toBe('awaiting-approval-rejected');
    expect((result.decision as Record<string, unknown>).guardrail).toBe('security');
    expect(approval.requests[0]!.reason).toContain('ADDRESS POISONING');
    expect(provider.broadcasted).toHaveLength(0);
    // A clean small transfer under the same preset still signs on its own.
    expect((await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '0.001' })).status).toBe('signed-broadcast');
  });

  it('refuses a denylisted recipient outright: no approval prompt, nothing broadcast', async () => {
    expect(await run('wallet_denylist', { action: 'add', address: MALLORY, label: 'phishing payee' })).toMatchObject({ added: true });
    const prepared = await run('wallet_transfer', { account: 'main', chainId: 8453, to: MALLORY, amount: '0.01', dryRun: true });
    expect(prepared.willRequire).toMatchObject({ blocked: true });
    expect(codes(prepared)).toContain('DENYLISTED_ADDRESS');
    expect(String(prepared.next)).toContain('security check');
    const sent = await run('wallet_transfer', { account: 'main', chainId: 8453, to: MALLORY, amount: '0.01' });
    expect(sent.status).toBe('denied-by-policy');
    expect((sent.decision as Record<string, unknown>).ruleId).toBe('security:DENYLISTED_ADDRESS');
    expect(approval.requests).toHaveLength(0);
    expect(provider.broadcasted).toHaveLength(0);
  });

  it('re-checks at execution time: a recipient denylisted after preparing is refused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const prepared = await run('wallet_transfer', { account: 'main', chainId: 8453, to: BOB, amount: '0.01', dryRun: true });
    expect(prepared.willRequire).toMatchObject({ blocked: false });
    await service.denylistAdd({ address: BOB }, 'panel');
    vi.setSystemTime(Date.now() + 60_000);
    const sent = await run('wallet_send_transaction', { preparedId: prepared.preparedId });
    expect(sent.status).toBe('denied-by-policy');
    expect(provider.broadcasted).toHaveLength(0);
  });
});

describe('check sources', () => {
  it('uses downloaded feeds (OFAC, ScamSniffer) only while enabled', async () => {
    feedBody.scamsniffer = JSON.stringify([MALLORY.toLowerCase()]);
    await service.refreshDenylistFeeds({ force: true });
    const blocked = await run('wallet_transfer', { account: 'main', chainId: 8453, to: MALLORY, amount: '0.01', dryRun: true });
    expect((blocked.security as { findings: Array<{ message: string }> }).findings[0]!.message).toContain('scam');
    expect(blocked.willRequire).toMatchObject({ blocked: true });
  });

  it('asks the on-chain sanctions oracle on chains where it is deployed', async () => {
    provider.calls.set(`${SANCTIONS_ORACLE_ADDRESS.toLowerCase()}:0xdf592f7d${MALLORY.slice(2).toLowerCase().padStart(64, '0')}`, abi.encode(['bool'], [true]));
    provider.calls.set(`${SANCTIONS_ORACLE_ADDRESS.toLowerCase()}:0xdf592f7d${ALICE.slice(2).toLowerCase().padStart(64, '0')}`, abi.encode(['bool'], [false]));
    const sanctioned = await run('wallet_transfer', { account: 'main', chainId: 1, to: MALLORY, amount: '0.01', dryRun: true });
    expect(codes(sanctioned)).toContain('SANCTIONED_ADDRESS');
    expect(sanctioned.willRequire).toMatchObject({ blocked: true });
    const clean = await run('wallet_transfer', { account: 'main', chainId: 1, to: ALICE, amount: '0.01', dryRun: true });
    expect(codes(clean)).not.toContain('SANCTIONED_ADDRESS');
    // Base has no oracle deployment: the check skips instead of failing.
    const base = await run('wallet_transfer', { account: 'main', chainId: 8453, to: MALLORY, amount: '0.01', dryRun: true });
    expect((base.security as { checks: Array<{ id: string; status: string }> }).checks.find((c) => c.id === 'sanctions')?.status).toBe('skipped');
  });

  it('simulates: a sweeper recipient forces review, an unsupported RPC only notes it', async () => {
    await service.setPolicy(policyPreset('power'));
    approval.outcome = 'rejected';
    provider.simulation = (call) => ({ status: 'success', logs: [native(ACCOUNT_0, call.to, call.value), native(call.to, MALLORY, call.value)] });
    const swept = await run('wallet_transfer', { account: 'main', chainId: 8453, to: BOB, amount: '0.001' });
    expect(swept.status).toBe('awaiting-approval-rejected');
    expect(codes(swept)).toContain('RECIPIENT_FORWARDS_FUNDS');
    expect(provider.simulated[0]).toMatchObject({ from: ACCOUNT_0, to: BOB });

    provider.simulation = undefined;
    const plain = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '0.001', dryRun: true });
    expect(codes(plain)).toContain('SIMULATION_UNAVAILABLE');
    expect(plain.willRequire).toMatchObject({ blocked: false, humanApproval: false });
  });

  it('blocks funds that flow to a denylisted address through a contract call', async () => {
    await service.denylistAdd({ address: MALLORY }, 'panel');
    provider.codes.set(BOB.toLowerCase(), '0x6080');
    provider.simulation = { status: 'success', logs: [native(ACCOUNT_0, BOB, 1n), native(BOB, MALLORY, 1n)] };
    const prepared = await run('wallet_prepare_transaction', { account: 'main', chainId: 8453, to: BOB, data: '0x12345678', value: '1' });
    expect(codes(prepared)).toContain('DENYLISTED_ADDRESS');
    expect(prepared.willRequire).toMatchObject({ blocked: true });
  });

  it('GoPlus (opt-in) blocks theft-flagged addresses; onUnavailable decides what an outage means', async () => {
    await service.setSecuritySettingsFromPanel({ ...service.vault.getSecuritySettings(), goplus: true });
    goplus = { [MALLORY.toLowerCase()]: { stealing_attack: '1', data_source: 'SlowMist' } };
    const flagged = await run('wallet_transfer', { account: 'main', chainId: 8453, to: MALLORY, amount: '0.01', dryRun: true });
    expect(codes(flagged)).toContain('MALICIOUS_ADDRESS');
    expect(flagged.willRequire).toMatchObject({ blocked: true });

    goplus = new Error('network down');
    const warnOnly = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '0.01', dryRun: true });
    expect(codes(warnOnly)).toContain('SECURITY_CHECK_UNAVAILABLE');
    expect(warnOnly.willRequire).toMatchObject({ blocked: false });
    await service.setSecuritySettingsFromPanel({ ...service.vault.getSecuritySettings(), onUnavailable: 'deny' });
    const failClosed = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '0.01', dryRun: true });
    expect(failClosed.willRequire).toMatchObject({ blocked: true });
  });

  it('maps GoPlus flags to severities', () => {
    expect(goplusAddressFinding(ALICE, 'recipient', { phishing_activities: '1' })?.severity).toBe('critical');
    expect(goplusAddressFinding(ALICE, 'recipient', { blacklist_doubt: '1' })?.severity).toBe('high');
    expect(goplusAddressFinding(ALICE, 'recipient', { mixer: '1' })?.severity).toBe('warn');
    expect(goplusAddressFinding(ALICE, 'recipient', { contract_address: '1' })).toBeUndefined();
  });
});

describe('signatures', () => {
  it('flags permits to a plain wallet and long deadlines in the approval prompt', async () => {
    approval.outcome = 'rejected';
    const result = await run('wallet_sign_typed_data', {
      account: 'main',
      domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_BASE },
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      message: { owner: ACCOUNT_0, spender: BOB, value: '1000000', nonce: 0, deadline: 4_000_000_000 },
    });
    expect(result.status).toBe('awaiting-approval-rejected');
    expect(codes(result)).toEqual(expect.arrayContaining(['APPROVAL_TO_EOA', 'PERMIT_LONG_DEADLINE']));
    expect(approval.requests[0]!.reason).toContain('Security checks:');
    expect(approval.requests[0]!.reason).toContain('plain wallet');
  });

  it('refuses an x402 payment to a denylisted payTo even under the micropay preset', async () => {
    await service.setPolicy(policyPreset('micropay'));
    await service.denylistAdd({ address: MALLORY }, 'panel');
    const challenge = { x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '50000', asset: USDC_BASE, payTo: MALLORY }] };
    const result = await run('wallet_x402_authorize', { account: 'main', challenge });
    expect(result.status).toBe('denied-by-policy');
    expect(approval.requests).toHaveLength(0);
  });
});

describe('who may change what', () => {
  it('lets the agent add to the denylist but never remove', async () => {
    await run('wallet_denylist', { action: 'add', address: MALLORY });
    expect(await run('wallet_denylist', { action: 'remove', address: MALLORY })).toMatchObject({ removed: false, status: 'use-panel' });
    expect((await run('wallet_denylist', { action: 'list' })).entries).toHaveLength(1);
  });

  it('panel: tightening needs no PIN, weakening and denylist removal do', async () => {
    const settings = service.vault.getSecuritySettings();
    await service.setSecuritySettingsFromPanel({ ...settings, onUnavailable: 'ask' });
    await expect(service.setSecuritySettingsFromPanel({ ...settings, simulation: false })).rejects.toMatchObject({ code: 'PIN_SETUP_REQUIRED' });
    await service.pinSetup('2468');
    await expect(service.setSecuritySettingsFromPanel({ ...settings, simulation: false })).rejects.toMatchObject({ code: 'PIN_REQUIRED' });
    expect((await service.setSecuritySettingsFromPanel({ ...settings, simulation: false }, '2468')).simulation).toBe(false);
    await service.denylistAdd({ address: MALLORY }, 'panel');
    await expect(service.denylistRemoveFromPanel(MALLORY)).rejects.toMatchObject({ code: 'PIN_REQUIRED' });
    expect(await service.denylistRemoveFromPanel(MALLORY, '2468')).toMatchObject({ address: MALLORY });
  });

  it('wallet_security_check summarizes an address for the agent', async () => {
    await service.denylistAdd({ address: MALLORY, label: 'drainer' }, 'panel');
    const bad = await run('wallet_security_check', { address: MALLORY, chainId: 8453 });
    expect(bad).toMatchObject({ severity: 'critical', kind: 'wallet', known: false });
    expect(String(bad.next)).toContain('Do NOT pay');
    const fine = await run('wallet_security_check', { address: ALICE, chainId: 8453 });
    expect(fine.severity).toBe('warn'); // first-time recipient only
  });
});
