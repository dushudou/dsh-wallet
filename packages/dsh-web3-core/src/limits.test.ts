import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AddressBook,
  PinGuard,
  PinInvalidError,
  PinLockedError,
  PIN_MAX_FAILURES,
  WalletVault,
  checkLimits,
  defaultLimits,
  isTighteningLimits,
  limitUsage,
  normalizeLimits,
  validateLimits,
  type Intent,
  type LimitContext,
  type WalletLimits,
} from '../src/index.js';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDT_ETH = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const DAI_ETH = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const ALICE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const MALLORY = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';

let dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-web3-limits-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

/** An uncapped base, so each test states exactly the caps it exercises. */
function uncapped(): WalletLimits {
  return { version: 1, updatedAt: new Date().toISOString(), whitelistOnly: false, usd: {}, native: {} };
}

function limits(patch: Partial<WalletLimits>): WalletLimits {
  return normalizeLimits({ ...uncapped(), ...patch });
}

function context(whitelist: string[] = [], recentSpend: LimitContext['recentSpend'] = []): LimitContext {
  const set = new Set(whitelist.map((address) => address.toLowerCase()));
  return { isWhitelisted: (address) => set.has(address.toLowerCase()), recentSpend };
}

const usdcTransfer = (amount: string, recipient = ALICE): Intent => ({ kind: 'token-transfer', token: USDC_BASE, recipient, amount });

describe('limits: validation', () => {
  it('starts with the small-amount caps', () => {
    const fresh = defaultLimits();
    expect(fresh.whitelistOnly).toBe(false);
    expect(fresh.includeTestnets).toBeUndefined();
    expect(fresh.usd).toEqual({ perTx: '100', perDay: '1000' });
    expect(fresh.native.ETH).toEqual({ perTx: '1', perDay: '100' });
    expect(fresh.native.BNB).toEqual({ perTx: '1', perDay: '100' });
    expect(validateLimits(fresh)).toEqual([]);
  });

  it('rejects amounts that are not plain decimals', () => {
    expect(() => limits({ usd: { perTx: '1e3' } })).toThrow(/plain decimal/);
    expect(() => limits({ usd: { perTx: '-5' } })).toThrow(/plain decimal/);
    expect(() => limits({ usd: { perTx: '1,000' } })).toThrow(/plain decimal/);
    expect(() => limits({ native: { eth: { perTx: '1' } } })).not.toThrow(); // symbol is upper-cased
    expect(limits({ native: { eth: { perTx: '1' } } }).native.ETH?.perTx).toBe('1');
  });

  it('drops empty caps when normalizing', () => {
    const normalized = limits({ usd: { perTx: '' }, native: { ETH: {} } });
    expect(normalized.usd).toEqual({});
    expect(normalized.native).toEqual({});
  });
});

describe('limits: whitelist', () => {
  const on = limits({ whitelistOnly: true });

  it('blocks direct transfers to addresses outside the whitelist', () => {
    const verdict = checkLimits(on, { chainId: 8453, intent: usdcTransfer('5', MALLORY) }, context([ALICE]));
    expect(verdict).toMatchObject({ ok: false, code: 'RECIPIENT_NOT_WHITELISTED' });
    expect(checkLimits(on, { chainId: 8453, intent: usdcTransfer('5', ALICE) }, context([ALICE]))).toEqual({ ok: true });
  });

  it('covers native transfers and payment authorizations', () => {
    const native: Intent = { kind: 'native-transfer', recipient: MALLORY, amount: '1' };
    expect(checkLimits(on, { chainId: 1, valueWei: 1n, intent: native }, context())).toMatchObject({ ok: false });
    const x402: Intent = { kind: 'transfer-authorization', token: USDC_BASE, recipient: MALLORY, amount: '1000' };
    expect(checkLimits(on, { chainId: 8453, intent: x402 }, context())).toMatchObject({ ok: false });
  });

  it('checks the pulling spender of a Permit2 signature transfer', () => {
    const permit: Intent = { kind: 'permit-transfer', token: USDC_BASE, spender: MALLORY, amount: '1' };
    expect(checkLimits(on, { chainId: 8453, intent: permit }, context())).toMatchObject({ ok: false });
    expect(checkLimits(on, { chainId: 8453, intent: permit }, context([MALLORY]))).toEqual({ ok: true });
  });

  it('leaves contract interactions to the policy', () => {
    const call: Intent = { kind: 'contract-call' };
    expect(checkLimits(on, { chainId: 1, intent: call }, context())).toEqual({ ok: true });
  });

  it('exempts testnets unless includeTestnets is set', () => {
    const intent: Intent = { kind: 'native-transfer', recipient: MALLORY, amount: '1' };
    expect(checkLimits(on, { chainId: 11155111, valueWei: 1n, intent }, context())).toEqual({ ok: true });
    const strict = limits({ whitelistOnly: true, includeTestnets: true });
    expect(checkLimits(strict, { chainId: 11155111, valueWei: 1n, intent }, context())).toMatchObject({ ok: false });
  });
});

describe('limits: caps', () => {
  it('caps stablecoins per transaction in USD across decimals', () => {
    const caps = limits({ usd: { perTx: '100' } });
    expect(checkLimits(caps, { chainId: 8453, intent: usdcTransfer('100000000') }, context())).toEqual({ ok: true }); // 100 USDC (6 dp)
    expect(checkLimits(caps, { chainId: 8453, intent: usdcTransfer('100000001') }, context())).toMatchObject({ ok: false, code: 'LIMIT_EXCEEDED', limit: 'usd.perTx' });
    const dai: Intent = { kind: 'token-transfer', token: DAI_ETH, recipient: ALICE, amount: '101000000000000000000' }; // 101 DAI (18 dp)
    expect(checkLimits(caps, { chainId: 1, intent: dai }, context())).toMatchObject({ ok: false, limit: 'usd.perTx' });
  });

  it('sums stablecoin spend wallet-wide across chains for the daily cap', () => {
    const caps = limits({ usd: { perDay: '50' } });
    const now = Date.now();
    const spent = [
      { ts: now - 1000, chainId: 1, valueWei: '0', token: USDT_ETH, tokenAmount: '30000000' }, // 30 USDT on Ethereum
      { ts: now - 25 * 3600_000, chainId: 8453, valueWei: '0', token: USDC_BASE, tokenAmount: '900000000' }, // outside the window
    ];
    expect(checkLimits(caps, { chainId: 8453, intent: usdcTransfer('20000000') }, context([], spent), now)).toEqual({ ok: true });
    expect(checkLimits(caps, { chainId: 8453, intent: usdcTransfer('20000001') }, context([], spent), now)).toMatchObject({ ok: false, limit: 'usd.perDay' });
    expect(limitUsage(caps, spent, now).usdSpentToday).toBe('30');
  });

  it('caps native coins per symbol, independent of other natives', () => {
    const caps = limits({ native: { ETH: { perTx: '0.5', perDay: '1' } } });
    const send = (wei: bigint, chainId: number) =>
      checkLimits(caps, { chainId, valueWei: wei, intent: { kind: 'native-transfer', recipient: ALICE, amount: wei.toString() } }, context([], [
        { ts: Date.now(), chainId: 8453, valueWei: '600000000000000000' }, // 0.6 ETH on Base
      ]));
    expect(send(500_000_000_000_000_000n, 1)).toMatchObject({ ok: false, limit: 'native.ETH.perDay' }); // 0.6 + 0.5 > 1
    expect(send(400_000_000_000_000_000n, 1)).toEqual({ ok: true });
    expect(send(600_000_000_000_000_000n, 42161)).toMatchObject({ ok: false, limit: 'native.ETH.perTx' });
    expect(send(5_000_000_000_000_000_000n, 56)).toEqual({ ok: true }); // BNB is not capped
  });

  it('applies native caps to value sent with contract calls', () => {
    const caps = limits({ native: { ETH: { perTx: '0.1' } } });
    const verdict = checkLimits(caps, { chainId: 1, valueWei: 200_000_000_000_000_000n, intent: { kind: 'contract-call' } }, context());
    expect(verdict).toMatchObject({ ok: false, limit: 'native.ETH.perTx' });
  });

  it('does not count approvals as spending', () => {
    const caps = limits({ usd: { perTx: '1' } });
    const approve: Intent = { kind: 'token-approve', token: USDC_BASE, spender: MALLORY, amount: '999000000' };
    expect(checkLimits(caps, { chainId: 8453, intent: approve }, context())).toEqual({ ok: true });
  });
});

describe('limits: tightening', () => {
  const base = limits({ whitelistOnly: true, usd: { perTx: '100', perDay: '500' }, native: { ETH: { perTx: '1' } } });

  it('treats lower or added caps as tightening', () => {
    expect(isTighteningLimits(base, limits({ ...base, usd: { perTx: '50', perDay: '500' } }))).toBe(true);
    expect(isTighteningLimits(base, limits({ ...base, native: { ETH: { perTx: '1', perDay: '2' }, BNB: { perTx: '1' } } }))).toBe(true);
    expect(isTighteningLimits(uncapped(), base)).toBe(true);
  });

  it('treats raised or removed caps and a disabled whitelist as loosening', () => {
    expect(isTighteningLimits(base, limits({ ...base, usd: { perTx: '101', perDay: '500' } }))).toBe(false);
    expect(isTighteningLimits(base, limits({ ...base, usd: { perDay: '500' } }))).toBe(false);
    expect(isTighteningLimits(base, limits({ ...base, whitelistOnly: false }))).toBe(false);
    expect(isTighteningLimits(base, limits({ ...base, native: {} }))).toBe(false);
  });
});

describe('vault: limits and rename', () => {
  it('persists limits and fails closed on a corrupt file', async () => {
    const dir = await tempDir();
    const vault = await WalletVault.open({ directory: dir });
    expect(vault.getLimits().whitelistOnly).toBe(false);
    await vault.setLimits(limits({ whitelistOnly: true, usd: { perTx: '10' } }));
    const reopened = await WalletVault.open({ directory: dir });
    expect(reopened.getLimits()).toMatchObject({ whitelistOnly: true, usd: { perTx: '10' } });
    await writeFile(join(dir, 'limits.json'), '{"version":1,"whitelistOnly":"yes"}');
    await expect(WalletVault.open({ directory: dir })).rejects.toThrow(/invalid limits/);
  });

  it('renames an account without touching its address', async () => {
    const dir = await tempDir();
    const vault = await WalletVault.open({ directory: dir });
    const { meta } = await vault.importMnemonic({ mnemonic: HARDHAT_MNEMONIC, label: 'old' }, 'vault-passphrase-1');
    await vault.unlock('vault-passphrase-1');
    const renamed = await vault.renameAccount(meta.id, '  Trading  ');
    expect(renamed).toMatchObject({ label: 'Trading', address: meta.address });
    expect(vault.getUnlockedAccount(meta.id).meta.label).toBe('Trading');
    expect(JSON.parse(await readFile(join(dir, 'vault.json'), 'utf8')).accounts[0].label).toBe('Trading');
    await expect(vault.renameAccount(meta.id, '   ')).rejects.toThrow(/1-64/);
    vault.lock();
  });
});

describe('address book: trusted contacts', () => {
  it('keeps trust only while the address is unchanged', async () => {
    const book = new AddressBook(await tempDir());
    await book.load();
    await book.upsert({ label: 'Alice', address: ALICE, trusted: true });
    expect(book.isTrusted(ALICE)).toBe(true);
    await book.upsert({ label: 'alice', address: ALICE, note: 'same person' });
    expect(book.isTrusted(ALICE)).toBe(true);
    await book.upsert({ label: 'Alice', address: MALLORY });
    expect(book.isTrusted(MALLORY)).toBe(false);
    expect(book.get('Alice')?.trusted).toBeUndefined();
  });

  it('toggles trust on an existing entry', async () => {
    const book = new AddressBook(await tempDir());
    await book.load();
    await book.upsert({ label: 'Bob', address: ALICE });
    await book.setTrusted('bob', true);
    expect(book.isTrusted(ALICE)).toBe(true);
    await book.setTrusted('Bob', false);
    expect(book.isTrusted(ALICE)).toBe(false);
    await expect(book.setTrusted('nobody', true)).rejects.toThrow(/no contact/);
  });
});

describe('PinGuard.changePin', () => {
  it('counts wrong current PINs toward the lockout', async () => {
    const guard = new PinGuard(await tempDir());
    await guard.load();
    await guard.setup('2468');
    for (let i = 0; i < PIN_MAX_FAILURES; i += 1) {
      await expect(guard.changePin('0000', '1357')).rejects.toBeInstanceOf(PinInvalidError);
    }
    expect(guard.status().locked).toBe(true);
    await expect(guard.changePin('2468', '1357')).rejects.toBeInstanceOf(PinLockedError);
  });
});
