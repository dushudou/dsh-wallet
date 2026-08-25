import { describe, expect, it } from 'vitest';
import {
  accountFromPrivateKey,
  derivationPathFor,
  deriveFromMnemonic,
  generateMnemonic,
  isValidMnemonic,
  mnemonicId,
  normalizeMnemonic,
  toChecksumAddress,
} from '../src/account.js';

// The well-known Hardhat/Anvil test mnemonic and its first two accounts.
const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';
const HARDHAT_ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const HARDHAT_ACCOUNT_1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('mnemonic handling', () => {
  it('generates valid mnemonics of each supported length', () => {
    for (const words of [12, 15, 18, 21, 24] as const) {
      const phrase = generateMnemonic(words);
      expect(phrase.split(' ')).toHaveLength(words);
      expect(isValidMnemonic(phrase)).toBe(true);
    }
  });

  it('generates unique mnemonics', () => {
    const set = new Set(Array.from({ length: 8 }, () => generateMnemonic()));
    expect(set.size).toBe(8);
  });

  it('rejects invalid mnemonics', () => {
    expect(isValidMnemonic('not a real mnemonic phrase at all')).toBe(false);
    expect(isValidMnemonic('test test test test test test test test test test test broken')).toBe(false);
  });

  it('normalizes irregular whitespace', () => {
    expect(normalizeMnemonic(`  ${HARDHAT_MNEMONIC.replaceAll(' ', '  ')} \n`)).toBe(HARDHAT_MNEMONIC);
  });
});

describe('HD derivation (BIP-39/BIP-32 vectors)', () => {
  it('derives the well-known Hardhat account 0 at m/44\'/60\'/0\'/0/0', () => {
    const derived = deriveFromMnemonic(HARDHAT_MNEMONIC, 0);
    expect(derived.address).toBe(HARDHAT_ACCOUNT_0);
    expect(derived.path).toBe(derivationPathFor(0));
    expect(derived.index).toBe(0);
    expect(derived.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('derives the well-known Hardhat account 1 at index 1', () => {
    const derived = deriveFromMnemonic(HARDHAT_MNEMONIC, 1);
    expect(derived.address).toBe(HARDHAT_ACCOUNT_1);
    expect(derived.path).toBe("m/44'/60'/0'/0/1");
  });

  it('throws on an invalid mnemonic', () => {
    expect(() => deriveFromMnemonic('totally bogus phrase')).toThrow();
  });
});

describe('private key import', () => {
  it('accepts bare and 0x-prefixed keys and checksums the address', () => {
    const bare = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const withPrefix = accountFromPrivateKey(`0x${bare}`);
    const withoutPrefix = accountFromPrivateKey(bare);
    expect(withPrefix.address).toBe(HARDHAT_ACCOUNT_0);
    expect(withoutPrefix.address).toBe(HARDHAT_ACCOUNT_0);
    expect(withoutPrefix.privateKey).toBe(withPrefix.privateKey);
  });

  it('rejects invalid keys', () => {
    expect(() => accountFromPrivateKey('0x1234')).toThrow();
    expect(() => accountFromPrivateKey(`0x${'ff'.repeat(33)}`)).toThrow();
  });
});

describe('mnemonic ids', () => {
  it('is stable for the same phrase regardless of case/whitespace', async () => {
    const a = await mnemonicId(HARDHAT_MNEMONIC);
    const b = await mnemonicId(`  ${HARDHAT_MNEMONIC.toUpperCase()} `);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs between phrases', async () => {
    const a = await mnemonicId(HARDHAT_MNEMONIC);
    const b = await mnemonicId(generateMnemonic(12));
    expect(a).not.toBe(b);
  });
});

describe('address utilities', () => {
  it('checksums addresses', () => {
    expect(toChecksumAddress(HARDHAT_ACCOUNT_0.toLowerCase())).toBe(HARDHAT_ACCOUNT_0);
  });

  it('rejects malformed addresses', () => {
    expect(() => toChecksumAddress('0x123')).toThrow();
  });
});
