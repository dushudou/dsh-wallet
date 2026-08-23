/**
 * BIP-39 mnemonic handling and account derivation, on top of ethers v6.
 *
 * All derivation follows the well-known EVM path m/44'/60'/0'/0/i.
 *
 * @module @dsh-wallet/core/account
 */

import { randomUUID } from 'node:crypto';
import {
  HDNodeWallet,
  Mnemonic,
  Wallet,
  getAddress,
  hexlify,
  randomBytes,
  toUtf8Bytes,
} from 'ethers';

/** Supported mnemonic lengths (BIP-39 word counts). */
export type MnemonicWords = 12 | 15 | 18 | 21 | 24;

/** The standard EVM BIP-44 derivation path prefix. */
export const DEFAULT_DERIVATION_PREFIX = "m/44'/60'/0'/0";

/** Bytes of entropy for each mnemonic word count. */
const ENTROPY_BYTES: Record<MnemonicWords, number> = {
  12: 16,
  15: 20,
  18: 24,
  21: 28,
  24: 32,
};

/** Derive a full path for an HD account index. */
export function derivationPathFor(index: number): string {
  return `${DEFAULT_DERIVATION_PREFIX}/${String(index)}`;
}

/** Whether the phrase is a valid BIP-39 mnemonic (checksum included). */
export function isValidMnemonic(phrase: string): boolean {
  try {
    Mnemonic.fromPhrase(phrase.trim().replace(/\s+/g, ' '));
    return true;
  } catch {
    return false;
  }
}

/** Normalize whitespace in a mnemonic phrase. */
export function normalizeMnemonic(phrase: string): string {
  return phrase.trim().replace(/\s+/g, ' ');
}

/** Generate a fresh BIP-39 mnemonic with OS randomness. */
export function generateMnemonic(words: MnemonicWords = 12): string {
  const entropy = randomBytes(ENTROPY_BYTES[words]);
  return Mnemonic.fromEntropy(entropy).phrase;
}

/** The fully derived account material. `privateKey` is a 0x-prefixed hex string. */
export interface DerivedAccount {
  address: string;
  privateKey: string;
  path: string;
  index: number;
}

/** Derive account `index` from a mnemonic at the standard EVM path. */
export function deriveFromMnemonic(phrase: string, index = 0, pathPrefix = DEFAULT_DERIVATION_PREFIX): DerivedAccount {
  const normalized = normalizeMnemonic(phrase);
  const mnemonic = Mnemonic.fromPhrase(normalized); // throws when invalid
  const wallet = HDNodeWallet.fromMnemonic(mnemonic, `${pathPrefix}/${String(index)}`);
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    path: `${pathPrefix}/${String(index)}`,
    index,
  };
}

/** Wrap a raw private key (hex) into account material; validates the key. */
export function accountFromPrivateKey(privateKey: string): { address: string; privateKey: string } {
  const trimmed = privateKey.trim();
  const normalized = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  const wallet = new Wallet(normalized); // throws when invalid
  return { address: wallet.address, privateKey: wallet.privateKey };
}

/** Derive the address that a private key controls, without keeping the key. */
export function addressOfPrivateKey(privateKey: string): string {
  return accountFromPrivateKey(privateKey).address;
}

/** Deterministic mnemonic group id: same phrase -> same id (SHA-256, first 16 hex). */
export async function mnemonicId(phrase: string): Promise<string> {
  const bytes = toUtf8Bytes(normalizeMnemonic(phrase).toLowerCase());
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Buffer.from(digest).toString('hex').slice(0, 16);
}

/** Generate a random account id (uuid v4). */
export function newAccountId(): string {
  return randomUUID();
}

/** Checksum an address; throws on invalid input. */
export function toChecksumAddress(address: string): string {
  return getAddress(address.trim());
}

/** Validate and normalize a hex blob (`0x`-prefixed). */
export function normalizeHexData(data: string | undefined): string | undefined {
  if (data === undefined || data === '') return undefined;
  const trimmed = data.trim();
  const normalized = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(normalized)) throw new Error(`invalid hex data: ${maskHexForError(normalized)}`);
  return normalized === '0x' ? '0x' : normalized.toLowerCase();
}

function maskHexForError(value: string): string {
  return `${value.slice(0, 12)}…(len ${String(value.length)})`;
}

/** Hexlify arbitrary bytes for consistent 0x formatting. */
export function hexlifyBytes(bytes: Uint8Array): string {
  return hexlify(bytes);
}
