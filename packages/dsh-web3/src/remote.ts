/**
 * Typert Remote namespace for the DSH web settings panel.
 *
 * The built-in DSH web host exposes plugin data over the client Connection RPC
 * carrier (`/api`, endpoint `namespace/method`) through Typert Remote
 * services — raw `http.get()` routes that plugins register on their own are
 * not served by the harness webserver. This namespace mirrors the read-only
 * surface of {@link buildRoutes} so the settings UI can render vault status,
 * accounts, signing policy, balances, and audit entries.
 *
 * All methods return secret-free JSON-serializable values.
 *
 * @module dsh-web3/remote
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { Context } from '@deepseek-ai/cordis';
import type { WalletService } from './service.js';

/**
 * Mark one `@Remote(method)` method without decorator syntax. The shim mimics
 * the decorator context `addMarkerInitializer` expects and marks the real
 * prototype exactly like a standard-decorator initializer would.
 */
function markRemoteMethod(prototype: object, method: string): void {
  const decorator = Remote(method) as (method: unknown, context: unknown) => void;
  decorator(undefined, {
    name: method,
    private: false,
    static: false,
    addInitializer(fn: () => void) {
      fn.call(Object.create(prototype));
    },
  });
}

interface BalancesRequest {
  chainId?: number;
  address?: string;
}

interface AuditRequest {
  limit?: number;
}

/**
 * `web3` Remote namespace consumed by the settings panel over the client
 * Connection RPC carrier (`/api`, endpoint `web3/<method>`).
 */
export class Web3Remote extends TypertRemoteService {
  private readonly service: WalletService;

  constructor(ctx: Context, service: WalletService) {
    super(ctx, 'web3');
    this.service = service;
  }

  /** Vault status snapshot ({@link WalletService.status}). */
  async status(_request: unknown) {
    return this.service.status();
  }

  /** List all accounts (metadata only). */
  async accounts(_request: unknown) {
    return { accounts: this.service.listAccounts() };
  }

  /** Native + configured token balances. Query: chainId, address. */
  async balances(request: unknown) {
    const query = (request ?? {}) as BalancesRequest;
    if (!Number.isFinite(Number(query.chainId)) || typeof query.address !== 'string') {
      return { ok: false, error: 'query parameters "chainId" and "address" are required' };
    }
    try {
      const meta = this.service.vault.requireAccount(query.address);
      return await this.service.balances(meta, Number(query.chainId));
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Current signing policy. */
  async policy(_request: unknown) {
    return { policy: this.service.getPolicy() };
  }

  /** Recent audit entries. Query: limit (default 30). */
  async audit(request: unknown) {
    const query = (request ?? {}) as AuditRequest;
    const limit = Number(query.limit);
    const entries = await this.service.recentAudit(Number.isFinite(limit) ? limit : 30);
    return { entries };
  }

  /** Built-in chain registry. */
  async chains(_request: unknown) {
    const { listChains } = await import('dsh-web3-core');
    return { chains: listChains() };
  }
}

for (const method of ['status', 'accounts', 'balances', 'policy', 'audit', 'chains']) {
  markRemoteMethod(Web3Remote.prototype, method);
}
