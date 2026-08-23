/**
 * Model tool definitions for the wallet plugin.
 *
 * {@link buildTools} constructs the full tool surface from a wallet service and
 * an approval gateway. Each tool has `execute(args, ctx)` and an optional
 * `output.render` for structured model responses.
 *
 * @module @dsh-wallet/plugin/tools
 */

import type { TypedDataDomain, TypedDataField } from 'ethers';
import z from '@deepseek-ai/schemastery';
import { policyPreset } from '@dsh-wallet/core';
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

/** A single model tool. */
export interface WalletTool {
  name: string;
  description: string;
  parameters: unknown;
  execute(args: Record<string, unknown>, ctx: ToolCallContext): Promise<unknown>;
  output?: {
    render(args: Record<string, unknown>, value: unknown): OutputBlock[];
  };
}

/** Options for {@link buildTools}. */
export interface BuildToolsOptions {
  service: WalletService;
  approval: ApprovalGateway;
}

const accountSelector = z.string().description('Account id, address, or label.');
const chainId = z.number().description('EVM chain id (e.g. 1 for Ethereum, 137 for Polygon).');

function jsonBlock(value: unknown): OutputBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
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
      parameters: z.object({}),
      async execute() {
        return service.status();
      },
      output: { render: (_args, value) => jsonBlock(value) },
    },

    {
      name: 'wallet_unlock',
      description: 'Unlock the wallet vault. Passphrase resolves from env / credentials store. Optionally read from a 0600 file (deleted after use).',
      parameters: z.object({
        passphraseFile: z.string().required(false).description('Absolute path to a 0600 file containing the passphrase.'),
      }),
      async execute(args) {
        return service.unlock(args.passphraseFile as string | undefined);
      },
    },

    {
      name: 'wallet_lock',
      description: 'Lock the wallet vault, zeroizing all decrypted key material from memory.',
      parameters: z.object({}),
      async execute() {
        service.lock();
        return { locked: true };
      },
    },

    {
      name: 'wallet_list',
      description: 'List all accounts in the vault (metadata only — no private keys or mnemonics).',
      parameters: z.object({}),
      async execute() {
        return { accounts: service.listAccounts() };
      },
    },

    {
      name: 'wallet_create',
      description:
        'Generate a new HD account with a fresh BIP-39 mnemonic. By default the mnemonic is hidden; set reveal=true to show it (requires human approval).',
      parameters: z.object({
        label: z.string().required(false).description('Human-readable label.'),
        words: z.union([12, 15, 18, 21, 24]).required(false).description('Mnemonic word count. Default 12.'),
        reveal: z.boolean().required(false).description('Whether to reveal the mnemonic in the result. Requires approval.'),
      }),
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
    },

    {
      name: 'wallet_import',
      description: 'Import an account from a 0600 secret file (mnemonic, private key, or keystore JSON). File is deleted after reading.',
      parameters: z.object({
        source: z.union(['mnemonic', 'privateKey', 'keystore']).description('Type of secret material.'),
        secretFile: z.string().description('Absolute path to a 0600 file containing the secret.'),
        keystorePassphraseFile: z.string().required(false).description('Required for keystore: path to the keystore passphrase file.'),
        label: z.string().required(false).description('Human-readable label.'),
        index: z.number().required(false).description('HD derivation index for mnemonic imports.'),
      }),
      async execute(args) {
        return service.importAccount({
          source: args.source as 'mnemonic' | 'privateKey' | 'keystore',
          secretFile: args.secretFile as string,
          keystorePassphraseFile: args.keystorePassphraseFile as string | undefined,
          label: args.label as string | undefined,
          index: args.index as number | undefined,
        });
      },
    },

    {
      name: 'wallet_remove_account',
      description: 'Remove an account from the vault (deletes its encrypted key file).',
      parameters: z.object({
        account: accountSelector,
      }),
      async execute(args) {
        const meta = service.vault.requireAccount(args.account as string);
        return service.removeAccount(meta.id);
      },
    },

    {
      name: 'wallet_chains',
      description: 'List all built-in EVM chains with their RPC endpoints and explorer URLs.',
      parameters: z.object({}),
      async execute() {
        const { listChains } = await import('@dsh-wallet/core');
        return { chains: listChains() };
      },
    },

    {
      name: 'wallet_balance',
      description: 'Get native and configured token balances for an account on a chain.',
      parameters: z.object({
        account: accountSelector,
        chainId,
      }),
      async execute(args) {
        const meta = service.vault.requireAccount(args.account as string);
        return service.balances(meta, args.chainId as number);
      },
    },

    {
      name: 'wallet_prepare_transaction',
      description:
        'Dry-run: populate a transaction (nonce, gas, fees) and evaluate the signing policy. No key material is touched and nothing is broadcast.',
      parameters: z.object({
        account: accountSelector,
        chainId,
        to: z.string().description('Recipient address.'),
        value: z.string().required(false).description('Amount in wei (decimal string). Default 0.'),
        data: z.string().required(false).description('Calldata (0x-prefixed hex).'),
      }),
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
    },

    {
      name: 'wallet_send_transaction',
      description:
        'Full transaction flow: populate → policy → approval (when ask) → sign → broadcast. Returns the tx hash and explorer link on success.',
      parameters: z.object({
        account: accountSelector,
        chainId,
        to: z.string().description('Recipient address.'),
        value: z.string().required(false).description('Amount in wei (decimal string). Default 0.'),
        data: z.string().required(false).description('Calldata (0x-prefixed hex).'),
      }),
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
    },

    {
      name: 'wallet_sign_message',
      description: 'Sign an EIP-191 personal message under the signing policy. Requires policy allow or human approval.',
      parameters: z.object({
        account: accountSelector,
        message: z.string().description('The message text to sign.'),
      }),
      async execute(args, ctx) {
        return service.signMessage(
          { account: args.account as string, message: args.message as string },
          approval,
          { toolName: 'wallet_sign_message', callId: ctx.callId, signal: ctx.signal },
        );
      },
    },

    {
      name: 'wallet_sign_typed_data',
      description: 'Sign EIP-712 typed data under the signing policy. Requires policy allow or human approval.',
      parameters: z.object({
        account: accountSelector,
        domain: z.object({}).loose().description('EIP-712 domain object.'),
        types: z.object({}).loose().description('EIP-712 type definitions.'),
        value: z.object({}).loose().description('The data values to sign.'),
      }),
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
    },

    {
      name: 'wallet_policy_get',
      description: 'Get the current signing policy (rules, default effect, presets).',
      parameters: z.object({}),
      async execute() {
        return { policy: service.getPolicy() };
      },
    },

    {
      name: 'wallet_policy_set',
      description:
        'Replace the signing policy. Accepts a preset name (locked, strict, testnet, power) or a full policy document. Requires human approval.',
      parameters: z.object({
        preset: z.union(['locked', 'strict', 'testnet', 'power']).required(false).description('Apply a built-in preset.'),
        policy: z.object({}).loose().required(false).description('Full policy document.'),
      }),
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
    },

    {
      name: 'wallet_reveal_secret',
      description: 'Reveal the mnemonic or private key for an account. ALWAYS requires human approval. The secret is returned once.',
      parameters: z.object({
        account: accountSelector,
        kind: z.union(['mnemonic', 'privateKey']).description('Which secret to reveal.'),
      }),
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
    },

    {
      name: 'wallet_export_keystore',
      description: 'Export an account as a Web3 Secret Storage keystore JSON (encrypted with a new passphrase).',
      parameters: z.object({
        account: accountSelector,
        keystorePassphrase: z.string().description('Passphrase to encrypt the exported keystore.'),
      }),
      async execute(args) {
        const meta = service.vault.requireAccount(args.account as string);
        return service.exportKeystore(meta.id, args.keystorePassphrase as string);
      },
    },
  ];

  return tools;
}
