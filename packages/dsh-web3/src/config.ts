/**
 * Plugin configuration for the composition row.
 *
 * ```yaml
 * - id: wallet
 *   name: 'dsh-web3'
 *   config:
 *     vaultPath: ~/.dsh/wallet
 *     autoLockMs: 900000
 *     passphrase:
 *       mode: auto
 *     chains:
 *       rpc:
 *         1: https://my-eth-rpc.example
 * ```
 *
 * @module dsh-web3/config
 */

import z from '@deepseek-ai/schemastery';

export const PluginConfig = z
  .object({
    /** Vault directory. Defaults to `$DSH_HOME/wallet` or `~/.dsh/wallet`. */
    vaultPath: z.string(),
    /** Auto-lock idle interval in ms (default 15 min). */
    autoLockMs: z.natural(),
    /** Passphrase resolution strategy. */
    passphrase: z
      .object({
        /** `auto` (default): use the credentials store, generating on first use.
         *  `env`: read `DSH_WALLET_PASSPHRASE` from the environment.
         *  `manual`: never generate; the user supplies env or credentials. */
        mode: z.union(['auto', 'env', 'manual']).default('auto'),
      })
      .loose(),
    /** Per-chain configuration. */
    chains: z
      .object({
        /** RPC overrides: chain id -> URL. */
        rpc: z.dict(z.string()),
        /** Watch-only tokens per chain: chainId -> [{address, symbol?}] */
        tokens: z.dict(z.array(z.object({ address: z.string(), symbol: z.string() }).loose())),
      })
      .loose(),
    /**
     * Where the vault passphrase and PIN pepper live. `auto` (default): the
     * macOS Keychain on macOS, otherwise none (credentials store only).
     * The `DSH_WEB3_SECRET_STORE` environment variable overrides `auto`.
     */
    secretStore: z.union(['auto', 'keychain', 'none']).default('auto'),
    /** Disable the built-in wallet tools (service-only mode). */
    disableTools: z.boolean().default(false),
    /** Disable the read-only HTTP endpoints for the web UI. */
    disableHttp: z.boolean().default(false),
    /**
     * UNSAFE: allow model tools to return mnemonics / private keys into the
     * chat transcript (after human approval). Off by default — the
     * transcript is sent to the model provider and stored in session logs.
     */
    unsafeAllowModelSecretReveal: z.boolean().default(false),
  })
  .loose();

export type PluginConfigValue = {
  vaultPath?: string;
  autoLockMs?: number;
  passphrase?: { mode?: 'auto' | 'env' | 'manual' };
  secretStore?: 'auto' | 'keychain' | 'none';
  chains?: {
    rpc?: Record<string, string>;
    tokens?: Record<string, Array<{ address: string; symbol?: string }>>;
  };
  disableTools?: boolean;
  disableHttp?: boolean;
  unsafeAllowModelSecretReveal?: boolean;
};
