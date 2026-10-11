/**
 * Intent classification: what a transaction or typed-data signature actually
 * does to the signer's assets.
 *
 * A native `value` check alone cannot tell a harmless contract call from
 * `transfer(attacker, balance)` or an unlimited `approve` — both carry
 * `value: 0`. The classifier decodes the well-known asset-moving and
 * permission-granting shapes (ERC-20/721/1155, Permit2, EIP-2612,
 * EIP-3009, marketplace orders) so the policy engine can gate them and
 * approval prompts can show real amounts instead of raw calldata.
 *
 * Classification is pure and offline (no RPC); token metadata (symbol,
 * decimals) is attached by callers that have a provider.
 *
 * @module dsh-web3-core/intent
 */

import { Interface, TypedDataEncoder, getAddress, type TypedDataField } from 'ethers';

/** What an operation does, from the signer's point of view. */
export type IntentKind =
  /** Plain native-currency transfer (no calldata). */
  | 'native-transfer'
  /** ERC-20 `transfer` / `transferFrom` (moves fungible tokens; also ERC-721 `transferFrom`). */
  | 'token-transfer'
  /** Grants a spender allowance: ERC-20 `approve`/`increaseAllowance`, Permit2 `approve`. */
  | 'token-approve'
  /** Removes a permission: `approve(spender, 0)`, `setApprovalForAll(op, false)`. */
  | 'token-revoke'
  /** ERC-721 / ERC-1155 safe transfers. */
  | 'nft-transfer'
  /** `setApprovalForAll(operator, true)` — operator may move every NFT in the collection. */
  | 'nft-approval'
  /** Any other contract call. */
  | 'contract-call'
  /** EIP-2612 / DAI / Permit2 allowance permits (off-chain signature granting allowance). */
  | 'permit'
  /** Permit2 signature transfers (off-chain signature that directly moves tokens). */
  | 'permit-transfer'
  /** EIP-3009 Transfer/ReceiveWithAuthorization (e.g. x402 payments). */
  | 'transfer-authorization'
  /** Marketplace order signatures (Seaport etc.) — can sell assets. */
  | 'order'
  /** Unrecognized EIP-712 payload. */
  | 'typed-data'
  /** EIP-191 personal message. */
  | 'message';

/** Intents that move assets or grant permissions over them. */
export const SENSITIVE_INTENTS: readonly IntentKind[] = [
  'token-transfer',
  'token-approve',
  'nft-transfer',
  'nft-approval',
  'permit',
  'permit-transfer',
  'transfer-authorization',
  'order',
];

/** Intents carrying a fungible token amount that `tokenLimits` can cap. */
export const AMOUNT_INTENTS: readonly IntentKind[] = [
  'token-transfer',
  'token-approve',
  'permit',
  'permit-transfer',
  'transfer-authorization',
];

/** Secret-free description of an operation's effect. */
export interface Intent {
  kind: IntentKind;
  /** Decoded method or EIP-712 primary type. */
  method?: string;
  /** Token contract (fungible or NFT) the intent operates on. */
  token?: string;
  /** Final recipient of assets (may differ from the tx `to`, which is the token contract). */
  recipient?: string;
  /** Spender / operator receiving a permission. */
  spender?: string;
  /** Amount in the token's atomic units (decimal string). */
  amount?: string;
  /** Allowance/permit is effectively unlimited. */
  unlimited?: boolean;
  /** Unix seconds after which a permit/authorization expires, when present. */
  deadline?: number;
}

const ERC_ABI = new Interface([
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
  'function increaseAllowance(address spender, uint256 addedValue)',
  'function setApprovalForAll(address operator, bool approved)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
  'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
  'function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)',
]);

const PERMIT2_ABI = new Interface([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

/** Canonical Permit2 deployment (same address on every chain). */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

/** Amounts at or above this are treated as "unlimited" (MaxUint256, MaxUint160 …). */
const UNLIMITED_THRESHOLD = 2n ** 128n;

function isUnlimited(amount: bigint): boolean {
  return amount >= UNLIMITED_THRESHOLD;
}

function checksum(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return getAddress(value);
  } catch {
    return undefined;
  }
}

function bigintOf(value: unknown): bigint | undefined {
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
    if (typeof value === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(value.trim())) return BigInt(value.trim());
  } catch {
    return undefined;
  }
  return undefined;
}

function tryDecode(iface: Interface, data: string): ReturnType<Interface['parseTransaction']> {
  try {
    return iface.parseTransaction({ data });
  } catch {
    return null;
  }
}

/**
 * Classify a transaction by its calldata.
 *
 * @param tx - `to` (contract or recipient), `value` in wei, `data` calldata.
 * @returns the decoded intent; unknown calldata is `contract-call`.
 */
export function classifyTransaction(tx: { to?: string; value?: string | bigint; data?: string }): Intent {
  const data = (tx.data ?? '0x').trim();
  const to = checksum(tx.to);
  if (data === '0x' || data === '') {
    return { kind: 'native-transfer', ...(to !== undefined ? { recipient: to } : {}), amount: BigInt(tx.value ?? 0).toString() };
  }

  if (to !== undefined && to === PERMIT2_ADDRESS) {
    const parsed = tryDecode(PERMIT2_ABI, data);
    if (parsed !== null && parsed.name === 'approve') {
      const amount = BigInt(parsed.args[2] as bigint);
      const token = checksum(parsed.args[0]);
      const spender = checksum(parsed.args[1]);
      if (amount === 0n) return { kind: 'token-revoke', method: 'Permit2.approve', token, spender, amount: '0' };
      return {
        kind: 'token-approve',
        method: 'Permit2.approve',
        token,
        spender,
        amount: amount.toString(),
        ...(amount >= 2n ** 159n ? { unlimited: true } : {}),
        deadline: Number(parsed.args[3] as bigint),
      };
    }
  }

  const parsed = tryDecode(ERC_ABI, data);
  if (parsed === null) return { kind: 'contract-call' };
  const args = parsed.args;
  switch (parsed.name) {
    case 'transfer':
      return { kind: 'token-transfer', method: 'transfer', token: to, recipient: checksum(args[0]), amount: (args[1] as bigint).toString() };
    case 'transferFrom':
      return { kind: 'token-transfer', method: 'transferFrom', token: to, recipient: checksum(args[1]), amount: (args[2] as bigint).toString() };
    case 'approve':
    case 'increaseAllowance': {
      const amount = args[1] as bigint;
      if (parsed.name === 'approve' && amount === 0n) {
        return { kind: 'token-revoke', method: 'approve', token: to, spender: checksum(args[0]), amount: '0' };
      }
      return {
        kind: 'token-approve',
        method: parsed.name,
        token: to,
        spender: checksum(args[0]),
        amount: amount.toString(),
        ...(isUnlimited(amount) ? { unlimited: true } : {}),
      };
    }
    case 'setApprovalForAll':
      return args[1] === true
        ? { kind: 'nft-approval', method: 'setApprovalForAll', token: to, spender: checksum(args[0]), unlimited: true }
        : { kind: 'token-revoke', method: 'setApprovalForAll', token: to, spender: checksum(args[0]) };
    case 'safeTransferFrom':
    case 'safeBatchTransferFrom':
      return { kind: 'nft-transfer', method: parsed.name, token: to, recipient: checksum(args[1]) };
    default:
      return { kind: 'contract-call' };
  }
}

/** Typed-data payload as signers receive it. */
export interface TypedDataInput {
  domain: { chainId?: unknown; verifyingContract?: unknown; name?: unknown };
  types: Record<string, Array<TypedDataField>>;
  value: Record<string, unknown>;
}

function primaryTypeOf(types: Record<string, Array<TypedDataField>>): string | undefined {
  const withoutDomain = Object.fromEntries(Object.entries(types).filter(([name]) => name !== 'EIP712Domain'));
  try {
    return TypedDataEncoder.getPrimaryType(withoutDomain);
  } catch {
    return undefined;
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * Classify an EIP-712 payload by its primary type.
 *
 * @returns the decoded intent; unknown shapes are `typed-data`.
 */
export function classifyTypedData(input: TypedDataInput): Intent {
  const primary = primaryTypeOf(input.types);
  const verifying = checksum(input.domain.verifyingContract);
  const message = input.value ?? {};
  const deadlineOf = (raw: unknown): number | undefined => {
    const n = bigintOf(raw);
    return n === undefined ? undefined : Number(n);
  };

  switch (primary) {
    case 'Permit': {
      // EIP-2612: owner, spender, value, nonce, deadline. DAI: holder, spender, nonce, expiry, allowed.
      if ('allowed' in message) {
        const allowed = message.allowed === true || message.allowed === 'true';
        return allowed
          ? { kind: 'permit', method: 'Permit(DAI)', token: verifying, spender: checksum(message.spender), unlimited: true, deadline: deadlineOf(message.expiry) }
          : { kind: 'token-revoke', method: 'Permit(DAI)', token: verifying, spender: checksum(message.spender) };
      }
      const amount = bigintOf(message.value);
      return {
        kind: 'permit',
        method: 'Permit',
        token: verifying,
        spender: checksum(message.spender),
        ...(amount !== undefined ? { amount: amount.toString(), ...(isUnlimited(amount) ? { unlimited: true } : {}) } : { unlimited: true }),
        deadline: deadlineOf(message.deadline),
      };
    }
    case 'PermitSingle': {
      const details = recordOf(message.details);
      const amount = bigintOf(details.amount);
      return {
        kind: 'permit',
        method: 'Permit2.PermitSingle',
        token: checksum(details.token),
        spender: checksum(message.spender),
        ...(amount !== undefined ? { amount: amount.toString(), ...(amount >= 2n ** 159n ? { unlimited: true } : {}) } : { unlimited: true }),
        deadline: deadlineOf(message.sigDeadline),
      };
    }
    case 'PermitBatch':
      // Several tokens at once: never summarize to a single amount.
      return { kind: 'permit', method: 'Permit2.PermitBatch', spender: checksum(message.spender), unlimited: true, deadline: deadlineOf(message.sigDeadline) };
    case 'PermitTransferFrom':
    case 'PermitWitnessTransferFrom': {
      const permitted = recordOf(message.permitted);
      const amount = bigintOf(permitted.amount);
      return {
        kind: 'permit-transfer',
        method: `Permit2.${primary}`,
        token: checksum(permitted.token),
        spender: checksum(message.spender),
        ...(amount !== undefined ? { amount: amount.toString() } : { unlimited: true }),
        deadline: deadlineOf(message.deadline),
      };
    }
    case 'PermitBatchTransferFrom':
    case 'PermitBatchWitnessTransferFrom':
      return { kind: 'permit-transfer', method: `Permit2.${primary}`, spender: checksum(message.spender), unlimited: true, deadline: deadlineOf(message.deadline) };
    case 'TransferWithAuthorization':
    case 'ReceiveWithAuthorization': {
      const amount = bigintOf(message.value);
      return {
        kind: 'transfer-authorization',
        method: primary,
        token: verifying,
        recipient: checksum(message.to),
        ...(amount !== undefined ? { amount: amount.toString() } : { unlimited: true }),
        deadline: deadlineOf(message.validBefore),
      };
    }
    case 'OrderComponents':
    case 'Order':
    case 'BulkOrder':
      return { kind: 'order', method: primary, ...(verifying !== undefined ? { spender: verifying } : {}) };
    default:
      return { kind: 'typed-data', ...(primary !== undefined ? { method: primary } : {}) };
  }
}

/** Parse the serialized typed data carried by a policy request, when possible. */
export function classifySerializedTypedData(serialized: string | undefined): Intent | undefined {
  if (serialized === undefined) return undefined;
  try {
    const parsed = JSON.parse(serialized) as Partial<TypedDataInput>;
    if (parsed.types === undefined || parsed.value === undefined) return undefined;
    return classifyTypedData({ domain: parsed.domain ?? {}, types: parsed.types, value: parsed.value });
  } catch {
    return undefined;
  }
}

/** Encode `transfer(to, amount)` calldata for an ERC-20 token. */
export function encodeErc20Transfer(to: string, amount: bigint): string {
  return ERC_ABI.encodeFunctionData('transfer', [getAddress(to), amount]);
}

/** Encode `approve(spender, amount)` calldata for an ERC-20 token. */
export function encodeErc20Approve(spender: string, amount: bigint): string {
  return ERC_ABI.encodeFunctionData('approve', [getAddress(spender), amount]);
}

const ERC20_READ = new Interface([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function version() view returns (string)',
]);

/** Encode an ERC-20 read call (`allowance`, `balanceOf`, `decimals`, `symbol`, `name`, `version`). */
export function encodeErc20Read(fn: 'allowance' | 'balanceOf' | 'decimals' | 'symbol' | 'name' | 'version', args: unknown[] = []): string {
  return ERC20_READ.encodeFunctionData(fn, args);
}

/** Decode an ERC-20 read result; undefined when the node returned nothing usable. */
export function decodeErc20Read(fn: 'allowance' | 'balanceOf' | 'decimals' | 'symbol' | 'name' | 'version', raw: string): unknown {
  if (raw === '0x' || raw === '') return undefined;
  try {
    return ERC20_READ.decodeFunctionResult(fn, raw)[0];
  } catch {
    return undefined;
  }
}
