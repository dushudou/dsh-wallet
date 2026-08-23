/**
 * The `wallet` service (`ctx.wallet`): the full programmatic API other
 * plugins and the model tools share. Tools add approval gating; the service
 * itself is the honest surface.
 *
 * @module @dsh-wallet/plugin/service
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TypedDataDomain, TypedDataField } from 'ethers';
import {
  JsonRpcChainProvider,
  WalletVault,
  accountBalances,
  explorerUrl,
  formatNative,
  getChain,
  populateTransaction,
  signMessage as coreSignMessage,
  signTransaction as coreSignTransaction,
  signTypedData as coreSignTypedData,
  describeTransaction,
  assertNoSecrets,
  type AccountMeta,
  type ChainProvider,
  type PolicyDecision,
  type PolicyRequest,
  type SigningPolicy,
  type TokenSpec,
  type TransactionRequestInput,
} from '@dsh-wallet/core';

/** The approval seam tools route `ask` decisions through. */
export interface ApprovalGateway {
  /** Request a one-shot human approval. Returns the outcome vocabulary. */
  request(input: { toolName: string; reason: string; callId?: string; signal?: AbortSignal }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>;
}

/** Where a resolved provider came from, for diagnostics. */
export interface ResolvedProvider {
  provider: ChainProvider;
  chainId: number;
  rpcUrl: string;
  custom: boolean;
}

/** What `sendTransaction` did and produced. */
export interface SendResult {
  status: 'signed-broadcast' | 'awaiting-approval-rejected' | 'denied-by-policy' | 'unavailable-approver';
  decision: PolicyDecision;
  approvalOutcome?: string;
  txHash?: string;
  human?: ReturnType<typeof describeTransaction>;
  explorerUrl?: string;
  raw?: string;
}

/** What message signing did and produced. */
export interface SignMessageResult {
  status: 'signed' | 'awaiting-approval-rejected' | 'denied-by-policy' | 'unavailable-approver';
  decision: PolicyDecision;
  approvalOutcome?: string;
  signature?: string;
  address: string;
}

export interface WalletServiceOptions {
  vaultPath: string;
  autoLockMs?: number;
  passphraseMode: 'auto' | 'env' | 'manual';
  env: Record<string, string | undefined>;
  credentials?: {
    resolve(ref: string): Promise<{ value?: string } | undefined>;
    set(ref: string, value: string): Promise<void>;
  };
  rpcOverrides: Record<string, string>;
  tokens: Record<string, TokenSpec[]>;
  /** Provider factory override (tests inject an in-memory provider). */
  createProvider?: (chainId: number, rpcUrl?: string) => ChainProvider;
}

/** Default vault location: `$DSH_HOME/wallet` or `~/.dsh/wallet`. */
export function defaultVaultPath(): string {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return resolve(join(dshHome, 'wallet'));
}

/** The wallet service mounted as `ctx.wallet`. */
export class WalletService {
  readonly vault: WalletVault;
  private readonly options: WalletServiceOptions;
  private providers = new Map<number, ChainProvider>();

  constructor(vault: WalletVault, options: WalletServiceOptions) {
    this.vault = vault;
    this.options = options;
  }

  // ── vault ───────────────────────────────────────────────────────────────

  /** Vault status snapshot. */
  status(): ReturnType<WalletVault['status']> {
    this.vault.maybeAutoLock();
    return this.vault.status();
  }

  /** List accounts (metadata only). */
  listAccounts(): AccountMeta[] {
    return this.vault.listAccounts();
  }

  /** Unlock the vault using the passphrase resolution chain. */
  async unlock(passphraseFile?: string): Promise<{ source: string }> {
    const { resolvePassphrase, passphraseFromFile } = await import('./passphrase.js');
    let passphrase: string;
    let source: string;
    if (passphraseFile !== undefined) {
      passphrase = await passphraseFromFile(passphraseFile);
      source = 'file';
    } else {
      const resolved = await resolvePassphrase(this.options.passphraseMode, this.options.env, this.options.credentials);
      passphrase = resolved.passphrase;
      source = resolved.source;
    }
    await this.vault.unlock(passphrase);
    await this.vault.auditAppend('vault.unlocked', { source });
    return { source };
  }

  /** Lock the vault (zeroize decrypted key material). */
  lock(): void {
    this.vault.lock();
  }

  /** Create a fresh HD account. The mnemonic is returned ONCE (never stored
   *  in plaintext, never logged); callers must gate display on approval. */
  async createAccount(input: { label?: string; words?: 12 | 15 | 18 | 21 | 24 } = {}): Promise<{ meta: AccountMeta; mnemonic: string }> {
    const passphrase = await this.effectivePassphrase();
    const result = await this.vault.createAccount(input, passphrase);
    if (!this.vault.unlocked) await this.vault.unlock(passphrase);
    return result;
  }

  /** Import an account from secret material held in a file (never tool args). */
  async importAccount(input: {
    source: 'mnemonic' | 'privateKey' | 'keystore';
    secretFile: string;
    keystorePassphraseFile?: string;
    label?: string;
    index?: number;
  }): Promise<{ meta: AccountMeta }> {
    const { readSecretFile } = await import('./secretFile.js');
    const passphrase = await this.effectivePassphrase();
    const secret = await readSecretFile(input.secretFile);
    let result: { meta: AccountMeta };
    if (input.source === 'mnemonic') {
      result = await this.vault.importMnemonic(
        { mnemonic: secret, label: input.label, index: input.index },
        passphrase,
      );
    } else if (input.source === 'privateKey') {
      result = await this.vault.importPrivateKey({ privateKey: secret, label: input.label }, passphrase);
    } else {
      if (input.keystorePassphraseFile === undefined) {
        throw new Error('keystore import requires keystorePassphraseFile');
      }
      const keystorePassphrase = await readSecretFile(input.keystorePassphraseFile);
      result = await this.vault.importKeystore(
        { keystoreJson: secret, keystorePassphrase, label: input.label },
        passphrase,
      );
    }
    if (!this.vault.unlocked) await this.vault.unlock(passphrase);
    return result;
  }

  /** The passphrase to use for new key material: the live one when unlocked,
   *  otherwise the resolution chain. Keeps every key file decryptable by the
   *  passphrase the vault currently holds. */
  private async effectivePassphrase(): Promise<string> {
    if (this.vault.unlocked) {
      const current = this.vault.currentPassphrase();
      if (current !== undefined) return current;
    }
    const { resolvePassphrase } = await import('./passphrase.js');
    const resolved = await resolvePassphrase(this.options.passphraseMode, this.options.env, this.options.credentials);
    return resolved.passphrase;
  }

  /** Remove an account after approval. */
  async removeAccount(accountId: string): Promise<AccountMeta> {
    return await this.vault.removeAccount(accountId);
  }

  // ── chain providers ─────────────────────────────────────────────────────

  /** Resolve a provider for a chain (cached). */
  providerFor(chainId: number): ResolvedProvider {
    const cached = this.providers.get(chainId);
    if (cached !== undefined) {
      return { provider: cached, chainId, rpcUrl: (cached as unknown as { __rpcUrl?: string }).__rpcUrl ?? '', custom: true };
    }
    const custom = this.options.rpcOverrides[String(chainId)];
    const chain = getChain(chainId);
    if (custom === undefined && chain === undefined && this.options.createProvider === undefined) {
      throw new Error(`unknown chain ${String(chainId)}: add an rpc override in the wallet plugin config`);
    }
    const rpcUrl = custom ?? chain?.rpc[0];
    const provider =
      this.options.createProvider !== undefined
        ? this.options.createProvider(chainId, rpcUrl)
        : JsonRpcChainProvider.forChainId(chainId, custom);
    (provider as unknown as { __rpcUrl?: string }).__rpcUrl = rpcUrl ?? '';
    this.providers.set(chainId, provider);
    return {
      provider,
      chainId,
      rpcUrl: rpcUrl ?? '',
      custom: custom !== undefined,
    };
  }

  /** Watch tokens configured for a chain (UI balances). */
  tokensFor(chainId: number): TokenSpec[] {
    return this.options.tokens[String(chainId)] ?? [];
  }

  /** Native + configured token balances for an account on a chain. */
  async balances(account: AccountMeta, chainId: number): Promise<{
    chainId: number;
    chainName?: string;
    native: { balanceWei: string; formatted: string };
    tokens: Array<{ address: string; symbol?: string; balance: string; formatted?: string }>;
  }> {
    this.vault.maybeAutoLock();
    const { provider } = this.providerFor(chainId);
    const result = await accountBalances(provider, account.address, this.tokensFor(chainId));
    const chain = getChain(chainId);
    return {
      chainId,
      ...(chain !== undefined ? { chainName: chain.name } : {}),
      native: { balanceWei: result.native.balanceWei, formatted: result.native.formatted },
      tokens: result.tokens.map((token) => ({
        address: token.address,
        ...(token.symbol !== undefined ? { symbol: token.symbol } : {}),
        balance: token.balance.toString(),
        ...(token.formatted !== undefined ? { formatted: token.formatted } : {}),
      })),
    };
  }

  // ── signing pipeline ────────────────────────────────────────────────────

  /** Build a request the policy engine understands. */
  policyRequestFor(input: TransactionRequestInput, populated?: unknown): PolicyRequest {
    void populated;
    return {
      type: 'signTransaction',
      account: { address: input.from },
      chainId: input.chainId,
      to: input.to,
      value: input.value !== undefined ? BigInt(input.value).toString() : '0',
      data: input.data,
    };
  }

  /** Dry-run: populate + evaluate policy. No key material touched. */
  async prepareTransaction(input: TransactionRequestInput): Promise<{
    human: ReturnType<typeof describeTransaction>;
    decision: PolicyDecision;
    chainName?: string;
  }> {
    this.vault.maybeAutoLock();
    const { provider } = this.providerFor(input.chainId);
    const populated = await populateTransaction(input, provider);
    const human = describeTransaction(populated);
    const decision = this.vault.evaluateSignPolicy({
      type: 'signTransaction',
      account: { address: input.from },
      chainId: input.chainId,
      to: populated.to,
      value: populated.value.toString(),
      data: populated.data,
      ...(human.selector !== undefined ? { selector: human.selector } : {}),
    });
    const chain = getChain(input.chainId);
    return { human, decision, ...(chain !== undefined ? { chainName: chain.name } : {}) };
  }

  /** Full flow: populate -> policy -> approval (when `ask`) -> sign -> broadcast. */
  async sendTransaction(
    input: TransactionRequestInput,
    approval: ApprovalGateway | undefined,
    context: { toolName: string; callId?: string; signal?: AbortSignal } = { toolName: 'wallet_send_transaction' },
  ): Promise<SendResult> {
    this.vault.maybeAutoLock();
    const meta = this.vault.requireAccount(input.from);
    const { provider } = this.providerFor(input.chainId);
    const populated = await populateTransaction({ ...input, from: meta.address }, provider);
    const human = describeTransaction(populated);
    const decision = this.vault.evaluateSignPolicy({
      type: 'signTransaction',
      account: { address: meta.address },
      chainId: input.chainId,
      to: populated.to,
      value: populated.value.toString(),
      data: populated.data,
      ...(human.selector !== undefined ? { selector: human.selector } : {}),
    });
    await this.vault.auditAppend('sign.decision', {
      type: 'signTransaction',
      accountId: meta.id,
      address: meta.address,
      effect: decision.effect,
      ruleId: decision.ruleId,
      reason: decision.reason,
      chainId: input.chainId,
      to: populated.to,
      valueWei: populated.value.toString(),
    });

    if (decision.effect === 'deny') {
      return { status: 'denied-by-policy', decision };
    }
    if (decision.effect === 'ask') {
      if (approval === undefined) {
        return { status: 'unavailable-approver', decision };
      }
      const outcome = await approval.request({
        toolName: context.toolName,
        callId: context.callId,
        signal: context.signal,
        reason: approvalReasonForTransaction(human, decision),
      });
      if (outcome !== 'allowed-once') {
        await this.vault.auditAppend('sign.approval', { outcome, accountId: meta.id, address: meta.address });
        return { status: 'awaiting-approval-rejected', decision, approvalOutcome: outcome };
      }
      await this.vault.auditAppend('sign.approval', { outcome, accountId: meta.id, address: meta.address });
    }

    this.vault.ensureUnlocked();
    const account = this.vault.getUnlockedAccount(meta.id);
    const signed = await coreSignTransaction(account.wallet, populated);
    const txHash = await provider.broadcastRawTransaction(signed.raw);
    await this.vault.recordSignedTransaction({
      account: meta,
      chainId: input.chainId,
      to: populated.to,
      valueWei: populated.value.toString(),
      txHash,
    });
    const result: SendResult = {
      status: 'signed-broadcast',
      decision,
      txHash,
      human,
      explorerUrl: explorerUrl(input.chainId, 'tx', txHash),
    };
    // Defense in depth: never let key material ride along in results.
    assertNoSecrets(result, [account.reveal().privateKey]);
    return result;
  }

  /** Sign an EIP-191 message under policy + approval. */
  async signMessage(
    input: { account: string; message: string },
    approval: ApprovalGateway | undefined,
    context: { toolName: string; callId?: string; signal?: AbortSignal } = { toolName: 'wallet_sign_message' },
  ): Promise<SignMessageResult> {
    this.vault.maybeAutoLock();
    const meta = this.vault.requireAccount(input.account);
    const decision = this.vault.evaluateSignPolicy({
      type: 'signMessage',
      account: { address: meta.address },
      message: input.message,
    });
    await this.vault.auditAppend('sign.decision', {
      type: 'signMessage',
      accountId: meta.id,
      address: meta.address,
      effect: decision.effect,
      ruleId: decision.ruleId,
      reason: decision.reason,
      messageLength: Buffer.byteLength(input.message, 'utf8'),
    });
    if (decision.effect === 'deny') return { status: 'denied-by-policy', decision, address: meta.address };
    if (decision.effect === 'ask') {
      if (approval === undefined) return { status: 'unavailable-approver', decision, address: meta.address };
      const outcome = await approval.request({
        toolName: context.toolName,
        callId: context.callId,
        signal: context.signal,
        reason: `Sign a personal message as ${meta.address} (${meta.label})?\n\nMessage (${String(Buffer.byteLength(input.message, 'utf8'))} bytes):\n${truncate(input.message, 400)}`,
      });
      if (outcome !== 'allowed-once') {
        await this.vault.auditAppend('sign.approval', { outcome, accountId: meta.id, address: meta.address });
        return { status: 'awaiting-approval-rejected', decision, approvalOutcome: outcome, address: meta.address };
      }
      await this.vault.auditAppend('sign.approval', { outcome, accountId: meta.id, address: meta.address });
    }
    this.vault.ensureUnlocked();
    const account = this.vault.getUnlockedAccount(meta.id);
    const { signature } = await coreSignMessage(account.wallet, input.message);
    await this.vault.auditAppend('sign.message', { accountId: meta.id, address: meta.address, signature });
    const result: SignMessageResult = { status: 'signed', decision, signature, address: meta.address };
    assertNoSecrets(result, [account.reveal().privateKey]);
    return result;
  }

  /** Sign EIP-712 typed data under policy + approval. */
  async signTypedData(
    input: { account: string; domain: TypedDataDomain; types: Record<string, TypedDataField[]>; value: Record<string, unknown> },
    approval: ApprovalGateway | undefined,
    context: { toolName: string; callId?: string; signal?: AbortSignal } = { toolName: 'wallet_sign_typed_data' },
  ): Promise<SignMessageResult> {
    this.vault.maybeAutoLock();
    const meta = this.vault.requireAccount(input.account);
    const typedDataJson = JSON.stringify({ domain: input.domain, types: input.types, value: input.value });
    const decision = this.vault.evaluateSignPolicy({
      type: 'signTypedData',
      account: { address: meta.address },
      chainId: typeof input.domain.chainId === 'number' ? input.domain.chainId : undefined,
      to: input.domain.verifyingContract ?? undefined,
      typedData: typedDataJson,
    });
    await this.vault.auditAppend('sign.decision', {
      type: 'signTypedData',
      accountId: meta.id,
      address: meta.address,
      effect: decision.effect,
      ruleId: decision.ruleId,
      reason: decision.reason,
      verifyingContract: input.domain.verifyingContract,
    });
    if (decision.effect === 'deny') return { status: 'denied-by-policy', decision, address: meta.address };
    if (decision.effect === 'ask') {
      if (approval === undefined) return { status: 'unavailable-approver', decision, address: meta.address };
      const outcome = await approval.request({
        toolName: context.toolName,
        callId: context.callId,
        signal: context.signal,
        reason: `Sign EIP-712 typed data as ${meta.address} (${meta.label})?\n\nDomain: ${JSON.stringify(input.domain)}\nPayload: ${truncate(typedDataJson, 400)}`,
      });
      if (outcome !== 'allowed-once') {
        await this.vault.auditAppend('sign.approval', { outcome, accountId: meta.id, address: meta.address });
        return { status: 'awaiting-approval-rejected', decision, approvalOutcome: outcome, address: meta.address };
      }
      await this.vault.auditAppend('sign.approval', { outcome, accountId: meta.id, address: meta.address });
    }
    this.vault.ensureUnlocked();
    const account = this.vault.getUnlockedAccount(meta.id);
    const { signature } = await coreSignTypedData(account.wallet, input.domain, input.types, input.value);
    await this.vault.auditAppend('sign.typedData', { accountId: meta.id, address: meta.address, signature });
    const result: SignMessageResult = { status: 'signed', decision, signature, address: meta.address };
    assertNoSecrets(result, [account.reveal().privateKey]);
    return result;
  }

  /** Current signing policy. */
  getPolicy(): SigningPolicy {
    return this.vault.getPolicy();
  }

  /** Replace the signing policy (tools gate this behind approval). */
  async setPolicy(policy: SigningPolicy): Promise<void> {
    await this.vault.setPolicy(policy);
    await this.vault.auditAppend('policy.updated', {
      defaultEffect: policy.defaultEffect,
      ruleCount: policy.rules.length,
    });
  }

  /** Reveal key material (tools ALWAYS gate this behind approval). */
  async revealSecret(
    accountId: string,
    kind: 'mnemonic' | 'privateKey',
  ): Promise<{ address: string; kind: string; value: string }> {
    this.vault.ensureUnlocked();
    const account = this.vault.getUnlockedAccount(accountId);
    const secret = account.reveal();
    if (kind === 'mnemonic') {
      if (secret.mnemonic === undefined) throw new Error('account has no mnemonic (imported from a raw key)');
      return { address: account.meta.address, kind, value: secret.mnemonic };
    }
    return { address: account.meta.address, kind, value: secret.privateKey };
  }

  /** Export an account as a Web3 Secret Storage keystore JSON. */
  async exportKeystore(accountId: string, keystorePassphrase: string): Promise<{ json: string; address: string }> {
    return await this.vault.exportKeystore(accountId, keystorePassphrase);
  }

  /** Recent audit entries (secret-free by construction). */
  async recentAudit(limit = 30): Promise<Array<{ ts: number; kind: string; detail: Record<string, unknown> }>> {
    return await this.vault.audit.recent(2, limit);
  }

  /** Format wei using a chain's native unit (display helper). */
  formatWei(wei: string | bigint, chainId?: number): string {
    const symbol = getChain(chainId ?? 0)?.symbol ?? 'ETH';
    return `${formatNative(wei)} ${symbol}`;
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function approvalReasonForTransaction(
  human: ReturnType<typeof describeTransaction>,
  decision: PolicyDecision,
): string {
  const lines = [
    `Approve transaction from ${human.from} (nonce ${String(human.nonce)})?`,
    `Chain: ${String(human.chainId)} | Type: EIP-${human.type === 2 ? '1559' : '155'}`,
    `To: ${human.to}`,
    `Value: ${human.valueWei} wei (${human.valueNative} native units)`,
    `Gas limit: ${human.gasLimit}`,
  ];
  if (human.selector !== undefined) lines.push(`Method selector: ${human.selector}`);
  lines.push(`Data length: ${String(human.dataLengthBytes)} bytes`);
  lines.push(`Policy: ${decision.reason}`);
  return lines.join('\n');
}
