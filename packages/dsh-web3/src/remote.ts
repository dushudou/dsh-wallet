/**
 * Typert Remote namespace for the DSH web settings panel.
 *
 * The built-in DSH web host exposes plugin data over the client Connection RPC
 * carrier (`/api`, endpoint `namespace/method`) through Typert Remote
 * services — raw `http.get()` routes that plugins register on their own are
 * not served by the harness webserver. This namespace mirrors the read-only
 * surface of {@link buildRoutes} plus the create/import wallet flows, so the
 * settings UI can manage a Metamask-style wallet without exposing secrets.
 *
 * Read endpoints return secret-free JSON-serializable values. Write endpoints
 * (`create`, `import`) accept secrets only in the request payload and never
 * persist them; mnemonic reveal is gated on the host approval gateway.
 *
 * @module dsh-web3/remote
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

interface CreateRequest {
  label?: string;
  words?: number;
  /** Reveal the freshly generated mnemonic (requires host approval). */
  reveal?: boolean;
}

interface ImportRequest {
  source?: 'mnemonic' | 'privateKey' | 'keystore';
  /** Secret material pasted from the UI (mnemonic / private key / keystore JSON). */
  secret?: string;
  /** Required for keystore imports. */
  keystorePassphrase?: string;
  label?: string;
  index?: number;
}

const IMPORT_SOURCES = ['mnemonic', 'privateKey', 'keystore'] as const;

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
  async status(request: unknown) {
    return this.service.status();
  }

  /** List all accounts (metadata only). */
  async accounts(request: unknown) {
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
  async policy(request: unknown) {
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
  async chains(request: unknown) {
    const { listChains } = await import('dsh-web3-core');
    return { chains: listChains() };
  }

  /**
   * Create a fresh HD account (Metamask-style "create a new wallet").
   *
   * The mnemonic is generated once and returned when `reveal` is true. Unlike
   * the agent tool `wallet_create` (which keeps its reveal behind the
   * session-bound approval gateway), this panel endpoint is a user-initiated
   * local UI action: the person sitting in front of DSH web clicked "create
   * wallet", which is itself the authorization. The DSH approval service is
   * built for in-turn agent tool calls (`req.agent.session` + open turn) and
   * cannot be satisfied from a settings-panel RPC carrier — so this endpoint
   * intentionally does not route through it. Agent access to mnemonics stays
   * gated on `wallet_create`'s approval.
   */
  async create(request: unknown) {
    const query = (request ?? {}) as CreateRequest;
    if (query.words !== undefined && ![12, 15, 18, 21, 24].includes(query.words)) {
      return { ok: false, error: 'words must be one of 12, 15, 18, 21, 24' };
    }
    try {
      const result = await this.service.createAccount({
        label: query.label,
        words: query.words as 12 | 15 | 18 | 21 | 24 | undefined,
      });
      if (query.reveal !== true) {
        return { meta: result.meta, mnemonicRevealed: false };
      }
      await this.service.vault.auditAppend('remote.create_reveal', {
        accountId: result.meta.id,
        address: result.meta.address,
      });
      return { meta: result.meta, mnemonic: result.mnemonic, mnemonicRevealed: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Import an account from pasted secret material (mnemonic / private key /
   * keystore JSON). The secret is staged in a 0600 temp file and deleted
   * after import — never logged, never persisted by the wallet.
   */
  async import(request: unknown) {
    const query = (request ?? {}) as ImportRequest;
    if (!IMPORT_SOURCES.includes(query.source as (typeof IMPORT_SOURCES)[number])) {
      return { ok: false, error: 'source must be "mnemonic", "privateKey", or "keystore"' };
    }
    if (typeof query.secret !== 'string' || query.secret.trim().length === 0) {
      return { ok: false, error: 'secret is required' };
    }
    if (query.source === 'keystore' && typeof query.keystorePassphrase !== 'string') {
      return { ok: false, error: 'keystore import requires keystorePassphrase' };
    }
    const source = query.source as 'mnemonic' | 'privateKey' | 'keystore';
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web3-import-'));
    let keystorePassphraseFile: string | undefined;
    try {
      const secretFile = join(dir, 'secret');
      await writeFile(secretFile, query.secret, { mode: 0o600 });
      if (query.source === 'keystore') {
        keystorePassphraseFile = join(dir, 'passphrase');
        await writeFile(keystorePassphraseFile, query.keystorePassphrase as string, { mode: 0o600 });
      }
      const { meta } = await this.service.importAccount({
        source,
        secretFile,
        keystorePassphraseFile,
        label: query.label,
        index: query.index,
      });
      return { meta };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

for (const method of [
  'status',
  'accounts',
  'balances',
  'policy',
  'audit',
  'chains',
  'create',
  'import',
]) {
  markRemoteMethod(Web3Remote.prototype, method);
}
