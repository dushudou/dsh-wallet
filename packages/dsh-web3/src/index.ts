/**
 * dsh-web3 plugin entrypoint.
 *
 * Mounts the wallet service (`ctx.wallet`), registers model tools
 * (`wallet_*`), and exposes read-only endpoints for the web UI — raw HTTP
 * routes where an `http` service exists, plus a Typert Remote namespace
 * (`web3/status`, `web3/accounts`, …) for the DSH web settings panel.
 *
 * @module dsh-web3
 */

import { WalletVault, type SigningPolicy } from 'dsh-web3-core';
import type { Context } from '@deepseek-ai/cordis';
import { PluginConfig, type PluginConfigValue } from './config.js';
import { defaultVaultPath, WalletService, type ApprovalGateway } from './service.js';
import { buildTools } from './tools.js';
import { buildRoutes } from './http.js';
import { Web3Remote } from './remote.js';

export type { WalletService, ApprovalGateway, SendResult, SignMessageResult } from './service.js';
export type { PluginConfigValue } from './config.js';
export { buildTools } from './tools.js';
export { buildRoutes } from './http.js';
export { Web3Remote } from './remote.js';

/** The resolved runtime config after defaults are applied. */
interface ResolvedConfig {
  vaultPath: string;
  autoLockMs: number;
  passphraseMode: 'auto' | 'env' | 'manual';
  rpcOverrides: Record<string, string>;
  tokens: Record<string, Array<{ address: string; symbol?: string }>>;
  disableTools: boolean;
  disableHttp: boolean;
}

function resolveConfig(raw: PluginConfigValue): ResolvedConfig {
  return {
    vaultPath: raw.vaultPath ?? defaultVaultPath(),
    autoLockMs: raw.autoLockMs ?? 900_000,
    passphraseMode: raw.passphrase?.mode ?? 'auto',
    rpcOverrides: raw.chains?.rpc ?? {},
    tokens: raw.chains?.tokens ?? {},
    disableTools: raw.disableTools ?? false,
    disableHttp: raw.disableHttp ?? false,
  };
}

/**
 * The wallet plugin.
 *
 * Usage in a DSH composition:
 *
 * ```yaml
 * - id: wallet
 *   name: 'dsh-web3'
 *   config:
 *     vaultPath: ~/.dsh/wallet
 *     passphrase:
 *       mode: auto
 * ```
 */
export function applyWalletPlugin(ctx: Context, rawConfig: PluginConfigValue): () => Promise<void> {
  const config = resolveConfig(rawConfig);
  const logger = ctx.logger('wallet');

  // The disposers registered during startup, run in reverse on unload.
  const disposers: Array<() => void | Promise<void>> = [];

  // Open the vault (initializes on first run).
  const vaultPromise = WalletVault.open({
    directory: config.vaultPath,
    autoLockMs: config.autoLockMs,
  }).then((vault) => {
    logger.info(`vault opened at ${config.vaultPath} (${vault.listAccounts().length} accounts)`);
    return vault;
  });

  // Create the service once the vault is ready.
  const servicePromise = vaultPromise.then(
    (vault) =>
      new WalletService(vault, {
        vaultPath: config.vaultPath,
        autoLockMs: config.autoLockMs,
        passphraseMode: config.passphraseMode,
        env: process.env as Record<string, string | undefined>,
        credentials: ctx.get('credentials') as
          | { resolve(ref: string): Promise<{ value?: string } | undefined>; set(ref: string, value: string): Promise<void> }
          | undefined,
        rpcOverrides: config.rpcOverrides,
        tokens: config.tokens,
      }),
  );

  // Register ctx.wallet once the service is ready.
  servicePromise.then((service) => {
    const dispose = ctx.provide('wallet', service);
    disposers.push(dispose);
    logger.info('wallet service mounted at ctx.wallet');
  });

  // Register model tools.
  if (!config.disableTools) {
    const modelTools = ctx.get('model.tools') as
      | {
          register(tool: {
            name: string;
            description: string;
            parameters: unknown;
            execute: (args: Record<string, unknown>, toolCtx: { callId?: string; signal?: AbortSignal }) => Promise<unknown>;
            output?: { render: (args: Record<string, unknown>, value: unknown) => Array<{ type: string; text?: string }> };
          }): () => void;
        }
      | undefined;

    if (modelTools !== undefined) {
      servicePromise.then((service) => {
        const tools = buildTools({ service, approval: resolveApproval(ctx) });
        for (const tool of tools) {
          const dispose = modelTools.register(tool);
          disposers.push(dispose);
        }
        logger.info(`registered ${tools.length} wallet model tools`);
      });
    } else {
      logger.warn('model.tools service not available; skipping tool registration');
    }
  }

  // Register read-only HTTP endpoints (plain Node hosts that expose `http`).
  if (!config.disableHttp) {
    const http = ctx.get('http') as
      | {
          get(path: string, handler: (req: { method: string; url?: string; query?: Record<string, string> }, res: { statusCode: number; setHeader: (n: string, v: string) => void; end: (b: string) => void }) => void): () => void;
        }
      | undefined;

    if (http !== undefined) {
      servicePromise.then((service) => {
        const routes = buildRoutes(service);
        for (const route of routes) {
          const dispose = http.get(route.path, route.handler);
          disposers.push(dispose);
        }
        logger.info(`registered ${routes.length} wallet HTTP endpoints`);
      });
    } else {
      logger.warn('http service not available; skipping HTTP endpoint registration');
    }

    // Register the Typert Remote namespace consumed by the DSH web settings
    // panel over the client Connection RPC carrier (`/api`, endpoint
    // `web3/<method>`). `Service` construction requires a real Cordis context
    // (`ctx.reflect.provide`); hosts without it stay on HTTP-only mode.
    const reflect = (ctx as unknown as { reflect?: { provide?: unknown } }).reflect;
    if (typeof reflect?.provide === 'function') {
      servicePromise.then((service) => {
        new Web3Remote(ctx, service, resolveApproval(ctx));
        logger.info('wallet web3 Typert Remote namespace mounted (status/accounts/balances/policy/audit/chains/create/import)');
      });
    } else {
      logger.warn('ctx.reflect not available; skipping Typert Remote registration');
    }
  }

  // Unload: lock the vault and dispose everything.
  return async () => {
    for (let i = disposers.length - 1; i >= 0; i -= 1) {
      try {
        const dispose = disposers[i];
        if (dispose !== undefined) await dispose();
      } catch (error) {
        logger.warn(`disposer failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      const vault = await vaultPromise;
      vault.lock();
      logger.info('vault locked on plugin unload');
    } catch {
      // Vault never opened; nothing to lock.
    }
  };
}

// Attach plugin metadata as static properties (cordis plugin shape).
// Function `name` is read-only: define it instead of assigning.
Object.defineProperty(applyWalletPlugin, 'name', { value: 'dsh-web3' });
(applyWalletPlugin as unknown as { Config: typeof PluginConfig }).Config = PluginConfig;
(applyWalletPlugin as unknown as { provide: string }).provide = 'wallet';

export default applyWalletPlugin;

/** Resolve the approval gateway from the context (harness-provided). */
function resolveApproval(ctx: Context): ApprovalGateway {
  const gateway = ctx.get('approval') as ApprovalGateway | undefined;
  if (gateway !== undefined) return gateway;
  // Fallback: no approver available — all `ask` decisions become unavailable.
  return {
    async request() {
      return 'unavailable' as const;
    },
  };
}

// Re-export core types that plugin consumers may need.
export type { SigningPolicy };
