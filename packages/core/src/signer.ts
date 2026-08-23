/**
 * Signing operations: EIP-1559 transactions, EIP-191 personal messages, and
 * EIP-712 typed data. Signing is deliberately split from broadcasting so the
 * policy engine (and the human approval it may request) runs on a fully
 * populated, human-readable transaction before any key is touched.
 *
 * @module @dsh-wallet/core/signer
 */

import {
  Transaction,
  Wallet,
  formatEther,
  getAddress,
  verifyMessage,
  verifyTypedData,
  type TypedDataDomain,
  type TypedDataField,
} from 'ethers';
import type { ChainProvider } from './provider.js';
import { selectorOfData } from './policy/evaluate.js';

/** A transaction request as callers specify it; missing fields are filled. */
export interface TransactionRequestInput {
  from: string;
  chainId: number;
  to: string;
  /** Value in wei (decimal string or bigint). */
  value?: string | bigint;
  /** Calldata, 0x-hex. */
  data?: string;
  nonce?: number;
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
  /** Force legacy (type 0) instead of EIP-1559 (type 2). */
  type?: 0 | 2;
}

/** A fully populated transaction ready to sign - no unknowns left. */
export interface PopulatedTransaction {
  type: 0 | 2;
  chainId: number;
  from: string;
  to: string;
  nonce: number;
  gasLimit: bigint;
  value: bigint;
  data: string;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
}

/** Human-readable view of a transaction for approvals, logs, and the UI. */
export interface HumanTransaction {
  type: 0 | 2;
  chainId: number;
  from: string;
  to: string;
  nonce: number;
  valueWei: string;
  valueNative: string;
  dataLengthBytes: number;
  selector?: string;
  gasLimit: string;
  maxFeePerGasGwei?: string;
  gasPriceGwei?: string;
}

/** A signed transaction plus its hash. */
export interface SignedTransaction {
  raw: string;
  hash: string;
  transaction: HumanTransaction;
}

const GAS_LIMIT_DEFAULT = 21_000n;
const GAS_LIMIT_BUFFER = 30_000n;

/** Fill in nonce, gas, and fees; throws when the chain data is unusable. */
export async function populateTransaction(
  request: TransactionRequestInput,
  provider: ChainProvider,
): Promise<PopulatedTransaction> {
  const to = getAddress(request.to);
  const value = request.value === undefined ? 0n : BigInt(request.value);
  const data = request.data ?? '0x';
  if (!data.startsWith('0x')) throw new Error('transaction data must be 0x-prefixed hex');

  const [nonce, feeData] = await Promise.all([
    request.nonce !== undefined ? Promise.resolve(request.nonce) : provider.getNonce(request.from),
    provider.getFeeData(),
  ]);

  let gasLimit: bigint;
  if (request.gasLimit !== undefined) {
    gasLimit = request.gasLimit;
  } else {
    try {
      const estimated = await provider.estimateGas({ to, ...(value > 0n ? { value } : {}), ...(data !== '0x' ? { data } : {}), from: request.from });
      gasLimit = estimated + GAS_LIMIT_BUFFER;
    } catch {
      // Estimation failure (e.g. contract revert) still lets a plain transfer through.
      gasLimit = data === '0x' ? GAS_LIMIT_DEFAULT : 200_000n;
    }
  }

  const eip1559 = request.type !== 0 && feeData.maxFeePerGas !== undefined;
  if (eip1559) {
    return {
      type: 2,
      chainId: request.chainId,
      from: getAddress(request.from),
      to,
      nonce,
      gasLimit,
      value,
      data,
      maxFeePerGas: request.maxFeePerGas ?? feeData.maxFeePerGas!,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas ?? feeData.maxPriorityFeePerGas ?? feeData.maxFeePerGas! / 10n,
    };
  }
  const gasPrice = request.gasPrice ?? feeData.gasPrice ?? feeData.maxFeePerGas;
  if (gasPrice === undefined) throw new Error('chain provided neither gas price nor EIP-1559 fees');
  return {
    type: 0,
    chainId: request.chainId,
    from: getAddress(request.from),
    to,
    nonce,
    gasLimit,
    value,
    data,
    gasPrice,
  };
}

/** Build the human-readable view (safe for logs - contains no secrets). */
export function describeTransaction(tx: PopulatedTransaction): HumanTransaction {
  return {
    type: tx.type,
    chainId: tx.chainId,
    from: tx.from,
    to: tx.to,
    nonce: tx.nonce,
    valueWei: tx.value.toString(),
    valueNative: formatEther(tx.value),
    dataLengthBytes: (tx.data.length - 2) / 2,
    ...(tx.data.length >= 10 ? { selector: selectorOfData(tx.data) } : {}),
    gasLimit: tx.gasLimit.toString(),
    ...(tx.maxFeePerGas !== undefined ? { maxFeePerGasGwei: (Number(tx.maxFeePerGas) / 1e9).toFixed(4) } : {}),
    ...(tx.gasPrice !== undefined ? { gasPriceGwei: (Number(tx.gasPrice) / 1e9).toFixed(4) } : {}),
  };
}

/** Sign a populated transaction with an unlocked wallet. */
export async function signTransaction(wallet: Wallet, tx: PopulatedTransaction): Promise<SignedTransaction> {
  const like: Record<string, unknown> = {
    type: tx.type,
    chainId: tx.chainId,
    nonce: tx.nonce,
    gasLimit: tx.gasLimit,
    to: tx.to,
    value: tx.value,
    data: tx.data,
  };
  if (tx.type === 2) {
    like.maxFeePerGas = tx.maxFeePerGas;
    like.maxPriorityFeePerGas = tx.maxPriorityFeePerGas;
  } else if (tx.gasPrice !== undefined) {
    like.gasPrice = tx.gasPrice;
  }
  const raw = await wallet.signTransaction(like as Parameters<Wallet['signTransaction']>[0]);
  const hash = Transaction.from(raw).hash ?? wallet.address; // hash is always set post-sign
  return { raw, hash: hash as string, transaction: describeTransaction(tx) };
}

/** Sign an EIP-191 personal message. */
export async function signMessage(wallet: Wallet, message: string): Promise<{ signature: string; address: string }> {
  const signature = await wallet.signMessage(message);
  return { signature, address: wallet.address };
}

/** EIP-712 types: name/type pairs grouped by struct name. */
export type Eip712Types = Record<string, Array<TypedDataField>>;

/** Sign EIP-712 typed data. */
export async function signTypedData(
  wallet: Wallet,
  domain: TypedDataDomain,
  types: Eip712Types,
  value: Record<string, unknown>,
): Promise<{ signature: string; address: string }> {
  const signature = await wallet.signTypedData(domain, types, value);
  return { signature, address: wallet.address };
}

/** Verify an EIP-191 signature (returns the recovered address). */
export function verifyEip191(message: string, signature: string): string {
  return verifyMessage(message, signature);
}

/** Verify an EIP-712 signature (returns the recovered address). */
export function verifyEip712(
  domain: TypedDataDomain,
  types: Eip712Types,
  value: Record<string, unknown>,
  signature: string,
): string {
  return verifyTypedData(domain, types, value, signature);
}
