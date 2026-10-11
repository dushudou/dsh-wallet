/**
 * Asset and counterparty resolution for agent-driven transfers.
 *
 * The model speaks in human terms ("5 USDC to Alice on Base"); signing needs
 * exact atomic amounts and checksummed addresses. Every conversion that
 * could silently lose funds happens here, deterministically, on the wallet
 * side:
 *
 * - token symbols resolve only through the user's configured tokens or the
 *   curated registry (never a model-supplied guess), and decimals are
 *   cross-checked on-chain;
 * - amounts are decimal strings parsed with the token's real decimals
 *   (no float math, no hand-converted wei);
 * - recipients resolve by exact match only (address, ENS, address-book
 *   label, own account) and are checked for address-poisoning look-alikes.
 *
 * @module dsh-web3/assets
 */

import { getAddress, parseUnits, formatUnits, ZeroAddress } from 'ethers';
import {
  decodeErc20Read,
  encodeErc20Read,
  findKnownToken,
  getChain,
  knownTokens,
  type AddressBook,
  type ChainProvider,
  type TokenSpec,
  type WalletVault,
} from 'dsh-web3-core';
import { WalletError } from './errors.js';

/** A resolved asset: the chain's native coin or an ERC-20 token. */
export type ResolvedAsset =
  | { kind: 'native'; symbol: string; decimals: number }
  | { kind: 'erc20'; address: string; symbol: string; decimals: number; source: 'config' | 'registry' | 'chain'; verified: boolean; eip712?: { name: string; version: string } };

/** How a recipient string became an address. */
export interface ResolvedRecipient {
  input: string;
  address: string;
  via: 'address' | 'ens' | 'address-book' | 'own-account';
  label?: string;
}

const NATIVE_ALIASES = new Set(['', 'native', 'eth', 'ether']);

/** Is `token` a request for the chain's native coin? */
export function isNativeToken(token: string | undefined, chainId: number): boolean {
  if (token === undefined) return true;
  const lower = token.trim().toLowerCase();
  if (NATIVE_ALIASES.has(lower) && (lower !== 'eth' || (getChain(chainId)?.symbol ?? 'ETH') === 'ETH')) return true;
  return lower === (getChain(chainId)?.symbol ?? '').toLowerCase();
}

async function readCall(provider: ChainProvider, to: string, fn: 'decimals' | 'symbol' | 'name' | 'version' | 'balanceOf' | 'allowance', args: unknown[] = []): Promise<unknown> {
  try {
    return decodeErc20Read(fn, await provider.call({ to, data: encodeErc20Read(fn, args) }));
  } catch {
    return undefined;
  }
}

/**
 * Resolve a token reference (symbol, address, or native alias) on a chain.
 * Symbols resolve only through configured tokens and the curated registry.
 */
export async function resolveAsset(
  provider: ChainProvider,
  chainId: number,
  token: string | undefined,
  configured: TokenSpec[],
): Promise<ResolvedAsset> {
  const chain = getChain(chainId);
  if (isNativeToken(token, chainId)) {
    return { kind: 'native', symbol: chain?.symbol ?? 'ETH', decimals: chain?.decimals ?? 18 };
  }
  const needle = token!.trim();
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(needle);
  const fromConfig = configured.find(
    (spec) => spec.address.toLowerCase() === needle.toLowerCase() || (spec.symbol ?? '').toLowerCase() === needle.toLowerCase(),
  );
  const fromRegistry = findKnownToken(chainId, needle);
  let address: string;
  let symbol: string | undefined;
  let decimals: number | undefined;
  let source: 'config' | 'registry' | 'chain';
  if (fromConfig !== undefined) {
    address = getAddress(fromConfig.address);
    symbol = fromConfig.symbol ?? fromRegistry?.symbol;
    decimals = fromConfig.decimals ?? fromRegistry?.decimals;
    source = 'config';
  } else if (fromRegistry !== undefined) {
    ({ address, symbol, decimals } = fromRegistry);
    source = 'registry';
  } else if (isAddress) {
    try {
      address = getAddress(needle);
    } catch {
      throw new WalletError('INVALID_ADDRESS', `token address ${needle} has an invalid checksum`, 'Ask the user to paste the token address again.');
    }
    source = 'chain';
  } else {
    const known = knownTokens(chainId).map((entry) => entry.symbol);
    throw new WalletError(
      'UNKNOWN_TOKEN',
      `token "${needle}" is not known on chain ${String(chainId)}`,
      known.length > 0
        ? `Known symbols on this chain: ${known.join(', ')}. For other tokens pass the exact contract address (ask the user; never guess it).`
        : 'Pass the exact token contract address (ask the user; never guess it).',
    );
  }

  const code = await provider.getCode(address).catch(() => undefined);
  if (code === '0x') {
    throw new WalletError(
      'UNKNOWN_TOKEN',
      `no contract deployed at ${address} on chain ${String(chainId)}`,
      'The token address belongs to a different chain, or is wrong. Check the chainId.',
    );
  }
  const onChainDecimals = await readCall(provider, address, 'decimals');
  const chainDecimals = typeof onChainDecimals === 'bigint' ? Number(onChainDecimals) : undefined;
  if (chainDecimals !== undefined && decimals !== undefined && chainDecimals !== decimals) {
    throw new WalletError(
      'TOKEN_MISMATCH',
      `token ${address} reports ${String(chainDecimals)} decimals on-chain but ${String(decimals)} are expected`,
      'Refusing to guess amounts; verify the token address and chain with the user.',
    );
  }
  const finalDecimals = decimals ?? chainDecimals;
  if (finalDecimals === undefined) {
    throw new WalletError('UNKNOWN_TOKEN', `could not read decimals for token ${address}`, 'The RPC may be failing, or this is not an ERC-20 token.');
  }
  if (symbol === undefined) {
    const onChainSymbol = await readCall(provider, address, 'symbol');
    symbol = typeof onChainSymbol === 'string' && onChainSymbol.length > 0 ? onChainSymbol : 'UNKNOWN';
  }
  return {
    kind: 'erc20',
    address,
    symbol,
    decimals: finalDecimals,
    source,
    verified: chainDecimals !== undefined,
    ...(fromRegistry?.eip712 !== undefined ? { eip712: fromRegistry.eip712 } : {}),
  };
}

/** Parse a human decimal amount ("0.05") into atomic units with exact decimals. */
export function parseAmount(amount: string, decimals: number, symbol: string): bigint {
  const trimmed = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new WalletError(
      'INVALID_AMOUNT',
      `amount "${String(amount)}" is not a plain decimal number`,
      'Use a decimal string in whole token units, e.g. "0.05" or "25" (no commas, units, or scientific notation), or "max".',
    );
  }
  const fraction = trimmed.split('.')[1] ?? '';
  if (fraction.length > decimals) {
    throw new WalletError('INVALID_AMOUNT', `${symbol} supports at most ${String(decimals)} decimal places`, 'Round the amount and retry.');
  }
  const atomic = parseUnits(trimmed, decimals);
  if (atomic <= 0n) throw new WalletError('INVALID_AMOUNT', 'amount must be greater than zero');
  return atomic;
}

/** Format atomic units for display: "1.5 USDC" (trailing ".0" dropped). */
export function formatAmount(atomic: bigint | string, decimals: number, symbol: string): string {
  const text = formatUnits(BigInt(atomic), decimals).replace(/\.0$/, '');
  return `${text} ${symbol}`;
}

/** ERC-20 balance, or undefined when it cannot be read. */
export async function tokenBalanceOf(provider: ChainProvider, token: string, holder: string): Promise<bigint | undefined> {
  const value = await readCall(provider, token, 'balanceOf', [holder]);
  return typeof value === 'bigint' ? value : undefined;
}

/** ERC-20 allowance, or undefined when it cannot be read. */
export async function tokenAllowance(provider: ChainProvider, token: string, owner: string, spender: string): Promise<bigint | undefined> {
  const value = await readCall(provider, token, 'allowance', [owner, spender]);
  return typeof value === 'bigint' ? value : undefined;
}

/** EIP-712 domain name/version declared by a token contract, when readable. */
export async function tokenEip712Domain(provider: ChainProvider, token: string): Promise<{ name: string; version: string } | undefined> {
  const [name, version] = await Promise.all([readCall(provider, token, 'name'), readCall(provider, token, 'version')]);
  return typeof name === 'string' && typeof version === 'string' ? { name, version } : undefined;
}

/**
 * Resolve a recipient reference by exact match only: 0x address, ENS name,
 * address-book label, or the label/id of one of the user's own accounts.
 */
export async function resolveRecipient(
  input: string,
  chainId: number,
  deps: { vault: WalletVault; addressBook: AddressBook; ensProvider: () => Promise<ChainProvider> },
): Promise<ResolvedRecipient> {
  const raw = String(input ?? '').trim();
  if (raw.length === 0) throw new WalletError('INVALID_RECIPIENT', 'recipient is required');
  let resolved: ResolvedRecipient | undefined;
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    let address: string;
    try {
      address = getAddress(raw);
    } catch {
      throw new WalletError(
        'INVALID_ADDRESS',
        `address ${raw} has an invalid EIP-55 checksum`,
        'The address was probably mistyped. Ask the user to paste it again; do not "fix" it yourself.',
      );
    }
    resolved = { input: raw, address, via: 'address' };
  } else if (/^0x/i.test(raw)) {
    throw new WalletError('INVALID_ADDRESS', `"${raw}" is not a 40-hex-character address`, 'Ask the user for the full address; never complete or guess missing characters.');
  } else {
    // Exact labels first (address book, then own accounts), ENS last.
    const entry = deps.addressBook.resolve(raw, chainId);
    const own = entry === undefined ? deps.vault.findAccount(raw) : undefined;
    if (entry !== undefined) {
      resolved = { input: raw, address: entry.address, via: 'address-book', label: entry.label };
    } else if (own !== undefined) {
      resolved = { input: raw, address: getAddress(own.address), via: 'own-account', label: own.label };
    } else if (/^[^\s]+\.[a-z]{2,}$/i.test(raw)) {
      const provider = await deps.ensProvider();
      if (provider.resolveName === undefined) throw new WalletError('INVALID_RECIPIENT', `cannot resolve ENS name ${raw} (no ENS-capable provider)`);
      const address = await provider.resolveName(raw).catch(() => null);
      if (address === null || address === undefined) {
        throw new WalletError('INVALID_RECIPIENT', `ENS name ${raw} does not resolve to an address`, 'Ask the user for the 0x address instead.');
      }
      resolved = { input: raw, address: getAddress(address), via: 'ens', label: raw };
    }
  }
  if (resolved === undefined) {
    throw new WalletError(
      'INVALID_RECIPIENT',
      `"${raw}" is not an address, ENS name, address-book label, or own account`,
      'Pass a full 0x address or an ENS name, or save the contact first (wallet_address_book add). Labels must match exactly.',
    );
  }
  if (resolved.address === ZeroAddress) {
    throw new WalletError('BLOCKED', 'refusing to send to the zero address (funds would be burned)');
  }
  return resolved;
}

/**
 * Address-poisoning check: a new recipient that shares the first and last 4
 * hex characters with a known counterparty is almost certainly a look-alike
 * planted in the user's history.
 */
export function lookAlikeOf(address: string, known: Iterable<string>): string | undefined {
  const lower = address.toLowerCase();
  for (const candidate of known) {
    const other = candidate.toLowerCase();
    if (other === lower) return undefined;
  }
  for (const candidate of known) {
    const other = candidate.toLowerCase();
    if (other.slice(2, 6) === lower.slice(2, 6) && other.slice(-4) === lower.slice(-4)) return getAddress(candidate);
  }
  return undefined;
}
