import { SimulationUnsupportedError, type ChainProvider, type FeeData, type SimulationResult, type TxReceipt } from 'dsh-web3-core';

/** In-memory ChainProvider for plugin tests: no network, canned values. */
export class MockChainProvider implements ChainProvider {
  readonly chainId: number;
  balances = new Map<string, bigint>();
  nonces = new Map<string, number>();
  /** Contract code by lower-cased address (default: EOA, `0x`). */
  codes = new Map<string, string>();
  /** `eth_call` results keyed by `${to.toLowerCase()}:${data}`. */
  calls = new Map<string, string>();
  /** ENS name -> address. */
  names = new Map<string, string>();
  /** Receipts by lower-cased hash. */
  receipts = new Map<string, TxReceipt>();
  feeData: FeeData = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
  gasEstimate = 21_000n;
  /** When set, estimateGas rejects with this error (simulates a revert). */
  estimateError: Error | undefined;
  /** When set, the next broadcast rejects with this error. */
  broadcastError: Error | undefined;
  broadcasted: string[] = [];
  /**
   * `eth_simulateV1` answer: a canned result, a function of the call, or an
   * error to throw. Undefined = the RPC does not support simulation.
   */
  simulation: SimulationResult | Error | ((call: { from: string; to: string; value: bigint; data: string }) => SimulationResult) | undefined;
  /** Every simulated call, in order. */
  simulated: Array<{ from: string; to: string; value: bigint; data: string }> = [];

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

  async getCode(address: string): Promise<string> {
    return this.codes.get(address.toLowerCase()) ?? '0x';
  }

  async call(transaction: { to: string; data: string }): Promise<string> {
    return this.calls.get(`${transaction.to.toLowerCase()}:${transaction.data}`) ?? '0x';
  }

  async estimateGas(): Promise<bigint> {
    if (this.estimateError !== undefined) throw this.estimateError;
    return this.gasEstimate;
  }

  async getFeeData(): Promise<FeeData> {
    return this.feeData;
  }

  async simulate(call: { from: string; to: string; value: bigint; data: string }): Promise<SimulationResult> {
    this.simulated.push(call);
    const answer = this.simulation;
    if (answer === undefined) throw new SimulationUnsupportedError();
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(call) : answer;
  }

  async resolveName(name: string): Promise<string | null> {
    return this.names.get(name.toLowerCase()) ?? null;
  }

  async broadcastRawTransaction(rawTransaction: string): Promise<string> {
    if (this.broadcastError !== undefined) {
      const error = this.broadcastError;
      this.broadcastError = undefined;
      throw error;
    }
    this.broadcasted.push(rawTransaction);
    const { Transaction } = await import('ethers');
    return Transaction.from(rawTransaction).hash!;
  }

  async getTransactionReceipt(hash: string): Promise<TxReceipt | null> {
    return this.receipts.get(hash.toLowerCase()) ?? null;
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
