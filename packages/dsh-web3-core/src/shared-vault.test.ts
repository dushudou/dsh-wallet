import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WalletVault } from './vault.js';
import { policyPreset } from './policy/presets.js';
import { evaluatePolicy } from './policy/evaluate.js';
import { defaultLimits, normalizeLimits } from './limits.js';

const PASSPHRASE = 'vault-passphrase-1';
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';

let dir: string;
const open: WalletVault[] = [];

/** A second vault instance over the same directory: stands in for another process. */
async function openAgain(): Promise<WalletVault> {
  const vault = await WalletVault.open({ directory: dir });
  open.push(vault);
  return vault;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-web3-shared-'));
});

afterEach(async () => {
  for (const vault of open.splice(0)) vault.lock();
  await rm(dir, { recursive: true, force: true });
});

describe('vault state shared between processes', () => {
  it('sees accounts another instance created after it opened', async () => {
    const host = await openAgain();
    expect(host.listAccounts()).toHaveLength(0);

    const cli = await openAgain();
    const { meta } = await cli.createAccount({ label: 'HL签名钱包' }, PASSPHRASE);

    expect(host.listAccounts().map((account) => account.id)).toContain(meta.id);
    expect(host.findAccount(meta.id)?.address).toBe(meta.address);
    expect(host.requireAccount('HL签名钱包').id).toBe(meta.id);
  });

  it('unlocks an account created elsewhere without a restart', async () => {
    const host = await openAgain();
    await host.createAccount({ label: 'main' }, PASSPHRASE);
    await host.unlock(PASSPHRASE);

    const cli = await openAgain();
    const { meta } = await cli.createAccount({ label: 'late' }, PASSPHRASE);

    const account = await host.unlockedAccount(meta.id);
    expect(account.wallet.address).toBe(meta.address);
    expect(host.getUnlockedAccount(meta.id)).toBe(account);
  });

  it('does not drop accounts when a stale instance writes the index', async () => {
    const first = await openAgain();
    const second = await openAgain();
    const { meta: a } = await first.createAccount({ label: 'a' }, PASSPHRASE);
    const { meta: b } = await second.createAccount({ label: 'b' }, PASSPHRASE);
    // `first` never re-opened, but its write must merge with what `second` wrote.
    await first.createAccount({ label: 'c' }, PASSPHRASE);

    const ids = (await openAgain()).listAccounts().map((account) => account.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(ids).toHaveLength(3);
  });

  it('follows a policy change made by another instance', async () => {
    const host = await openAgain();
    const panel = await openAgain();
    expect(host.getPolicy().defaultEffect).toBe('allow');

    await panel.setPolicy(policyPreset('strict'));
    expect(host.getPolicy().defaultEffect).toBe('ask');
  });

  it('follows hard-limit changes made by another instance', async () => {
    const host = await openAgain();
    const panel = await openAgain();
    await panel.setLimits(normalizeLimits({ ...defaultLimits(), usd: { perTx: '5', perDay: '20' } }));
    expect(host.getLimits().usd).toEqual({ perTx: '5', perDay: '20' });
  });

  it('keeps the last good policy when the file is corrupted on disk', async () => {
    const host = await openAgain();
    const before = host.getPolicy();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'policy.json'), '{"not": "a policy"}', 'utf8');
    expect(host.getPolicy()).toEqual(before);
  });

  it('counts spend signed by another instance toward the 24h window', async () => {
    const host = await openAgain();
    const signer = await openAgain();
    const from = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    expect(host.spend.spentLast24hWei(from)).toBe(0n);

    await signer.spend.record({ chainId: 1, from, to: RECIPIENT, valueWei: '1000000000000000000' });
    expect(host.spend.spentLast24hWei(from)).toBe(1000000000000000000n);
  });
});

describe('agent autonomy preset', () => {
  const from = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const agent = policyPreset('agent-full');

  it('signs transfers and typed data unattended', () => {
    const decision = evaluatePolicy(agent, {
      type: 'signTransaction',
      account: { address: from },
      chainId: 1,
      to: RECIPIENT,
      value: '1000000000000000000',
    });
    expect(decision.effect).toBe('allow');

    const typed = evaluatePolicy(agent, {
      type: 'signTypedData',
      account: { address: from },
      chainId: 42161,
      typedData: JSON.stringify({ domain: { name: 'Exchange', chainId: 1337 }, types: {}, value: {} }),
    });
    expect(typed.effect).toBe('allow');
  });

  it('still asks for unlimited permissions', () => {
    const unlimited = 'f'.repeat(64);
    const decision = evaluatePolicy(agent, {
      type: 'signTransaction',
      account: { address: from },
      chainId: 1,
      to: '0x0000000000000000000000000000000000000001',
      value: '0',
      data: `0x095ea7b3${'0'.repeat(24)}${RECIPIENT.slice(2)}${unlimited}`,
    });
    expect(decision.effect).toBe('ask');
    expect(decision.guardrail).toBe('unlimited-permission');
  });
});
