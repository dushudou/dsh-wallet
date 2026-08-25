import type { ChainProvider, FeeData, TxReceipt } from '../src/provider.js';

/** In-memory ChainProvider for tests: no network, canned values. */
export class MockChainProvider implements ChainProvider {
  readonly chainId: number;
  balances = new Map<string, bigint>();
  nonces = new Map<string, number>();
  codes = new Map<string, string>();
  calls = new Map<string, string>();
  feeData: FeeData = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
  gasEstimate = 21_000n;
  broadcasted: string[] = [];

  constructor(chainId = 31337) {
    this.chainId = chainId;
  }

  async getChainId(): Promise<number> {
    return this.chainId;
  }

  async getBalance(address: string): Promise<bigint> {
    return this.balances.get(address.toLowerCase()) ?? 0n;
  }

  async getNonce(address: string): Promise<number> {
    return this.nonces.get(address.toLowerCase()) ?? 0;
  }

  async getCode(address: string): Promise<string> {
    return this.codes.get(address.toLowerCase()) ?? '0x';
  }

  async call(transaction: { to: string; data: string }): Promise<string> {
    return this.calls.get(`${transaction.to.toLowerCase()}:${transaction.data}`) ?? '0x';
  }

  async estimateGas(): Promise<bigint> {
    return this.gasEstimate;
  }

  async getFeeData(): Promise<FeeData> {
    return this.feeData;
  }

  async broadcastRawTransaction(rawTransaction: string): Promise<string> {
    this.broadcasted.push(rawTransaction);
    return `0x${(this.broadcasted.length.toString(16) + rawTransaction.slice(-62)).padStart(64, '0').slice(0, 64)}`;
  }

  async getTransactionReceipt(): Promise<TxReceipt | null> {
    return null;
  }

  async waitForTransaction(): Promise<TxReceipt> {
    throw new Error('mock provider does not mine');
  }
}
