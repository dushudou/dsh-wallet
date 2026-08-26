/**
 * Chain provider abstraction: everything the wallet needs from an EVM node.
 *
 * The interface exists so the signing path can be tested (and dry-run)
 * against an in-memory mock with zero network. `JsonRpcChainProvider` is the
 * production implementation built on ethers' JsonRpcProvider.
 *
 * @module dsh-web3-core/provider
 */

import { FetchRequest, JsonRpcProvider, Network, formatEther, type Provider, type TransactionLike } from 'ethers';
import { getChain, type ChainInfo } from './chains.js';

/** EIP-1559 / legacy fee information. */
export interface FeeData {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
}

/** Minimal transaction receipt. */
export interface TxReceipt {
  hash: string;
  status: 'success' | 'reverted' | 'pending';
  blockNumber: number | null;
  gasUsed: bigint;
  effectiveGasPrice?: bigint;
}

/** The provider surface the wallet core consumes. */
export interface ChainProvider {
  readonly chainId: number;
  getChainId(): Promise<number>;
  getBalance(address: string): Promise<bigint>;
  getNonce(address: string): Promise<number>;
  getCode(address: string): Promise<string>;
  call(transaction: { to: string; data: string; from?: string }): Promise<string>;
  estimateGas(transaction: { to: string; data?: string; from?: string; value?: bigint }): Promise<bigint>;
  getFeeData(): Promise<FeeData>;
  broadcastRawTransaction(rawTransaction: string): Promise<string>;
  getTransactionReceipt(hash: string): Promise<TxReceipt | null>;
  waitForTransaction(hash: string, timeoutMs?: number): Promise<TxReceipt>;
  /** Underlying ethers provider, when one exists (exposed for advanced use). */
  readonly ethersProvider?: Provider;
}

const RECEIPT_TIMEOUT_DEFAULT_MS = 120_000;

/** Probe one JSON-RPC URL with `eth_chainId` and validate the response body. */
async function probeRpc(url: string, timeoutMs: number): Promise<boolean> {
  const request = new FetchRequest(url);
  request.body = JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 });
  const timer = new Promise<'__dshw-timeout__'>((resolve) => {
    const handle = setTimeout(() => resolve('__dshw-timeout__'), timeoutMs);
    handle.unref?.();
  });
  try {
    const response = await Promise.race([request.send(), timer]);
    if (response === '__dshw-timeout__') return false;
    // A 200 can still carry a JSON-RPC error (e.g. rate-limit/auth bodies),
    // so accept only a well-formed result with no error member.
    const body = response.bodyText ?? '';
    return body.includes('"result"') && !body.includes('"error"');
  } catch {
    return false;
  }
}

/**
 * Pick the first reachable JSON-RPC URL from a candidate list.
 *
 * Public free endpoints come and go (and some return 200 with an error body),
 * so the wallet prefers a live endpoint and falls back to the first candidate
 * when all fail — callers then surface the node error as usual.
 */
export async function pickReachableRpc(urls: readonly string[], timeoutMs = 2500): Promise<string> {
  for (const url of urls) {
    if (url === undefined || url.length === 0) continue;
    if (await probeRpc(url, timeoutMs)) return url;
  }
  return urls[0] ?? '';
}

/** Production provider backed by a JSON-RPC endpoint. */
export class JsonRpcChainProvider implements ChainProvider {
  readonly chainId: number;
  readonly ethersProvider: JsonRpcProvider;

  constructor(
    chainId: number,
    rpcUrl: string,
    options: { headers?: Record<string, string> } = {},
  ) {
    this.chainId = chainId;
    const fetchRequest = new FetchRequest(rpcUrl);
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      fetchRequest.setHeader(key, value);
    }
    // staticNetwork avoids the provider's chainId-detection round trip.
    this.ethersProvider = new JsonRpcProvider(fetchRequest, Network.from(chainId), {
      staticNetwork: Network.from(chainId),
      batchMaxCount: 1,
    });
  }

  static fromChain(chain: ChainInfo, rpcUrl?: string): JsonRpcChainProvider {
    const url = rpcUrl ?? chain.rpc[0];
    if (url === undefined) throw new Error(`chain ${String(chain.chainId)} has no rpc url configured`);
    return new JsonRpcChainProvider(chain.chainId, url);
  }

  /** Create a provider for a chain id, resolving custom RPC urls first. */
  static forChainId(chainId: number, customRpc?: string): JsonRpcChainProvider {
    const chain = getChain(chainId);
    if (chain === undefined && customRpc === undefined) {
      throw new Error(`unknown chain ${String(chainId)}: pass an rpc url or add it to the chain registry`);
    }
    return new JsonRpcChainProvider(chainId, customRpc ?? chain!.rpc[0]!);
  }

  async getChainId(): Promise<number> {
    return await this.ethersProvider.send('eth_chainId', []);
  }

  async getBalance(address: string): Promise<bigint> {
    return await this.ethersProvider.getBalance(address);
  }

  async getNonce(address: string): Promise<number> {
    return await this.ethersProvider.getTransactionCount(address, 'pending');
  }

  async getCode(address: string): Promise<string> {
    return await this.ethersProvider.getCode(address);
  }

  async call(transaction: { to: string; data: string; from?: string }): Promise<string> {
    return await this.ethersProvider.call({
      to: transaction.to,
      data: transaction.data,
      ...(transaction.from !== undefined ? { from: transaction.from } : {}),
    });
  }

  async estimateGas(transaction: {
    to: string;
    data?: string;
    from?: string;
    value?: bigint;
  }): Promise<bigint> {
    return await this.ethersProvider.estimateGas({
      to: transaction.to,
      ...(transaction.data !== undefined ? { data: transaction.data } : {}),
      ...(transaction.from !== undefined ? { from: transaction.from } : {}),
      ...(transaction.value !== undefined && transaction.value > 0n ? { value: transaction.value } : {}),
    });
  }

  async getFeeData(): Promise<FeeData> {
    const fee = await this.ethersProvider.getFeeData();
    return {
      ...(fee.maxFeePerGas !== null && fee.maxFeePerGas !== undefined ? { maxFeePerGas: fee.maxFeePerGas } : {}),
      ...(fee.maxPriorityFeePerGas !== null && fee.maxPriorityFeePerGas !== undefined
        ? { maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
        : {}),
      ...(fee.gasPrice !== null && fee.gasPrice !== undefined ? { gasPrice: fee.gasPrice } : {}),
    };
  }

  async broadcastRawTransaction(rawTransaction: string): Promise<string> {
    // send() returns the tx hash directly; broadcastTransaction would
    // resolve a full TransactionResponse we do not need here.
    return (await this.ethersProvider.send('eth_sendRawTransaction', [rawTransaction])) as string;
  }

  async getTransactionReceipt(hash: string): Promise<TxReceipt | null> {
    const receipt = await this.ethersProvider.getTransactionReceipt(hash);
    if (receipt === null) return null;
    return toReceipt(receipt);
  }

  async waitForTransaction(hash: string, timeoutMs = RECEIPT_TIMEOUT_DEFAULT_MS): Promise<TxReceipt> {
    const receipt = await this.ethersProvider.waitForTransaction(hash, 1, timeoutMs);
    if (receipt === null) throw new Error(`transaction ${hash} not mined within ${String(timeoutMs)} ms`);
    return toReceipt(receipt);
  }
}

function toReceipt(receipt: {
  hash: string;
  status?: number | null;
  blockNumber: number | null;
  gasUsed: bigint;
  gasPrice?: bigint;
}): TxReceipt {
  return {
    hash: receipt.hash,
    status: receipt.status === 1 ? 'success' : receipt.status === 0 ? 'reverted' : 'pending',
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    ...(receipt.gasPrice !== undefined ? { effectiveGasPrice: receipt.gasPrice } : {}),
  };
}

/** Format wei into a human-friendly native-unit string. */
export function formatNative(wei: bigint | string, decimals = 18): string {
  return formatEther(BigInt(wei));
}

/** One ERC-20 token known for a chain (address + metadata). */
export interface TokenSpec {
  address: string;
  symbol?: string;
  decimals?: number;
}

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
] as const;

/** Read one ERC-20 balance (and metadata when the spec lacks it). */
export async function tokenBalance(
  provider: ChainProvider,
  holder: string,
  token: TokenSpec,
): Promise<{ address: string; balance: bigint; symbol?: string; decimals?: number; formatted?: string }> {
  const { Interface } = await import('ethers');
  const iface = new Interface(ERC20_ABI);
  const callData = (fn: string, arg: string) => iface.encodeFunctionData(fn, [arg]);
  const [balanceRaw, symbolRaw, decimalsRaw] = await Promise.all([
    provider.call({ to: token.address, data: callData('balanceOf', holder) }),
    token.symbol === undefined
      ? provider.call({ to: token.address, data: iface.encodeFunctionData('symbol', []) }).catch(() => undefined)
      : Promise.resolve(undefined),
    token.decimals === undefined
      ? provider.call({ to: token.address, data: iface.encodeFunctionData('decimals', []) }).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);
  const balance = BigInt(balanceRaw === '0x' ? 0 : BigInt(balanceRaw));
  let symbol = token.symbol;
  if (symbol === undefined && symbolRaw !== undefined) {
    try {
      symbol = iface.decodeFunctionResult('symbol', symbolRaw)[0] as string;
    } catch {
      symbol = undefined;
    }
  }
  let decimals = token.decimals;
  if (decimals === undefined && decimalsRaw !== undefined) {
    try {
      decimals = Number(iface.decodeFunctionResult('decimals', decimalsRaw)[0] as bigint);
    } catch {
      decimals = undefined;
    }
  }
  const formatted =
    decimals !== undefined && decimals <= 36 ? (Number(balance) / 10 ** decimals).toFixed(6) : undefined;
  return { address: token.address, balance, ...(symbol !== undefined ? { symbol } : {}), ...(decimals !== undefined ? { decimals } : {}), ...(formatted !== undefined ? { formatted } : {}) };
}

/** Native + token balances for one address. */
export async function accountBalances(
  provider: ChainProvider,
  address: string,
  tokens: TokenSpec[] = [],
): Promise<{ native: { balanceWei: string; formatted: string }; tokens: Awaited<ReturnType<typeof tokenBalance>>[] }> {
  const native = await provider.getBalance(address);
  const tokenResults = await Promise.all(
    tokens.map(async (token) => await tokenBalance(provider, address, token).catch(() => undefined)),
  );
  return {
    native: { balanceWei: native.toString(), formatted: formatEther(native) },
    tokens: tokenResults.filter((entry): entry is Awaited<ReturnType<typeof tokenBalance>> => entry !== undefined),
  };
}
