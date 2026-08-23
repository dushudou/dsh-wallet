/**
 * Plugin configuration for the composition row.
 *
 * ```yaml
 * - id: wallet
 *   name: '@dsh-wallet/plugin'
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
 * @module @dsh-wallet/plugin/config
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
    /** Disable the built-in wallet tools (service-only mode). */
    disableTools: z.boolean().default(false),
    /** Disable the read-only HTTP endpoints for the web UI. */
    disableHttp: z.boolean().default(false),
  })
  .loose();

export type PluginConfigValue = {
  vaultPath?: string;
  autoLockMs?: number;
  passphrase?: { mode?: 'auto' | 'env' | 'manual' };
  chains?: {
    rpc?: Record<string, string>;
    tokens?: Record<string, Array<{ address: string; symbol?: string }>>;
  };
  disableTools?: boolean;
  disableHttp?: boolean;
};
