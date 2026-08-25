import { describe, expect, it } from 'vitest';
import type { ChainProvider, FeeData, TxReceipt } from 'dsh-web3-core';

/** In-memory ChainProvider for plugin tests: no network, canned values. */
export class MockChainProvider implements ChainProvider {
  readonly chainId: number;
  balances = new Map<string, bigint>();
  nonces = new Map<string, number>();
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
    return this.balances.get(address.toLowerCase()) ?? 1_000_000_000_000_000_000n;
  }

  async getNonce(address: string): Promise<number> {
    return this.nonces.get(address.toLowerCase()) ?? 0;
  }

  async getCode(): Promise<string> {
    return '0x';
  }

  async call(): Promise<string> {
    return '0x';
  }

  async estimateGas(): Promise<bigint> {
    return this.gasEstimate;
  }

  async getFeeData(): Promise<FeeData> {
    return this.feeData;
  }

  async broadcastRawTransaction(rawTransaction: string): Promise<string> {
    this.broadcasted.push(rawTransaction);
    const seed = rawTransaction.slice(2, 66).padEnd(64, '0');
    return `0x${seed}`;
  }

  async getTransactionReceipt(): Promise<TxReceipt | null> {
    return null;
  }

  async waitForTransaction(): Promise<TxReceipt> {
    throw new Error('mock provider does not mine');
  }
}

/** Approval stub recording every request and answering with a set outcome. */
export class ApprovalStub {
  outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' = 'allowed-once';
  requests: Array<{ toolName: string; reason: string }> = [];

  request = async (input: { toolName: string; reason: string }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'> => {
    this.requests.push({ toolName: input.toolName, reason: input.reason });
    return this.outcome;
  };
}
