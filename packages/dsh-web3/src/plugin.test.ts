import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transaction, getAddress } from 'ethers';
import { WalletVault, policyPreset } from 'dsh-web3-core';
import { applyWalletPlugin } from '../src/index.js';
import { WalletService } from '../src/service.js';
import { buildTools } from '../src/tools.js';
import { buildRoutes } from '../src/http.js';
import { Web3Remote } from '../src/remote.js';
import { resolvePassphrase, passphraseFromFile, WALLET_PASSPHRASE_REF } from '../src/passphrase.js';
import { MockChainProvider, ApprovalStub } from '../src/testing.js';

const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';
const HARDHAT_ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const PASSPHRASE = 'test-vault-passphrase';

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

let dir: string;
let vault: WalletVault;
let provider: MockChainProvider;
let service: WalletService;
let approval: ApprovalStub;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-web3-test-'));
  vault = await WalletVault.open({ directory: dir });
  provider = new MockChainProvider(31337);
  approval = new ApprovalStub();
  service = new WalletService(vault, {
    vaultPath: dir,
    passphraseMode: 'manual',
    env: { [WALLET_PASSPHRASE_REF]: PASSPHRASE },
    rpcOverrides: {},
    tokens: {},
    createProvider: () => provider,
  });
});

afterEach(async () => {
  service?.lock();
  await rm(dir, { recursive: true, force: true });
});

async function importHardhatAccount(): Promise<string> {
  const secretFile = join(dir, 'secret.txt');
  await writeFile(secretFile, HARDHAT_MNEMONIC, { mode: 0o600 });
  const { meta } = await service.importAccount({ source: 'mnemonic', secretFile, label: 'hardhat' });
  return meta.id;
}

describe('wallet service: accounts', () => {
  it('creates, lists, and unlocks accounts', async () => {
    const { meta } = await service.createAccount({ label: 'main' });
    expect(meta.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(service.listAccounts()).toHaveLength(1);
    expect(service.status().unlocked).toBe(true);
  });

  it('imports from a secret file and deletes the file', async () => {
    const secretFile = join(dir, 'secret.txt');
    await writeFile(secretFile, HARDHAT_MNEMONIC, { mode: 0o600 });
    const { meta } = await service.importAccount({ source: 'mnemonic', secretFile, label: 'hardhat' });
    expect(meta.address).toBe(HARDHAT_ACCOUNT_0);
    await expect(import('node:fs/promises').then((fs) => fs.stat(secretFile))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('locks and unlocks via the passphrase chain', async () => {
    await importHardhatAccount();
    service.lock();
    expect(service.status().unlocked).toBe(false);
    const { source } = await service.unlock();
    expect(source).toBe('env');
    expect(service.status().unlocked).toBe(true);
  });
});

describe('wallet service: send transaction under policy', () => {
  it('auto-signs and broadcasts when policy allows (localhost)', async () => {
    const accountId = await importHardhatAccount();
    // strict preset: localhost chain auto-allows small transfers.
    const result = await service.sendTransaction(
      { from: accountId, chainId: 31337, to: RECIPIENT, value: '1000' },
      approval,
    );
    expect(result.status).toBe('signed-broadcast');
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(provider.broadcasted).toHaveLength(1);
    const parsed = Transaction.from(provider.broadcasted[0]!);
    expect(getAddress(parsed.from!)).toBe(HARDHAT_ACCOUNT_0);
    expect(parsed.to?.toLowerCase()).toBe(RECIPIENT.toLowerCase());
    expect(parsed.value).toBe(1000n);
    expect(approval.requests).toHaveLength(0); // allow: no approval asked
  });

  it('asks for approval on mainnet and signs when allowed', async () => {
    const accountId = await importHardhatAccount();
    approval.outcome = 'allowed-once';
    const result = await service.sendTransaction(
      { from: accountId, chainId: 1, to: RECIPIENT, value: '1000' },
      approval,
    );
    expect(result.status).toBe('signed-broadcast');
    expect(approval.requests).toHaveLength(1);
    expect(approval.requests[0]!.reason).toContain('Approve transaction');
    expect(provider.broadcasted).toHaveLength(1);
  });

  it('does not sign when approval is rejected', async () => {
    const accountId = await importHardhatAccount();
    approval.outcome = 'rejected';
    const result = await service.sendTransaction(
      { from: accountId, chainId: 1, to: RECIPIENT, value: '1000' },
      approval,
    );
    expect(result.status).toBe('awaiting-approval-rejected');
    expect(result.approvalOutcome).toBe('rejected');
    expect(provider.broadcasted).toHaveLength(0);
  });

  it('refuses when policy denies (locked preset)', async () => {
    const accountId = await importHardhatAccount();
    await service.setPolicy(policyPreset('locked'));
    const result = await service.sendTransaction(
      { from: accountId, chainId: 31337, to: RECIPIENT, value: '1000' },
      approval,
    );
    expect(result.status).toBe('denied-by-policy');
    expect(provider.broadcasted).toHaveLength(0);
    expect(approval.requests).toHaveLength(0);
  });

  it('hard-denies large transfers under the strict preset', async () => {
    const accountId = await importHardhatAccount();
    const result = await service.sendTransaction(
      { from: accountId, chainId: 31337, to: RECIPIENT, value: '50000000000000000' }, // 0.05 ETH
      approval,
    );
    expect(result.status).toBe('denied-by-policy');
    expect(result.decision.ruleId).toBe('deny-large-transfers');
    expect(provider.broadcasted).toHaveLength(0);
  });

  it('records signed transactions in the spend window', async () => {
    const accountId = await importHardhatAccount();
    await service.sendTransaction({ from: accountId, chainId: 31337, to: RECIPIENT, value: '12345' }, approval);
    const spent = vault.spend.spentLast24hWei(HARDHAT_ACCOUNT_0);
    expect(spent).toBe(12345n);
  });
});

describe('wallet service: message signing under policy', () => {
  it('signs a message when policy allows', async () => {
    const accountId = await importHardhatAccount();
    // strict preset: signMessage falls to default ask.
    approval.outcome = 'allowed-once';
    const result = await service.signMessage({ account: accountId, message: 'hello' }, approval);
    expect(result.status).toBe('signed');
    expect(result.signature).toMatch(/^0x[0-9a-f]{130}$/i);
    expect(approval.requests).toHaveLength(1);
  });

  it('refuses a message when approval is rejected', async () => {
    const accountId = await importHardhatAccount();
    approval.outcome = 'rejected';
    const result = await service.signMessage({ account: accountId, message: 'hello' }, approval);
    expect(result.status).toBe('awaiting-approval-rejected');
    expect(result.signature).toBeUndefined();
  });

  it('signs typed data when approved', async () => {
    const accountId = await importHardhatAccount();
    approval.outcome = 'allowed-once';
    const domain = { name: 'Test', version: '1', chainId: 1 };
    const types = { Mail: [{ name: 'contents', type: 'string' }] };
    const value = { contents: 'hi' };
    const result = await service.signTypedData({ account: accountId, domain, types, value }, approval);
    expect(result.status).toBe('signed');
    expect(result.signature).toMatch(/^0x[0-9a-f]{130}$/i);
  });
});

describe('wallet service: policy management', () => {
  it('gets and sets the policy', async () => {
    expect(service.getPolicy().defaultEffect).toBe('ask');
    await service.setPolicy(policyPreset('locked'));
    expect(service.getPolicy().defaultEffect).toBe('deny');
  });

  it('rejects invalid policies', async () => {
    await expect(service.setPolicy({ ...policyPreset('strict'), defaultEffect: 'maybe' as never })).rejects.toThrow(/invalid policy/);
  });
});

describe('wallet service: secret reveal and export', () => {
  it('reveals the mnemonic only when unlocked', async () => {
    const accountId = await importHardhatAccount();
    const revealed = await service.revealSecret(accountId, 'mnemonic');
    expect(revealed.value).toBe(HARDHAT_MNEMONIC);
    service.lock();
    await expect(service.revealSecret(accountId, 'mnemonic')).rejects.toThrow(/locked/i);
  });

  it('exports a keystore that restores the same address', async () => {
    const accountId = await importHardhatAccount();
    const { json, address } = await service.exportKeystore(accountId, 'export-pass');
    const { Wallet } = await import('ethers');
    const restored = await Wallet.fromEncryptedJson(json, 'export-pass');
    expect(restored.address).toBe(address);
    expect(address).toBe(HARDHAT_ACCOUNT_0);
  });
});

describe('model tools', () => {
  it('registers the full tool surface', () => {
    const tools = buildTools({ service, approval });
    const names = tools.map((tool) => tool.name);
    for (const expected of [
      'wallet_status',
      'wallet_create',
      'wallet_import',
      'wallet_list',
      'wallet_remove_account',
      'wallet_unlock',
      'wallet_lock',
      'wallet_chains',
      'wallet_balance',
      'wallet_prepare_transaction',
      'wallet_send_transaction',
      'wallet_sign_message',
      'wallet_sign_typed_data',
      'wallet_policy_get',
      'wallet_policy_set',
      'wallet_reveal_secret',
      'wallet_export_keystore',
      'wallet_audit_log',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('wallet_status executes and renders', async () => {
    const tools = buildTools({ service, approval });
    const status = tools.find((tool) => tool.name === 'wallet_status')!;
    const value = await status.execute({}, {} as never);
    const blocks = status.output.render({}, value);
    expect(blocks[0]!.type).toBe('text');
    expect(JSON.parse(blocks[0]!.text)).toMatchObject({ unlocked: expect.any(Boolean) });
  });

  it('wallet_create hides the mnemonic unless reveal is approved', async () => {
    const tools = buildTools({ service, approval });
    const create = tools.find((tool) => tool.name === 'wallet_create')!;

    // Without reveal: no mnemonic in result.
    const hidden = (await create.execute({ label: 'a' }, {} as never)) as Record<string, unknown>;
    expect(hidden.mnemonic).toBeUndefined();
    expect(hidden.mnemonicRevealed).toBe(false);

    // With reveal + approval: mnemonic present.
    approval.outcome = 'allowed-once';
    const revealed = (await create.execute({ label: 'b', reveal: true }, {} as never)) as Record<string, unknown>;
    expect(revealed.mnemonicRevealed).toBe(true);
    expect(typeof revealed.mnemonic).toBe('string');

    // With reveal + rejection: mnemonic withheld.
    approval.outcome = 'rejected';
    const withheld = (await create.execute({ label: 'c', reveal: true }, {} as never)) as Record<string, unknown>;
    expect(withheld.mnemonicRevealed).toBe(false);
    expect(withheld.mnemonic).toBeUndefined();
  });

  it('wallet_send_transaction signs on allow and refuses on deny', async () => {
    const accountId = await importHardhatAccount();
    const tools = buildTools({ service, approval });
    const send = tools.find((tool) => tool.name === 'wallet_send_transaction')!;

    const allowed = (await send.execute(
      { account: accountId, chainId: 31337, to: RECIPIENT, value: '1' },
      {} as never,
    )) as Record<string, unknown>;
    expect(allowed.status).toBe('signed-broadcast');

    await service.setPolicy(policyPreset('locked'));
    const denied = (await send.execute(
      { account: accountId, chainId: 31337, to: RECIPIENT, value: '1' },
      {} as never,
    )) as Record<string, unknown>;
    expect(denied.status).toBe('denied-by-policy');
  });

  it('wallet_policy_set requires approval', async () => {
    const tools = buildTools({ service, approval });
    const setPolicy = tools.find((tool) => tool.name === 'wallet_policy_set')!;

    approval.outcome = 'rejected';
    const rejected = (await setPolicy.execute({ preset: 'locked' }, {} as never)) as Record<string, unknown>;
    expect(rejected.updated).toBe(false);
    expect(service.getPolicy().defaultEffect).toBe('ask'); // unchanged

    approval.outcome = 'allowed-once';
    const applied = (await setPolicy.execute({ preset: 'locked' }, {} as never)) as Record<string, unknown>;
    expect(applied.updated).toBe(true);
    expect(service.getPolicy().defaultEffect).toBe('deny');
  });

  it('wallet_reveal_secret requires approval', async () => {
    const accountId = await importHardhatAccount();
    const tools = buildTools({ service, approval });
    const reveal = tools.find((tool) => tool.name === 'wallet_reveal_secret')!;

    approval.outcome = 'rejected';
    const denied = (await reveal.execute({ account: accountId, kind: 'mnemonic' }, {} as never)) as Record<string, unknown>;
    expect(denied.value).toBeUndefined();

    approval.outcome = 'allowed-once';
    const granted = (await reveal.execute({ account: accountId, kind: 'mnemonic' }, {} as never)) as Record<string, unknown>;
    expect(granted.value).toBe(HARDHAT_MNEMONIC);
  });

  it('tool results never leak key material', async () => {
    const accountId = await importHardhatAccount();
    const tools = buildTools({ service, approval });
    const send = tools.find((tool) => tool.name === 'wallet_send_transaction')!;
    const value = await send.execute({ account: accountId, chainId: 31337, to: RECIPIENT, value: '1' }, {} as never);
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain(HARDHAT_MNEMONIC);
    // The account-0 private key must not appear either.
    expect(serialized).not.toContain('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  });
});

describe('http endpoints', () => {
  function get(path: string): Promise<{ status: number; body: unknown }> {
    const routes = buildRoutes(service);
    const route = routes.find((r) => r.path === path)!;
    return new Promise((resolvePromise) => {
      const res = {
        statusCode: 0,
        headers: {} as Record<string, string>,
        body: '',
        setHeader(name: string, value: string) {
          this.headers[name] = value;
        },
        end(body: string) {
          resolvePromise({ status: this.statusCode, body: JSON.parse(body) });
        },
      };
      void route.handler({ method: 'GET' }, res as never);
    });
  }

  it('serves status, accounts, policy, and audit as JSON', async () => {
    await importHardhatAccount();
    const status = await get('/api/dsh-web3/status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ unlocked: expect.any(Boolean) });

    const accounts = await get('/api/dsh-web3/accounts');
    expect((accounts.body as { accounts: unknown[] }).accounts).toHaveLength(1);

    const policy = await get('/api/dsh-web3/policy');
    expect((policy.body as { policy: { defaultEffect: string } }).policy.defaultEffect).toBe('ask');

    const audit = await get('/api/dsh-web3/audit');
    expect(Array.isArray((audit.body as { entries: unknown[] }).entries)).toBe(true);
  });

  it('never serves secrets over http', async () => {
    await importHardhatAccount();
    for (const path of ['/api/dsh-web3/status', '/api/dsh-web3/accounts', '/api/dsh-web3/policy', '/api/dsh-web3/audit']) {
      const { body } = await get(path);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(HARDHAT_MNEMONIC);
      expect(serialized).not.toContain('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
    }
  });
});

describe('plugin entrypoint (applyWalletPlugin)', () => {
  function createMockCtx() {
    const services = new Map<string, unknown>();
    const registeredTools: Array<{ name: string }> = [];
    const registeredRoutes: Array<{ path: string }> = [];
    const disposed: string[] = [];
    const ctx = {
      get(key: string) {
        return services.get(key);
      },
      provide(key: string, value: unknown) {
        services.set(key, value);
        return () => {
          services.delete(key);
          disposed.push(`provide:${key}`);
        };
      },
      logger() {
        return { info() {}, warn() {}, error() {}, debug() {} };
      },
      // mirrors for assertions
      services,
      registeredTools,
      registeredRoutes,
      disposed,
    };
    services.set('model.tools', {
      register(tool: { name: string }) {
        registeredTools.push(tool);
        return () => {
          disposed.push(`tool:${tool.name}`);
        };
      },
    });
    services.set('http', {
      get(path: string) {
        registeredRoutes.push({ path });
        return () => {
          disposed.push(`route:${path}`);
        };
      },
    });
    services.set('credentials', {
      resolve: async () => undefined,
      set: async () => undefined,
    });
    services.set('approval', {
      request: async () => 'unavailable' as const,
    });
    return ctx;
  }

  it('mounts ctx.wallet, registers tools and routes, and locks the vault on unload', async () => {
    const ctx = createMockCtx();
    const unload = applyWalletPlugin(ctx as never, { vaultPath: dir });

    await waitFor(() => ctx.get('wallet') !== undefined);
    const service = ctx.get('wallet') as WalletService;
    expect(service).toBeInstanceOf(WalletService);
    expect(service.status().unlocked).toBe(false); // fresh vault starts locked

    expect(ctx.registeredTools.some((tool) => tool.name === 'wallet_status')).toBe(true);
    expect(ctx.registeredTools.some((tool) => tool.name === 'wallet_send_transaction')).toBe(true);
    expect(ctx.registeredTools.some((tool) => tool.name === 'wallet_audit_log')).toBe(true);
    expect(ctx.registeredRoutes.some((route) => route.path === '/api/dsh-web3/status')).toBe(true);
    expect(ctx.registeredRoutes.some((route) => route.path === '/api/dsh-web3/accounts')).toBe(true);

    await unload();
    expect(ctx.get('wallet')).toBeUndefined();
    expect(service.status().unlocked).toBe(false); // vault locked on unload
    expect(ctx.disposed).toContain('provide:wallet');
  });

  it('skips tools and http when disabled in config', async () => {
    const ctx = createMockCtx();
    const unload = applyWalletPlugin(ctx as never, { vaultPath: dir, disableTools: true, disableHttp: true });
    await waitFor(() => ctx.get('wallet') !== undefined);
    expect(ctx.registeredTools).toHaveLength(0);
    expect(ctx.registeredRoutes).toHaveLength(0);
    await unload();
  });
});

describe('passphrase resolution', () => {
  it('prefers the environment variable', async () => {
    const resolved = await resolvePassphrase('manual', { [WALLET_PASSPHRASE_REF]: 'from-env' }, undefined);
    expect(resolved).toEqual({ passphrase: 'from-env', source: 'env' });
  });

  it('falls back to the credentials store', async () => {
    const credentials = {
      resolve: async () => ({ value: 'from-creds' }),
      set: async () => undefined,
    };
    const resolved = await resolvePassphrase('manual', {}, credentials);
    expect(resolved).toEqual({ passphrase: 'from-creds', source: 'credentials' });
  });

  it('generates and stores a passphrase in auto mode', async () => {
    let stored: string | undefined;
    const credentials = {
      resolve: async () => undefined,
      set: async (_ref: string, value: string) => {
        stored = value;
      },
    };
    const resolved = await resolvePassphrase('auto', {}, credentials);
    expect(resolved.source).toBe('generated');
    expect(resolved.passphrase.length).toBeGreaterThan(20);
    expect(stored).toBe(resolved.passphrase);
  });

  it('fails closed in manual mode with no source', async () => {
    await expect(resolvePassphrase('manual', {}, undefined)).rejects.toThrow(/no vault passphrase/);
  });

  it('reads a passphrase file once and deletes it', async () => {
    const file = join(dir, 'pass.txt');
    await writeFile(file, 'file-pass\n', { mode: 0o600 });
    const value = await passphraseFromFile(file);
    expect(value).toBe('file-pass');
    await expect(import('node:fs/promises').then((fs) => fs.stat(file))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('typert remote (DSH web integration)', () => {
  it('mounts the web3 Remote namespace and serves secret-free read models', async () => {
    const { Context } = await import('@deepseek-ai/cordis');
    const ctx = new Context();

    const registeredTools: Array<{ name: string }> = [];
    ctx.provide('model.tools', {
      register(tool: { name: string }) {
        registeredTools.push(tool);
        return () => {};
      },
    });
    ctx.provide('credentials', { resolve: async () => undefined, set: async () => {} });
    ctx.provide('approval', { request: async () => 'unavailable' as const });

    process.env[WALLET_PASSPHRASE_REF] = PASSPHRASE;
    try {
    const unload = applyWalletPlugin(ctx as never, {
      vaultPath: dir,
      passphrase: { mode: 'manual' },
    });
    await waitFor(() => ctx.get('wallet') !== undefined);
    await waitFor(() => ctx.get('web3') !== undefined);

    const remote = ctx.get('web3') as Web3Remote;
    expect(remote).toBeInstanceOf(Web3Remote);

    // Import an account through the plugin's own service.
    const walletService = ctx.get('wallet') as WalletService;
    const secretFile = join(dir, 'secret-remote.txt');
    await writeFile(secretFile, HARDHAT_MNEMONIC, { mode: 0o600 });
    await walletService.importAccount({ source: 'mnemonic', secretFile, label: 'hardhat' });

    const status = await remote.status(null);
    expect(status).toMatchObject({ unlocked: expect.any(Boolean) });

    const accounts = await remote.accounts(null);
    expect((accounts as { accounts: unknown[] }).accounts).toHaveLength(1);

    const policy = await remote.policy(null);
    expect((policy as { policy: { defaultEffect: string } }).policy.defaultEffect).toBe('ask');

    const audit = await remote.audit({ limit: 5 });
    expect(Array.isArray((audit as { entries: unknown[] }).entries)).toBe(true);

    const chains = await remote.chains(null);
    expect(Array.isArray((chains as { chains: unknown[] }).chains)).toBe(true);

    // Balances: business error shape for a missing account.
    const badBalance = await remote.balances({ chainId: 1, address: '0x0000000000000000000000000000000000000000' });
    expect((badBalance as { ok: boolean }).ok).toBe(false);

    // Never leak key material over the Remote surface.
    const serialized = JSON.stringify({ status, accounts, policy, audit });
    expect(serialized).not.toContain(HARDHAT_MNEMONIC);
    expect(serialized).not.toContain('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');

    await unload();
    expect(ctx.get('wallet')).toBeUndefined();
    } finally {
      delete process.env[WALLET_PASSPHRASE_REF];
    }
  });

  it('web3/create and web3/import manage wallets through the remote', async () => {
    const { Context } = await import('@deepseek-ai/cordis');
    const ctx = new Context();
    type ApprovalOutcome = 'allowed-once' | 'rejected' | 'throw';
    let approvalOutcome: ApprovalOutcome = 'allowed-once';
    ctx.provide('model.tools', { register() { return () => {}; } });
    ctx.provide('credentials', { resolve: async () => undefined, set: async () => {} });
    ctx.provide('approval', {
      request: async () => {
        if (approvalOutcome === 'throw') throw new Error('no session');
        return approvalOutcome;
      },
    });

    process.env[WALLET_PASSPHRASE_REF] = PASSPHRASE;
    try {
      const unload = applyWalletPlugin(ctx as never, {
        vaultPath: dir,
        passphrase: { mode: 'manual' },
      });
      await waitFor(() => ctx.get('web3') !== undefined);
      const remote = ctx.get('web3') as Web3Remote;

      // create without reveal: account created, mnemonic hidden
      const created = await remote.create({ label: 'ui-created' });
      expect((created as { ok?: boolean }).ok).not.toBe(false);
      const createValue = created as { meta: { address: string }; mnemonicRevealed: boolean };
      expect(createValue.meta.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(createValue.mnemonicRevealed).toBe(false);
      expect('mnemonic' in created).toBe(false);

      // create with reveal + approval allowed: mnemonic present
      approvalOutcome = 'allowed-once';
      const revealed = (await remote.create({ label: 'revealed', reveal: true })) as unknown as {
        meta: { address: string };
        mnemonic?: string;
        mnemonicRevealed: boolean;
      };
      expect(revealed.mnemonicRevealed).toBe(true);
      expect((revealed.mnemonic ?? '').split(' ')).toHaveLength(12);

      // create with reveal + approval rejected: mnemonic withheld
      approvalOutcome = 'rejected';
      const denied = (await remote.create({ label: 'denied', reveal: true })) as unknown as {
        mnemonic?: string;
        mnemonicRevealed: boolean;
      };
      expect(denied.mnemonicRevealed).toBe(false);
      expect(denied.mnemonic).toBeUndefined();

      // import from mnemonic
      approvalOutcome = 'allowed-once';
      const imported = (await remote.import({
        source: 'mnemonic',
        secret: HARDHAT_MNEMONIC,
        label: 'ui-imported',
        index: 0,
      })) as { ok?: boolean; meta?: { address: string } };
      expect(imported.ok).not.toBe(false);
      expect(imported.meta?.address).toBe(HARDHAT_ACCOUNT_0);

      // approval throwing (e.g. headless, no session) fails safe: no reveal
      approvalOutcome = 'throw';
      const safe = (await remote.create({ label: 'safe', reveal: true })) as unknown as {
        mnemonic?: string;
        mnemonicRevealed: boolean;
      };
      expect(safe.mnemonicRevealed).toBe(false);
      expect(safe.mnemonic).toBeUndefined();

      // bad source -> business error shape
      const bad = (await remote.import({ source: 'nonsense' as never })) as { ok: boolean; error: string };
      expect(bad.ok).toBe(false);

      // accounts count via remote reflects UI operations
      const accounts = (await remote.accounts(null)) as { accounts: unknown[] };
      expect(accounts.accounts.length).toBeGreaterThanOrEqual(2);

      await unload();
    } finally {
      delete process.env[WALLET_PASSPHRASE_REF];
    }
  });

  it('exposes all methods with a single "request" parameter (gateway wire contract)', () => {
    const methods = ['status', 'accounts', 'balances', 'policy', 'audit', 'chains', 'create', 'import'] as const;
    for (const method of methods) {
      const fn = (Web3Remote.prototype as never as Record<string, () => never>)[method];
      const source = Function.prototype.toString.call(fn);
      const open = source.indexOf('(');
      const close = source.indexOf(')', open + 1);
      const params = source
        .slice(open + 1, close)
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      expect(params).toEqual(['request']);
    }
  });
});
