import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { WalletVault } from '../src/vault.js';
import { detectPreset } from '../src/policy/presets.js';
import { generateMnemonic } from '../src/account.js';
import { looksLikePrivateKey, maskAddress, redactHexLike, redactRecord, assertNoSecrets } from '../src/redact.js';

const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';
const HARDHAT_ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const PASSPHRASE = 'vault-passphrase-1';

let dir: string;
let vault: WalletVault;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-web3-core-test-'));
  vault = await WalletVault.open({ directory: dir });
});

afterEach(async () => {
  vault?.lock();
  await rm(dir, { recursive: true, force: true });
});

describe('vault lifecycle', () => {
  it('initializes an empty vault with the small-amount defaults', () => {
    const status = vault.status();
    expect(status.directory).toBe(dir);
    expect(status.unlocked).toBe(false);
    expect(status.accountCount).toBe(0);
    expect(status.policySummary.defaultEffect).toBe('allow');
    expect(detectPreset(vault.getPolicy())).toBe('agent-semi');
    const limits = vault.getLimits();
    expect(limits.usd).toEqual({ perTx: '100', perDay: '1000' });
    expect(limits.native.ETH).toEqual({ perTx: '1', perDay: '100' });
  });

  it('creates accounts that unlock and sign', async () => {
    const { meta, mnemonic } = await vault.createAccount({ label: 'main' }, PASSPHRASE);
    expect(meta.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(mnemonic.split(' ')).toHaveLength(12);
    expect(vault.listAccounts()).toHaveLength(1);

    await vault.unlock(PASSPHRASE);
    const account = vault.getUnlockedAccount(meta.id);
    expect(account.wallet.address).toBe(meta.address);
    expect(account.reveal().privateKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('keeps key files encrypted and owner-only on disk', async () => {
    const { meta } = await vault.createAccount({ label: 'main' }, PASSPHRASE);
    const raw = await readFile(join(dir, 'keys', `${meta.id}.json`), 'utf8');
    expect(raw).not.toContain('privateKey');
    const info = await stat(join(dir, 'keys', `${meta.id}.json`));
    expect(info.mode & 0o077).toBe(0);
  });

  it('rejects group/world-readable key files', async () => {
    const { meta } = await vault.createAccount({ label: 'main' }, PASSPHRASE);
    const keyPath = join(dir, 'keys', `${meta.id}.json`);
    const { chmod } = await import('node:fs/promises');
    await chmod(keyPath, 0o644);
    await expect(vault.unlock(PASSPHRASE)).rejects.toThrow(/chmod 600/);
  });

  it('refuses the wrong passphrase', async () => {
    await vault.createAccount({ label: 'main' }, PASSPHRASE);
    await expect(vault.unlock('wrong')).rejects.toThrow(/decryption failed/i);
  });

  it('imports a mnemonic account at the right address', async () => {
    const { meta } = await vault.importMnemonic({ mnemonic: HARDHAT_MNEMONIC, label: 'hardhat' }, PASSPHRASE);
    expect(meta.address).toBe(HARDHAT_ACCOUNT_0);
  });

  it('imports a raw private key', async () => {
    const key = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    const { meta } = await vault.importPrivateKey({ privateKey: key, label: 'raw' }, PASSPHRASE);
    expect(meta.address).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    await vault.unlock(PASSPHRASE);
    expect(vault.getUnlockedAccount(meta.id).reveal().privateKey).toBe(key);
  });

  it('imports a Web3 Secret Storage keystore JSON', async () => {
    const source = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const keystoreJson = await source.encrypt('keystore-pass');
    const { meta } = await vault.importKeystore(
      { keystoreJson, keystorePassphrase: 'keystore-pass', label: 'json' },
      PASSPHRASE,
    );
    expect(meta.address).toBe(source.address);
  });

  it('exports an account back to a keystore JSON', async () => {
    const { meta } = await vault.importMnemonic({ mnemonic: HARDHAT_MNEMONIC }, PASSPHRASE);
    await vault.unlock(PASSPHRASE);
    const { json } = await vault.exportKeystore(meta.id, 'export-pass');
    const restored = await Wallet.fromEncryptedJson(json, 'export-pass');
    expect(restored.address).toBe(HARDHAT_ACCOUNT_0);
  });

  it('locks and zeroes unlocked state', async () => {
    const { meta } = await vault.createAccount({ label: 'main' }, PASSPHRASE);
    await vault.unlock(PASSPHRASE);
    expect(vault.unlocked).toBe(true);
    vault.lock();
    expect(vault.unlocked).toBe(false);
    expect(() => vault.getUnlockedAccount(meta.id)).toThrow(/locked/i);
  });

  it('auto-locks after the idle interval', async () => {
    const shortLockVault = await WalletVault.open({ directory: dir, autoLockMs: 1 });
    await shortLockVault.createAccount({ label: 'main' }, PASSPHRASE);
    await shortLockVault.unlock(PASSPHRASE);
    expect(shortLockVault.unlocked).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(shortLockVault.maybeAutoLock()).toBe(true);
    expect(shortLockVault.unlocked).toBe(false);
  });

  it('removes accounts including their key files', async () => {
    const { meta } = await vault.createAccount({ label: 'main' }, PASSPHRASE);
    await vault.removeAccount(meta.id);
    expect(vault.listAccounts()).toHaveLength(0);
    await expect(readFile(join(dir, 'keys', `${meta.id}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('finds accounts by address and label', async () => {
    const { meta } = await vault.importMnemonic({ mnemonic: HARDHAT_MNEMONIC, label: 'hardhat' }, PASSPHRASE);
    expect(vault.findAccount(meta.address)?.id).toBe(meta.id);
    expect(vault.findAccount(meta.address.toLowerCase())?.id).toBe(meta.id);
    expect(vault.findAccount('hardhat')?.id).toBe(meta.id);
    expect(vault.findAccount('missing')).toBeUndefined();
  });
});

describe('vault audit trail', () => {
  it('writes secret-free audit entries and refuses leaks', async () => {
    const { meta, mnemonic } = await vault.createAccount({ label: 'main' }, PASSPHRASE);
    await vault.unlock(PASSPHRASE);
    const entries = await vault.audit.recent(1, 20);
    expect(entries.length).toBeGreaterThan(0);
    const created = entries.find((entry) => entry.kind === 'account.created');
    expect(created?.detail.address).toBe(meta.address);

    const allFiles = await readFile(join(dir, 'audit', `audit-${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
    expect(allFiles).not.toContain(mnemonic);

    // A leaky audit entry is refused outright.
    const account = vault.getUnlockedAccount(meta.id);
    const secret = account.reveal().privateKey;
    await expect(vault.auditAppend('sign.decision', { note: secret }, [secret])).rejects.toThrow(/key material/);
  });
});

describe('vault policy integration', () => {
  it('evaluates signing policy with the live spend window', async () => {
    const { meta } = await vault.importMnemonic({ mnemonic: HARDHAT_MNEMONIC }, PASSPHRASE);
    const decision = vault.evaluateSignPolicy({
      type: 'signTransaction',
      account: { address: meta.address },
      chainId: 31337,
      to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      value: '1',
      data: '0x',
    });
    // strict preset: localhost chain auto-allows.
    expect(decision.effect).toBe('allow');

    await vault.setPolicy((await import('../src/policy/presets.js')).policyPreset('locked'));
    const denied = vault.evaluateSignPolicy({
      type: 'signTransaction',
      account: { address: meta.address },
      chainId: 1,
      to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      value: '1',
    });
    expect(denied.effect).toBe('deny');
  });
});

describe('redaction helpers', () => {
  it('detects exact secret leaks anywhere in a structure', () => {
    const secret = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    expect(() => assertNoSecrets({ nested: { deep: [`0x${secret}`] } }, [secret])).toThrow(/secret leak/);
    expect(() => assertNoSecrets({ ok: 'hello' }, [secret])).not.toThrow();
  });

  it('detects bare-hex variants of 0x-prefixed secrets', () => {
    const secret = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    expect(() => assertNoSecrets({ key: secret.slice(2) }, [secret])).toThrow(/secret leak/);
  });

  it('masks addresses and hex-like strings', () => {
    expect(maskAddress(HARDHAT_ACCOUNT_0)).toMatch(/^0xf39F…\w{4}$/);
    expect(redactHexLike(`found ${secretBare()} in logs`)).toContain('[REDACTED-HEX64]');
  });

  it('redacts key-named record fields', () => {
    const redacted = redactRecord({ privateKey: '0xabc', mnemonic: 'words here', label: 'keep' });
    expect(redacted.privateKey).toBe('[REDACTED]');
    expect(redacted.mnemonic).toBe('[REDACTED]');
    expect(redacted.label).toBe('keep');
  });

  it('recognizes private-key-shaped strings', () => {
    expect(looksLikePrivateKey('0x' + 'ab'.repeat(32))).toBe(true);
    expect(looksLikePrivateKey('ab'.repeat(32))).toBe(true);
    expect(looksLikePrivateKey('0x1234')).toBe(false);
  });
});

function secretBare(): string {
  return 'ab'.repeat(32);
}
