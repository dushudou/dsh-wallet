/**
 * Model tool definitions for the wallet plugin.
 *
 * {@link buildTools} constructs the full tool surface from a wallet service and
 * an approval gateway. Each tool has `execute(args, ctx)` and an `output`
 * declaration (JSON-Schema + render) matching the DSH `ctx.tools` registry
 * (`ToolDefinition` shape), so `wallet_*` tools appear in the agent's native
 * function catalog and can be invoked by the model.
 *
 * Parameters use the DSH parameter DSL: an open object root whose properties
 * carry `{ type, description?, required?, enum? }`; requiredness is a
 * per-property `required: true` annotation.
 *
 * @module dsh-web3/tools
 */

import type { TypedDataDomain, TypedDataField } from 'ethers';
import { policyPreset } from 'dsh-web3-core';
import type { ApprovalGateway, WalletService } from './service.js';

/** Context passed to every tool execution. */
export interface ToolCallContext {
  callId?: string;
  signal?: AbortSignal;
}

/** A rendered output block for the model. */
export interface OutputBlock {
  type: 'text' | 'image';
  text?: string;
}

/** One property in the DSH parameter DSL. */
export interface ParamSpec {
  type: string;
  description?: string;
  required?: boolean;
  enum?: unknown[];
}

/** Tool parameter schema (open object root). */
export type ToolParameters = Record<string, ParamSpec>;

/** A single model tool, DSH `ToolDefinition`-shaped. */
export interface WalletTool {
  name: string;
  description: string;
  parameters: ToolParameters;
  execute(args: Record<string, unknown>, ctx: ToolCallContext): Promise<unknown>;
  output: {
    schema: { type: 'object' };
    render(args: Record<string, unknown>, value: unknown): OutputBlock[];
  };
}

/** Options for {@link buildTools}. */
export interface BuildToolsOptions {
  service: WalletService;
  approval: ApprovalGateway;
}

const accountSelector: ParamSpec = { type: 'string', description: 'Account id, address, or label.', required: true };
const chainId: ParamSpec = { type: 'number', description: 'EVM chain id (e.g. 1 for Ethereum, 137 for Polygon).', required: true };

function jsonBlock(value: unknown): OutputBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

/** Declare a JSON-object output rendered as pretty JSON text. */
function jsonOutput(args: Record<string, unknown>, value: unknown): OutputBlock[] {
  return jsonBlock(value);
}

/**
 * Build the full wallet tool surface.
 *
 * @param options - the wallet service and approval gateway.
 * @returns an array of tool descriptors ready for registration.
 */
export function buildTools(options: BuildToolsOptions): WalletTool[] {
  const { service, approval } = options;

  const tools: WalletTool[] = [
    {
      name: 'wallet_status',
      description: 'Get the wallet vault status: locked/unlocked, account count, policy summary, auto-lock interval.',
      parameters: {},
      async execute() {
        return service.status();
      },
      output: { schema: { type: 'object' }, render: jsonOutput },
    },

    {
      name: 'wallet_unlock',
      description: 'Unlock the wallet vault. Passphrase resolves from env / credentials store. Optionally read from a 0600 file (deleted after use).',
      parameters: {
        passphraseFile: { type: 'string', description: 'Absolute path to a 0600 file containing the passphrase.' },
      },
      async execute(args) {
        return service.unlock(args.passphraseFile as string | undefined);
      },
      output: { schema: { type: 'object' }, render: jsonOutput },
    },

    {
      name: 'wallet_lock',
      description: 'Lock the wallet vault, zeroizing all decrypted key material from memory.',
      parameters: {},
      async execute() {
        service.lock();
        return { locked: true };
      },
      output: { schema: { type: 'object' }, render: jsonOutput },
    },

    {
      name: 'wallet_list',
      description: 'List all accounts in the vault (metadata only — no private keys or mnemonics).',
      parameters: {},
      async execute() {
        return { accounts: service.listAccounts() };
      },
      output: { schema: { type: 'object' }, render: jsonOutput },
    },

    {
      name: 'wallet_create',
      description:
        'Generate a new HD account with a fresh BIP-39 mnemonic. By default the mnemonic is hidden; set reveal=true to show it (requires human approval).',
      parameters: {
        label: { type: 'string', description: 'Human-readable label.' },
        words: { type: 'number', enum: [12, 15, 18, 21, 24], description: 'Mnemonic word count. Default 12.' },
        reveal: { type: 'boolean', description: 'Whether to reveal the mnemonic in the result. Requires approval.' },
      },
      async execute(args, ctx) {
        const result = await service.createAccount({
          label: args.label as string | undefined,
          words: args.words as 12 | 15 | 18 | 21 | 24 | undefined,
        });
        if (args.reveal === true) {
          const outcome = await approval.request({
            toolName: 'wallet_create',
            callId: ctx.callId,
            signal: ctx.signal,
            reason: `Reveal the mnemonic for new account ${result.meta.address} (${result.meta.label})?`,
          });
          if (outcome === 'allowed-once') {
            return { meta: result.meta, mnemonic: result.mnemonic, mnemonicRevealed: true };
          }
          await service.vault.auditAppend('tool.reveal_denied', { accountId: result.meta.id, outcome });
          return { meta: result.meta, mnemonicRevealed: false };
        }
        return { meta: result.meta, mnemonicRevealed: false };
      },
      output: { schema: { type: 'object' }, render: jsonOutput },
    },

    {
      name: 'wallet_import',
      description: 'Import an account from a 0600 secret file (mnemonic, private key, or keystore JSON). File is deleted after reading.',
      parameters: {
        source: { type: 'string', enum: ['mnemonic', 'privateKey', 'keystore'], description: 'Type of secret material.', required: true },
        secretFile: { type: 'string', description: 'Absolute path to a 0600 file containing the secret.', required: true },
        keystorePassphraseFile: { type: 'string', description: 'Required for keystore: path to the keystore passphrase file.' },
        label: { type: 'string', description: 'Human-readable label.' },
        index: { type: 'number', description: 'HD derivation index for mnemonic imports.' },
      },
      async execute(args) {
        return service.importAccount({
          source: args.source as 'mnemonic' | 'privateKey' | 'keystore',
          secretFile: args.secretFile as string,
          keystorePassphraseFile: args.keystorePassphraseFile as string | undefined,
          label: args.label as string | undefined,
          index: args.index as number | undefined,
        });
      },
      output: { schema: { type: 'object' }, render: jsonOutput },
    },

    {
      name: 'wallet_remove_account',
      description: 'Remove an account from the vault (deletes its encrypted key file).',
      parameters: {
        account: accountSelector,
      },
      async execute(args) {
        const meta = service.vault.requireAccount(args.account as string);
        return service.removeAccount(meta.id);
      },
      output: { schema: { type: 'object' }, render: jsonOutput },
    },

    {
      name: 'wallet_chains',
      description: 'List all built-in EVM chains with their RPC endpoints and explorer URLs.',
      parameters: {},
      async execute() {
        const { listChains } = await import('dsh-web3-core');
        return { chains: listChains() };
      },
      output: { schema: { type: 'object' }, render: jsonOutput },
    },

    {
      name: 'wallet_balance',
      description: 'Get native and configured token balances for an account on a chain.',
      parameters: {
        account: accountSelector,
        chainId,
      },
      async execute(args) {
        const meta = service.vault.requireAccount(args.account as string);
        return service.balances(meta, args.chainId as number);
      },
      output: { schema: { type: 'object' }, render: jsonOutput },
    },

    {
      name: 'wallet_prepare_transaction',
      description:
        'Dry-run: populate a transaction (nonce, gas, fees) and evaluate the signing policy. No key material is touched and nothing is broadcast.',
      parameters: {
        account: accountSelector,
        chainId,
        to: { type: 'string', description: 'Recipient address.', required: true },
        value: { type: 'string', description: 'Amount in wei (decimal string). Default 0.' },
        data: { type: 'string', description: 'Calldata (0x-prefixed hex).' },
      },
      async execute(args) {
        const meta = service.vault.requireAccount(args.account as string);
        return service.prepareTransaction({
          from: meta.address,
          chainId: args.chainId as number,
          to: args.to as string,
          value: args.value as string | undefined,
          data: args.data as string | undefined,
        });
      },
      output: { schema: { type: 'object' }, render: jsonOutput },
    },

    {
      name: 'wallet_send_transaction',
      description:
        'Full transaction flow: populate → policy → approval (when ask) → sign → broadcast. Returns the tx hash and explorer link on success.',
      parameters: {
        account: accountSelector,
        chainId,
        to: { type: 'string', description: 'Recipient address.', required: true },
        value: { type: 'string', description: 'Amount in wei (decimal string). Default 0.' },
        data: { type: 'string', description: 'Calldata (0x-prefixed hex).' },
      },
      async execute(args, ctx) {
        const meta = service.vault.requireAccount(args.account as string);
        return service.sendTransaction(
          {
            from: meta.address,
            chainId: args.chainId as number,
            to: args.to as string,
            value: args.value as string | undefined,
            data: args.data as string | undefined,
          },
          approval,
          { toolName: 'wallet_send_transaction', callId: ctx.callId, signal: ctx.signal },
        );
      },
      output: { schema: { type: 'object' }, render: jsonOutput },
    },

    {
      name: 'wallet_sign_message',
      description: 'Sign an EIP-191 personal message under the signing policy. Requires policy allow or human approval.',
      parameters: {
        account: accountSelector,
        message: { type: 'string', description: 'The message text to sign.', required: true },
      },
      async execute(args, ctx) {
        return service.signMessage(
          { account: args.account as string, message: args.message as string },
          approval,
          { toolName: 'wallet_sign_message', callId: ctx.callId, signal: ctx.signal },
        );
      },
      output: { schema: { type: 'object' }, render: jsonOutput },
    },

    {
      name: 'wallet_sign_typed_data',
      description: 'Sign EIP-712 typed data under the signing policy. Requires policy allow or human approval.',
      parameters: {
        account: accountSelector,
        domain: { type: 'json', description: 'EIP-712 domain object.' },
        types: { type: 'json', description: 'EIP-712 type definitions.' },
        value: { type: 'json', description: 'The data values to sign.' },
      },
      async execute(args, ctx) {
        return service.signTypedData(
          {
            account: args.account as string,
            domain: args.domain as TypedDataDomain,
            types: args.types as Record<string, TypedDataField[]>,
            value: args.value as Record<string, unknown>,
          },
          approval,
          { toolName: 'wallet_sign_typed_data', callId: ctx.callId, signal: ctx.signal },
        );
      },
      output: { schema: { type: 'object' }, render: jsonOutput },
    },

    {
      name: 'wallet_policy_get',
      description: 'Get the current signing policy (rules, default effect, presets).',
      parameters: {},
      async execute() {
        return { policy: service.getPolicy() };
      },
      output: { schema: { type: 'object' }, render: jsonOutput },
    },

    {
      name: 'wallet_policy_set',
      description:
        'Replace the signing policy. Accepts a preset name (locked, strict, testnet, power) or a full policy document. Requires human approval.',
      parameters: {
        preset: { type: 'string', enum: ['locked', 'strict', 'testnet', 'power'], description: 'Apply a built-in preset.' },
        policy: { type: 'json', description: 'Full policy document.' },
      },
      async execute(args, ctx) {
        const outcome = await approval.request({
          toolName: 'wallet_policy_set',
          callId: ctx.callId,
          signal: ctx.signal,
          reason: `Change the wallet signing policy? ${args.preset !== undefined ? `Preset: ${args.preset}` : 'Custom policy document.'}`,
        });
        if (outcome !== 'allowed-once') {
          await service.vault.auditAppend('tool.policy_set_denied', { outcome });
          return { updated: false };
        }
        if (args.preset !== undefined) {
          await service.setPolicy(policyPreset(args.preset as 'locked' | 'strict' | 'testnet' | 'power'));
          return { updated: true, preset: args.preset };
        }
        if (args.policy !== undefined) {
          await service.setPolicy(args.policy as Parameters<WalletService['setPolicy']>[0]);
          return { updated: true };
        }
        return { updated: false, error: 'neither preset nor policy provided' };
      },
      output: { schema: { type: 'object' }, render: jsonOutput },
    },

    {
      name: 'wallet_reveal_secret',
      description: 'Reveal the mnemonic or private key for an account. ALWAYS requires human approval. The secret is returned once.',
      parameters: {
        account: accountSelector,
        kind: { type: 'string', enum: ['mnemonic', 'privateKey'], description: 'Which secret to reveal.', required: true },
      },
      async execute(args, ctx) {
        const meta = service.vault.requireAccount(args.account as string);
        const outcome = await approval.request({
          toolName: 'wallet_reveal_secret',
          callId: ctx.callId,
          signal: ctx.signal,
          reason: `Reveal the ${args.kind} for account ${meta.address} (${meta.label})? This exposes key material.`,
        });
        if (outcome !== 'allowed-once') {
          await service.vault.auditAppend('tool.reveal_denied', { accountId: meta.id, kind: args.kind, outcome });
          return { address: meta.address, kind: args.kind, revealed: false };
        }
        const secret = await service.revealSecret(meta.id, args.kind as 'mnemonic' | 'privateKey');
        return { ...secret, revealed: true };
      },
      output: { schema: { type: 'object' }, render: jsonOutput },
    },

    {
      name: 'wallet_export_keystore',
      description: 'Export an account as a Web3 Secret Storage keystore JSON (encrypted with a new passphrase).',
      parameters: {
        account: accountSelector,
        keystorePassphrase: { type: 'string', description: 'Passphrase to encrypt the exported keystore.', required: true },
      },
      async execute(args) {
        const meta = service.vault.requireAccount(args.account as string);
        return service.exportKeystore(meta.id, args.keystorePassphrase as string);
      },
      output: { schema: { type: 'object' }, render: jsonOutput },
    },

    {
      name: 'wallet_audit_log',
      description: 'Recent security audit entries: signing decisions, approvals, policy changes. Secret-free by construction.',
      parameters: {
        limit: { type: 'integer', description: 'Maximum entries to return. Default 30.' },
      },
      async execute(args) {
        const limit = typeof args.limit === 'number' ? args.limit : 30;
        return { entries: await service.recentAudit(limit) };
      },
      output: { schema: { type: 'object' }, render: jsonOutput },
    },
  ];

  return tools;
}
