import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transaction, getAddress, verifyTypedData } from 'ethers';
import { WalletVault, policyPreset } from 'dsh-web3-core';
import { applyWalletPlugin } from '../src/index.js';
import { WalletService } from '../src/service.js';
import { buildTools } from '../src/tools.js';
import { buildRoutes } from '../src/http.js';
import { Web3Remote } from '../src/remote.js';
import { resolvePassphrase, passphraseFromFile, WALLET_PASSPHRASE_REF } from '../src/passphrase.js';
import type { SecretStore } from '../src/keychain.js';
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
  // Synchronous lock: service.lock() persists PIN state asynchronously and
  // would race with the directory removal (ENOTEMPTY flakes).
  service?.vault.lock();
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
    expect(approval.requests[0]!.reason).toContain('Send 0.000000000000001 ETH');
    expect(approval.requests[0]!.reason).toContain(RECIPIENT); // full address, never truncated
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

  it('authorizes an x402 payment (EIP-3009 TransferWithAuthorization)', async () => {
    const accountId = await importHardhatAccount();
    approval.outcome = 'allowed-once';
    const challenge = {
      x402Version: 2,
      accepts: [
        { scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '1000000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' },
      ],
    };
    const result = await service.authorizeX402({ account: accountId, challenge, ttlSeconds: 300 }, approval);
    if (result.status !== 'signed') throw new Error('expected signed, got ' + result.status);
    expect(result.status).toBe('signed');
    expect(result.signature).toMatch(/^0x[0-9a-f]{130}$/i);
    expect(result.chainId).toBe(8453);
    expect(result.asset).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(result.payTo).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    expect(result.amount).toBe('1000000');
    expect(result.authorization.value).toBe('1000000');
    expect(result.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(result.authorization.validBefore - nowSeconds).toBeGreaterThanOrEqual(299);
    expect(result.authorization.validBefore - nowSeconds).toBeLessThanOrEqual(300);
    expect(result.authorization.validAfter).toBeLessThan(nowSeconds); // tolerates facilitator clock skew
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    // Base mainnet USDC's EIP-712 domain is "USD Coin" v2 — signing with "USDC" would be rejected on-chain.
    const recovered = verifyTypedData(
      { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: result.asset },
      {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      result.authorization,
      result.signature,
    );
    expect(recovered).toBe(HARDHAT_ACCOUNT_0);
    expect(result.amountFormatted).toBe('1 USDC');
  });

  it('uses the EIP-712 domain declared in the x402 challenge (extra.name/version)', async () => {
    const accountId = await importHardhatAccount();
    approval.outcome = 'allowed-once';
    const challenge = {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:84532',
          amount: '10000',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          maxTimeoutSeconds: 120,
          extra: { name: 'USDC', version: '2' },
        },
      ],
    };
    const result = await service.authorizeX402({ account: accountId, challenge, ttlSeconds: 900 }, approval);
    if (result.status !== 'signed') throw new Error('expected signed, got ' + result.status);
    expect(result.authorization.validBefore - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(120); // capped by maxTimeoutSeconds
    const recovered = verifyTypedData(
      { name: 'USDC', version: '2', chainId: 84532, verifyingContract: result.asset },
      {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      result.authorization,
      result.signature,
    );
    expect(recovered).toBe(HARDHAT_ACCOUNT_0);
  });

  it('rejects an x402 amount above maxAmountRequired', async () => {
    const accountId = await importHardhatAccount();
    approval.outcome = 'allowed-once';
    const challenge = { payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', maxAmountRequired: '1000000', network: 'base' };
    await expect(service.authorizeX402({ account: accountId, challenge, amount: '2000000' }, approval)).rejects.toThrow('exceeds maxAmountRequired');
  });

  it('rejects an unsupported x402 network', async () => {
    const accountId = await importHardhatAccount();
    approval.outcome = 'allowed-once';
    const challenge = { payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', maxAmountRequired: '1', network: 'weirdnet' };
    await expect(service.authorizeX402({ account: accountId, challenge }, approval)).rejects.toThrow('unsupported x402 network');
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

  it('wallet_create never returns the mnemonic by default (backup happens in the panel)', async () => {
    const tools = buildTools({ service, approval });
    const create = tools.find((tool) => tool.name === 'wallet_create')!;
    approval.outcome = 'allowed-once';
    const result = (await create.execute({ label: 'a', reveal: true }, {} as never)) as Record<string, unknown>;
    expect(result.mnemonic).toBeUndefined();
    expect(result.mnemonicRevealed).toBe(false);
    expect(result.status).toBe('use-panel');
    expect(approval.requests).toHaveLength(0);
  });

  it('wallet_create hides the mnemonic unless reveal is approved (unsafe opt-in)', async () => {
    const tools = buildTools({ service, approval, allowModelSecretReveal: true });
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

  it('wallet_reveal_secret never returns key material by default', async () => {
    const accountId = await importHardhatAccount();
    const tools = buildTools({ service, approval });
    const reveal = tools.find((tool) => tool.name === 'wallet_reveal_secret')!;
    approval.outcome = 'allowed-once';
    const result = (await reveal.execute({ account: accountId, kind: 'privateKey' }, {} as never)) as Record<string, unknown>;
    expect(result.value).toBeUndefined();
    expect(result.status).toBe('use-panel');
    expect(JSON.stringify(result)).not.toContain('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  });

  it('wallet_reveal_secret requires approval (unsafe opt-in)', async () => {
    const accountId = await importHardhatAccount();
    const tools = buildTools({ service, approval, allowModelSecretReveal: true });
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

  /** In-memory stand-in for the macOS Keychain. */
  function memoryKeychain(initial: Record<string, string> = {}): SecretStore & { items: Map<string, string> } {
    const items = new Map(Object.entries(initial));
    return {
      kind: 'keychain',
      items,
      get: async (name) => items.get(name),
      set: async (name, value) => {
        items.set(name, value);
      },
      delete: async (name) => {
        items.delete(name);
      },
    };
  }

  it('prefers the keychain over the credentials store', async () => {
    const keychain = memoryKeychain({ [WALLET_PASSPHRASE_REF]: 'from-keychain' });
    const credentials = { resolve: async () => ({ value: 'from-creds', source: 'file' }), set: async () => undefined };
    const resolved = await resolvePassphrase('auto', {}, credentials, { keychain });
    expect(resolved).toEqual({ passphrase: 'from-keychain', source: 'keychain' });
  });

  it('moves a passphrase out of the plaintext credentials file into the keychain', async () => {
    const keychain = memoryKeychain();
    const unset: string[] = [];
    const credentials = {
      resolve: async () => ({ value: 'from-file', source: 'file' }),
      set: async () => undefined,
      unset: async (ref: string) => {
        unset.push(ref);
      },
    };
    const resolved = await resolvePassphrase('auto', {}, credentials, { keychain });
    expect(resolved).toEqual({ passphrase: 'from-file', source: 'keychain', migrated: true });
    expect(keychain.items.get(WALLET_PASSPHRASE_REF)).toBe('from-file');
    expect(unset).toEqual([WALLET_PASSPHRASE_REF]);
  });

  it('keeps the plaintext copy when the keychain write fails', async () => {
    const keychain = memoryKeychain();
    keychain.set = async () => {
      throw new Error('keychain write did not persist');
    };
    const unset: string[] = [];
    const credentials = {
      resolve: async () => ({ value: 'from-file', source: 'file' }),
      set: async () => undefined,
      unset: async (ref: string) => {
        unset.push(ref);
      },
    };
    await expect(resolvePassphrase('auto', {}, credentials, { keychain })).rejects.toThrow(/did not persist/);
    expect(unset).toEqual([]);
  });

  it('does not migrate read-only sources such as .env files', async () => {
    const keychain = memoryKeychain();
    const credentials = { resolve: async () => ({ value: 'from-dotenv', source: 'project-env' }), set: async () => undefined };
    const resolved = await resolvePassphrase('auto', {}, credentials, { keychain });
    expect(resolved).toEqual({ passphrase: 'from-dotenv', source: 'credentials' });
    expect(keychain.items.size).toBe(0);
  });

  it('stores a generated passphrase in the keychain, not the credentials file', async () => {
    const keychain = memoryKeychain();
    let stored: string | undefined;
    const credentials = {
      resolve: async () => undefined,
      set: async (_ref: string, value: string) => {
        stored = value;
      },
    };
    const resolved = await resolvePassphrase('auto', {}, credentials, { keychain });
    expect(resolved.source).toBe('generated');
    expect(keychain.items.get(WALLET_PASSPHRASE_REF)).toBe(resolved.passphrase);
    expect(stored).toBeUndefined();
  });

  it('refuses to generate a passphrase once the vault holds accounts', async () => {
    const keychain = memoryKeychain();
    await expect(resolvePassphrase('auto', {}, undefined, { keychain, allowGenerate: false })).rejects.toThrow(/already holds accounts/);
    expect(keychain.items.size).toBe(0);
  });

  it('propagates a keychain read error instead of generating', async () => {
    const keychain = memoryKeychain();
    keychain.get = async () => {
      throw new Error('keychain read failed (exit 51)');
    };
    await expect(resolvePassphrase('auto', {}, undefined, { keychain })).rejects.toThrow(/keychain read failed/);
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
    ctx.provide('model.tools', { register() { return () => {}; } });
    ctx.provide('credentials', { resolve: async () => undefined, set: async () => {} });
    ctx.provide('approval', { request: async () => 'rejected' });

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

      // create with reveal: panel-authorized direct reveal (Metamask model)
      const revealed = (await remote.create({ label: 'revealed', reveal: true })) as unknown as {
        meta: { address: string };
        mnemonic?: string;
        mnemonicRevealed: boolean;
      };
      expect(revealed.mnemonicRevealed).toBe(true);
      expect((revealed.mnemonic ?? '').split(' ')).toHaveLength(12);

      // import from mnemonic
      const imported = (await remote.import({
        source: 'mnemonic',
        secret: HARDHAT_MNEMONIC,
        label: 'ui-imported',
        index: 0,
      })) as { ok?: boolean; meta?: { address: string } };
      expect(imported.ok).not.toBe(false);
      expect(imported.meta?.address).toBe(HARDHAT_ACCOUNT_0);

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
