/**
 * The wallet vault: on-disk account index plus per-account encrypted key
 * files, with an in-memory unlocked state and auto-lock.
 *
 * On-disk layout inside the vault directory:
 *
 * ```text
 * vault.json           account metadata (no secrets)
 * policy.json          signing policy (no secrets)
 * limits.json          hard limits + whitelist switch (no secrets)
 * security.json        pre-signing security check settings (no secrets)
 * denylist.json        user denylist; denylist-feeds.json caches public feeds
 * spend-state.json     rolling-24h spend tracking (no secrets)
 * keys/<accountId>.json  AES-256-GCM encrypted key material (0600)
 * audit/audit-<date>.jsonl  append-only audit trail (no secrets)
 * ```
 *
 * Key files bind the account id into the GCM AAD, so a file renamed over
 * another account fails decryption instead of yielding the wrong key.
 *
 * @module dsh-web3-core/vault
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import {
  DEFAULT_KDF_PARAMS,
  DecryptError,
  decryptSecret,
  encryptSecret,
  type KdfParams,
  type KeystoreEnvelope,
} from './crypto.js';
import {
  accountFromPrivateKey,
  derivationPathFor,
  deriveFromMnemonic,
  generateMnemonic,
  isValidMnemonic,
  mnemonicId,
  newAccountId,
  normalizeMnemonic,
  toChecksumAddress,
  type MnemonicWords,
} from './account.js';
import type { AccountMeta, AccountSource, VaultIndex, VaultStatus } from './types.js';
import { assertNoSecrets } from './redact.js';
import { AuditLog } from './audit.js';
import { SpendTracker } from './policy/spend.js';
import { evaluatePolicy, intentOf, validatePolicy } from './policy/evaluate.js';
import { TxJournal } from './journal.js';
import { AddressBook } from './addressbook.js';
import { policyPreset } from './policy/presets.js';
import { defaultLimits, normalizeLimits, validateLimits, type WalletLimits } from './limits.js';
import { Denylist } from './denylist.js';
import { loadSecuritySettings, normalizeSecuritySettings, validateSecuritySettings, type SecuritySettings } from './security.js';
import type { PolicyRequest, SigningPolicy } from './policy/types.js';

/** Vault configuration. */
export interface VaultConfig {
  /** Absolute directory for the vault. */
  directory: string;
  /** Auto-lock after this many ms without use (default 15 min). */
  autoLockMs?: number;
  /** Scrypt cost for new key files (default N=32768, r=8, p=1). */
  kdf?: KdfParams;
}

const DEFAULT_AUTO_LOCK_MS = 15 * 60_000;

/** Vault is locked (or auto-locked); unlock before signing operations. */
export class VaultLockedError extends Error {
  constructor(message = 'wallet vault is locked') {
    super(message);
    this.name = 'VaultLockedError';
  }
}

/** Account not found by id or address. */
export class AccountNotFoundError extends Error {
  readonly accountId?: string;

  constructor(selector: string) {
    super(`no account matching "${selector}"`);
    this.name = 'AccountNotFoundError';
  }
}

/** The secret payload stored (encrypted) for one account. */
export interface AccountSecret {
  /** 0x-prefixed private key. */
  privateKey: string;
  /** Mnemonic phrase, for HD accounts. */
  mnemonic?: string;
  /** Derivation path, for HD accounts. */
  derivationPath?: string;
}

/** An account whose key material is decrypted in memory. */
export class UnlockedAccount {
  readonly meta: AccountMeta;
  readonly wallet: Wallet;
  private readonly secret: AccountSecret;
  private zeroized = false;

  constructor(meta: AccountMeta, secret: AccountSecret) {
    this.meta = meta;
    this.secret = secret;
    this.wallet = new Wallet(secret.privateKey);
    if (this.wallet.address.toLowerCase() !== meta.address.toLowerCase()) {
      throw new Error(`key file for account ${meta.label} does not control ${meta.address}`);
    }
  }

  /** Best-effort scrub of in-memory key material. JS strings are immutable -
   * this removes references so the GC can reclaim them - true zeroization is
   * impossible for strings, which is why we also keep the material scoped. */
  zeroize(): void {
    if (this.zeroized) return;
    this.zeroized = true;
    overwriteString(this.secret.privateKey);
    if (this.secret.mnemonic !== undefined) overwriteString(this.secret.mnemonic);
    if (this.secret.derivationPath !== undefined) overwriteString(this.secret.derivationPath);
  }

  /** Reveal key material (call sites must gate on policy + approval). */
  reveal(): AccountSecret {
    if (this.zeroized) throw new VaultLockedError('account was zeroized');
    return { ...this.secret };
  }
}

function overwriteString(value: string): void {
  // Strings are immutable in JS; this is best-effort. See class docs.
  try {
    value.replace(/./g, '\0');
  } catch {
    // Ignore.
  }
}

/** Envelope file wrapper with metadata. */
interface KeyFile extends KeystoreEnvelope {
  accountId: string;
  address: string;
  createdAt: string;
}

/** The vault manager. */
export class WalletVault {
  private index: VaultIndex;
  private readonly config: Required<Pick<VaultConfig, 'directory'>> & VaultConfig;
  private unlockedAccounts = new Map<string, UnlockedAccount>();
  private passphrase: string | undefined;
  private lastActivity = 0;
  readonly audit: AuditLog;
  readonly spend: SpendTracker;
  /** Signed-transaction journal (status, history, speed-up, idempotency). */
  readonly journal: TxJournal;
  /** Counterparty labels. */
  readonly addressBook: AddressBook;
  /** Addresses the wallet refuses to pay or grant permissions to. */
  readonly denylist: Denylist;

  private constructor(config: VaultConfig, index: VaultIndex, policy: SigningPolicy, limits: WalletLimits, security: SecuritySettings) {
    this.config = { autoLockMs: DEFAULT_AUTO_LOCK_MS, ...config };
    this.index = index;
    this.policy = policy;
    this.limits = limits;
    this.security = security;
    this.audit = new AuditLog(config.directory);
    this.spend = new SpendTracker(config.directory);
    this.journal = new TxJournal(config.directory);
    this.addressBook = new AddressBook(config.directory);
    this.denylist = new Denylist(config.directory);
  }

  private policy: SigningPolicy;
  private limits: WalletLimits;
  private security: SecuritySettings;

  /** Open (or initialize) a vault directory. */
  static async open(config: VaultConfig): Promise<WalletVault> {
    await mkdir(join(config.directory, 'keys'), { recursive: true });
    const indexPath = join(config.directory, 'vault.json');
    let index: VaultIndex;
    try {
      index = JSON.parse(await readFile(indexPath, 'utf8')) as VaultIndex;
      if (index.version !== 1) throw new Error(`unsupported vault version ${String(index.version)}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        index = {
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          accounts: [],
        };
        await writeJsonPrivate(indexPath, index);
      } else {
        throw error;
      }
    }
    const policyPath = join(config.directory, 'policy.json');
    let policy: SigningPolicy;
    try {
      policy = JSON.parse(await readFile(policyPath, 'utf8')) as SigningPolicy;
      const errors = validatePolicy(policy);
      if (errors.length > 0) throw new Error(`invalid policy: ${errors.join('; ')}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        policy = policyPreset('micropay');
        await writeJsonPrivate(policyPath, policy);
      } else {
        throw error;
      }
    }
    // Limits fail closed like the policy: a corrupt file stops the vault from
    // opening instead of silently dropping the user's caps.
    const limitsPath = join(config.directory, 'limits.json');
    let limits: WalletLimits;
    try {
      const raw: unknown = JSON.parse(await readFile(limitsPath, 'utf8'));
      const errors = validateLimits(raw);
      if (errors.length > 0) throw new Error(`invalid limits: ${errors.join('; ')}`);
      limits = normalizeLimits(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') limits = defaultLimits();
      else throw error;
    }
    // Security settings and the user denylist fail closed too: losing either
    // silently would switch protections off.
    const security = await loadSecuritySettings(join(config.directory, 'security.json'));
    const vault = new WalletVault(config, index, policy, limits, security);
    await vault.spend.load().catch(() => undefined);
    await vault.journal.load().catch(() => undefined);
    await vault.addressBook.load().catch(() => undefined);
    await vault.denylist.load();
    return vault;
  }

  // ── status & locking ────────────────────────────────────────────────────

  /** Vault directory path. */
  get directory(): string {
    return this.config.directory;
  }

  /** Whether key material is currently decrypted in memory. */
  get unlocked(): boolean {
    return this.unlockedAccounts.size > 0 && this.passphrase !== undefined;
  }

  /** Auto-lock interval in ms. */
  get autoLockMs(): number {
    return this.config.autoLockMs ?? DEFAULT_AUTO_LOCK_MS;
  }

  /** Current signing policy (no secrets). */
  getPolicy(): SigningPolicy {
    return structuredPolicyClone(this.policy);
  }

  /** Replace the signing policy after validation. */
  async setPolicy(next: SigningPolicy): Promise<void> {
    const errors = validatePolicy(next);
    if (errors.length > 0) throw new Error(`invalid policy: ${errors.join('; ')}`);
    this.policy = next;
    await writeJsonPrivate(join(this.config.directory, 'policy.json'), next);
  }

  /** Current hard limits (no secrets). */
  getLimits(): WalletLimits {
    return JSON.parse(JSON.stringify(this.limits)) as WalletLimits;
  }

  /** Replace the hard limits after validation. Callers decide who may loosen them. */
  async setLimits(next: WalletLimits): Promise<WalletLimits> {
    const limits = normalizeLimits({ ...next, updatedAt: new Date().toISOString() });
    this.limits = limits;
    await writeJsonPrivate(join(this.config.directory, 'limits.json'), limits);
    return this.getLimits();
  }

  /** Current security check settings. */
  getSecuritySettings(): SecuritySettings {
    return JSON.parse(JSON.stringify(this.security)) as SecuritySettings;
  }

  /** Replace the security settings after validation. Callers decide who may loosen them. */
  async setSecuritySettings(next: SecuritySettings): Promise<SecuritySettings> {
    const errors = validateSecuritySettings(next);
    if (errors.length > 0) throw new Error(`invalid security settings: ${errors.join('; ')}`);
    this.security = normalizeSecuritySettings({ ...next, updatedAt: new Date().toISOString() });
    await writeJsonPrivate(join(this.config.directory, 'security.json'), this.security);
    return this.getSecuritySettings();
  }

  /** Overall vault status (no secrets). */
  status(): VaultStatus {
    return {
      directory: this.config.directory,
      unlocked: this.unlocked,
      ...(this.unlocked ? { idleMs: Date.now() - this.lastActivity } : {}),
      autoLockMs: this.autoLockMs,
      accountCount: this.index.accounts.length,
      policySummary: {
        defaultEffect: this.policy.defaultEffect,
        ruleCount: this.policy.rules.length,
        updatedAt: this.policy.updatedAt,
      },
      vaultCreatedAt: this.index.createdAt,
    };
  }

  /** Throw VaultLockedError when not unlocked, refreshing activity time. */
  ensureUnlocked(): void {
    if (!this.unlocked) throw new VaultLockedError();
    this.lastActivity = Date.now();
  }

  /** Auto-lock when idle beyond the configured interval. */
  maybeAutoLock(): boolean {
    if (!this.unlocked) return false;
    if (Date.now() - this.lastActivity >= this.autoLockMs) {
      this.lock();
      return true;
    }
    return false;
  }

  /** Decrypt all account keys and keep them in memory until lock(). */
  async unlock(passphrase: string): Promise<void> {
    const accounts: UnlockedAccount[] = [];
    for (const meta of this.index.accounts) {
      const secret = await this.readAccountSecret(meta.id, passphrase);
      accounts.push(new UnlockedAccount(meta, secret));
    }
    this.unlockedAccounts = new Map(accounts.map((account) => [account.meta.id, account]));
    this.passphrase = passphrase;
    this.lastActivity = Date.now();
  }

  /** Drop and best-effort-scrub all decrypted key material. */
  lock(): void {
    for (const account of this.unlockedAccounts.values()) account.zeroize();
    this.unlockedAccounts = new Map();
    if (this.passphrase !== undefined) overwriteString(this.passphrase);
    this.passphrase = undefined;
    this.lastActivity = 0;
  }

  // ── accounts ─────────────────────────────────────────────────────────────

  /** List account metadata (no secrets). */
  listAccounts(): AccountMeta[] {
    return this.index.accounts.map((meta) => ({ ...meta }));
  }

  /** Find an account by id, address (case-insensitive), or label. */
  findAccount(selector: string): AccountMeta | undefined {
    const normalized = selector.trim();
    const lower = normalized.toLowerCase();
    return (
      this.index.accounts.find((meta) => meta.id === normalized) ??
      this.index.accounts.find((meta) => meta.address.toLowerCase() === lower) ??
      this.index.accounts.find((meta) => meta.label.toLowerCase() === lower)
    );
  }

  /** Require an account to exist. */
  requireAccount(selector: string): AccountMeta {
    const meta = this.findAccount(selector);
    if (meta === undefined) throw new AccountNotFoundError(selector);
    return meta;
  }

  /** The unlocked account for a selector (throws when locked/missing). */
  getUnlockedAccount(selector: string): UnlockedAccount {
    this.ensureUnlocked();
    const meta = this.requireAccount(selector);
    const account = this.unlockedAccounts.get(meta.id);
    if (account === undefined) throw new VaultLockedError(`account ${meta.label} is not unlocked`);
    this.lastActivity = Date.now();
    return account;
  }

  /** The stored passphrase (for re-encrypting on new accounts); internal. */
  currentPassphrase(): string | undefined {
    return this.passphrase;
  }

  /** Generate a fresh HD account (new random mnemonic). */
  async createAccount(
    options: { label?: string; words?: MnemonicWords } = {},
    passphrase?: string,
  ): Promise<{ meta: AccountMeta; mnemonic: string }> {
    const effectivePassphrase = passphrase ?? this.passphrase;
    if (effectivePassphrase === undefined) {
      throw new VaultLockedError('vault must be unlocked (or a passphrase supplied) to create accounts');
    }
    const phrase = generateMnemonic(options.words ?? 12);
    const derived = deriveFromMnemonic(phrase, 0);
    const meta: AccountMeta = {
      id: newAccountId(),
      label: options.label ?? `Account ${String(this.index.accounts.length + 1)}`,
      address: derived.address,
      source: 'generated',
      derivationPath: derived.path,
      index: 0,
      mnemonicId: await mnemonicId(phrase),
      createdAt: new Date().toISOString(),
    };
    await this.persistAccount(
      meta,
      { privateKey: derived.privateKey, mnemonic: phrase, derivationPath: derived.path },
      effectivePassphrase,
    );
    await this.auditAppend('account.created', { accountId: meta.id, address: meta.address, source: 'generated' }, [
      derived.privateKey,
      phrase,
    ]);
    return { meta, mnemonic: phrase };
  }

  /**
   * Derive the next HD account from an existing account's mnemonic
   * (MetaMask "Add account"): same seed, next unused index. Requires the
   * vault to be unlocked so the source mnemonic can be read in memory.
   */
  async deriveAccount(input: { fromAccountId: string; index?: number; label?: string }): Promise<{ meta: AccountMeta }> {
    const source = this.getUnlockedAccount(input.fromAccountId);
    const secret = source.reveal();
    if (secret.mnemonic === undefined || source.meta.mnemonicId === undefined) {
      throw new Error(`account ${source.meta.label} was not derived from a mnemonic; cannot derive siblings`);
    }
    const siblings = this.index.accounts.filter((meta) => meta.mnemonicId === source.meta.mnemonicId);
    const index = input.index ?? Math.max(...siblings.map((meta) => meta.index ?? 0)) + 1;
    if (!Number.isInteger(index) || index < 0) throw new Error('index must be a non-negative integer');
    if (siblings.some((meta) => meta.index === index)) throw new Error(`index ${String(index)} already exists for this mnemonic`);
    const derived = deriveFromMnemonic(secret.mnemonic, index);
    const meta: AccountMeta = {
      id: newAccountId(),
      label: input.label ?? `${source.meta.label} #${String(index + 1)}`,
      address: derived.address,
      source: source.meta.source,
      derivationPath: derived.path,
      index,
      mnemonicId: source.meta.mnemonicId,
      createdAt: new Date().toISOString(),
      ...(source.meta.backedUp === true ? { backedUp: true } : {}),
    };
    const passphrase = this.passphrase;
    if (passphrase === undefined) throw new VaultLockedError();
    await this.persistAccount(meta, { privateKey: derived.privateKey, mnemonic: secret.mnemonic, derivationPath: derived.path }, passphrase);
    await this.auditAppend('account.derived', { accountId: meta.id, address: meta.address, index, from: source.meta.id }, [
      derived.privateKey,
      secret.mnemonic,
    ]);
    return { meta };
  }

  /** Import an account from a BIP-39 mnemonic. */
  async importMnemonic(
    input: { mnemonic: string; label?: string; index?: number; passphraseHint?: string },
    passphrase?: string,
  ): Promise<{ meta: AccountMeta; mnemonicId: string }> {
    const effectivePassphrase = passphrase ?? this.passphrase;
    if (effectivePassphrase === undefined) throw new VaultLockedError('vault must be unlocked to import accounts');
    const phrase = normalizeMnemonic(input.mnemonic);
    if (!isValidMnemonic(phrase)) throw new Error('invalid BIP-39 mnemonic (checksum failed)');
    const derived = deriveFromMnemonic(phrase, input.index ?? 0);
    const id = await mnemonicId(phrase);
    const meta: AccountMeta = {
      id: newAccountId(),
      label: input.label ?? `Imported ${derived.address.slice(0, 8)}`,
      address: derived.address,
      source: 'imported-mnemonic',
      derivationPath: derived.path,
      index: input.index ?? 0,
      mnemonicId: id,
      createdAt: new Date().toISOString(),
    };
    await this.persistAccount(meta, { privateKey: derived.privateKey, mnemonic: phrase, derivationPath: derived.path }, effectivePassphrase);
    await this.auditAppend('account.imported', { accountId: meta.id, address: meta.address, source: 'imported-mnemonic' }, [
      derived.privateKey,
      phrase,
    ]);
    return { meta, mnemonicId: id };
  }

  /** Import an account from a raw private key. */
  async importPrivateKey(
    input: { privateKey: string; label?: string },
    passphrase?: string,
  ): Promise<{ meta: AccountMeta }> {
    const effectivePassphrase = passphrase ?? this.passphrase;
    if (effectivePassphrase === undefined) throw new VaultLockedError('vault must be unlocked to import accounts');
    const material = accountFromPrivateKey(input.privateKey);
    const meta: AccountMeta = {
      id: newAccountId(),
      label: input.label ?? `Imported ${material.address.slice(0, 8)}`,
      address: material.address,
      source: 'imported-private-key',
      createdAt: new Date().toISOString(),
    };
    await this.persistAccount(meta, { privateKey: material.privateKey }, effectivePassphrase);
    await this.auditAppend('account.imported', { accountId: meta.id, address: meta.address, source: 'imported-private-key' }, [
      material.privateKey,
    ]);
    return { meta };
  }

  /** Import an account from a Web3 Secret Storage keystore JSON. */
  async importKeystore(
    input: { keystoreJson: string; keystorePassphrase: string; label?: string },
    passphrase?: string,
  ): Promise<{ meta: AccountMeta }> {
    const effectivePassphrase = passphrase ?? this.passphrase;
    if (effectivePassphrase === undefined) throw new VaultLockedError('vault must be unlocked to import accounts');
    const wallet = await Wallet.fromEncryptedJson(input.keystoreJson, input.keystorePassphrase);
    const meta: AccountMeta = {
      id: newAccountId(),
      label: input.label ?? `Imported ${wallet.address.slice(0, 8)}`,
      address: wallet.address,
      source: 'imported-keystore',
      createdAt: new Date().toISOString(),
    };
    await this.persistAccount(meta, { privateKey: wallet.privateKey }, effectivePassphrase);
    await this.auditAppend('account.imported', { accountId: meta.id, address: wallet.address, source: 'imported-keystore' }, [
      wallet.privateKey,
    ]);
    return { meta };
  }

  /** Remove an account (encrypted key file + index entry). */
  async removeAccount(accountId: string): Promise<AccountMeta> {
    const meta = this.requireAccount(accountId);
    const keyPath = this.keyPath(meta.id);
    await rm(keyPath, { force: true });
    this.index = {
      ...this.index,
      accounts: this.index.accounts.filter((account) => account.id !== meta.id),
      updatedAt: new Date().toISOString(),
    };
    if (this.index.activeAccountId === meta.id) {
      const { activeAccountId: _drop, ...rest } = this.index;
      this.index = rest;
    }
    await writeJsonPrivate(join(this.config.directory, 'vault.json'), this.index);
    this.unlockedAccounts.delete(meta.id);
    await this.auditAppend('account.removed', { accountId: meta.id, address: meta.address });
    return meta;
  }

  /** Rename an account (labels are display-only; addresses never change). */
  async renameAccount(accountId: string, label: string): Promise<AccountMeta> {
    const trimmed = label.trim();
    if (trimmed.length === 0 || trimmed.length > 64) throw new Error('label must be 1-64 characters');
    const meta = this.requireAccount(accountId);
    const previous = meta.label;
    meta.label = trimmed;
    const unlocked = this.unlockedAccounts.get(meta.id);
    if (unlocked !== undefined) unlocked.meta.label = trimmed;
    this.index.updatedAt = new Date().toISOString();
    await writeJsonPrivate(join(this.config.directory, 'vault.json'), this.index);
    await this.auditAppend('account.renamed', { accountId: meta.id, address: meta.address, from: previous, to: trimmed });
    return { ...meta };
  }

  /** Mark an HD account's mnemonic as backed up. */
  async markBackedUp(accountId: string): Promise<void> {
    const meta = this.requireAccount(accountId);
    meta.backedUp = true;
    await writeJsonPrivate(join(this.config.directory, 'vault.json'), this.index);
  }

  /** Export an account as a Web3 Secret Storage keystore JSON. */
  async exportKeystore(accountId: string, keystorePassphrase: string): Promise<{ json: string; address: string }> {
    const account = this.getUnlockedAccount(accountId);
    const secret = account.reveal();
    const wallet = new Wallet(secret.privateKey);
    const json = await wallet.encrypt(keystorePassphrase);
    return { json, address: wallet.address };
  }

  // ── policy integration ──────────────────────────────────────────────────

  /**
   * Evaluate the signing policy for a request against the current spend
   * window. Pure: performs no signing and asks no questions.
   */
  evaluateSignPolicy(request: PolicyRequest): ReturnType<typeof evaluatePolicy> {
    const spent = request.type === 'signTransaction' ? this.spend.spentLast24hWei(request.account.address) : 0n;
    const intent = intentOf(request);
    const tokenSpent = intent?.token !== undefined ? this.spend.tokenSpentLast24h(request.account.address, intent.token) : 0n;
    return evaluatePolicy(this.policy, request, spent, {
      events: this.spend.events(),
      now: Date.now(),
      tokenSpentLast24h: tokenSpent,
    });
  }

  /** Record a signed transaction in the spend window + audit. */
  async recordSignedTransaction(entry: {
    account: AccountMeta;
    chainId: number;
    to: string;
    valueWei: string;
    txHash: string;
    /** Final recipient when it differs from `to` (token transfers). */
    recipient?: string;
    /** Token moved, for per-token daily caps. */
    token?: string;
    tokenAmount?: string;
  }): Promise<void> {
    await this.spend.record({
      chainId: entry.chainId,
      from: entry.account.address,
      to: entry.recipient ?? entry.to,
      valueWei: entry.valueWei,
      txHash: entry.txHash,
      ...(entry.token !== undefined && entry.tokenAmount !== undefined ? { token: entry.token, tokenAmount: entry.tokenAmount } : {}),
    });
    await this.auditAppend('sign.broadcast', {
      accountId: entry.account.id,
      address: entry.account.address,
      chainId: entry.chainId,
      to: entry.to,
      valueWei: entry.valueWei,
      txHash: entry.txHash,
    });
  }

  /**
   * Record a signed off-chain payment authorization (EIP-3009 / x402) in the
   * spend window, so per-token daily caps and first-seen gates see it.
   */
  async recordSignedAuthorization(entry: {
    account: AccountMeta;
    chainId: number;
    token: string;
    tokenAmount: string;
    recipient: string;
  }): Promise<void> {
    await this.spend.record({
      chainId: entry.chainId,
      from: entry.account.address,
      to: entry.recipient,
      valueWei: '0',
      token: entry.token,
      tokenAmount: entry.tokenAmount,
    });
  }

  /** Append an audit entry with secret scanning. */
  async auditAppend(kind: string, detail: Record<string, unknown>, secrets: readonly string[] = []): Promise<void> {
    const entry = { ts: Date.now(), kind, detail };
    assertNoSecrets(entry, secrets);
    await this.audit.append(entry, secrets);
  }

  // ── persistence internals ───────────────────────────────────────────────

  private keyPath(accountId: string): string {
    return join(this.config.directory, 'keys', `${accountId}.json`);
  }

  private async readAccountSecret(accountId: string, passphrase: string): Promise<AccountSecret> {
    const raw = await readFile(this.keyPath(accountId), 'utf8');
    const file = JSON.parse(raw) as KeyFile;
    if (file.accountId !== accountId) throw new Error(`key file ${accountId}.json carries account id ${file.accountId}`);
    await assertOwnerOnly(this.keyPath(accountId));
    const plain = await decryptSecret(file, passphrase);
    const secret = JSON.parse(plain) as AccountSecret;
    if (secret.privateKey === undefined) throw new Error(`key file ${accountId}.json has no private key`);
    return secret;
  }

  private async persistAccount(meta: AccountMeta, secret: AccountSecret, passphrase: string): Promise<void> {
    const envelope = await encryptSecret(JSON.stringify(secret), passphrase, {
      aad: meta.id,
      ...(this.config.kdf !== undefined ? { kdf: this.config.kdf } : {}),
    });
    const file: KeyFile = {
      ...envelope,
      accountId: meta.id,
      address: meta.address,
      createdAt: meta.createdAt,
    };
    const keyPath = this.keyPath(meta.id);
    const tmp = `${keyPath}.tmp-${randomBytes(4).toString('hex')}`;
    await mkdir(join(this.config.directory, 'keys'), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(file, undefined, 2)}\n`, { mode: 0o600 });
    await rename(tmp, keyPath);
    await assertOwnerOnly(keyPath);
    this.index = {
      ...this.index,
      accounts: [...this.index.accounts.filter((account) => account.id !== meta.id), { ...meta }],
      ...(this.index.activeAccountId === undefined ? { activeAccountId: meta.id } : {}),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonPrivate(join(this.config.directory, 'vault.json'), this.index);
    // If unlocked, make the new account immediately usable.
    if (this.unlocked) {
      this.unlockedAccounts.set(meta.id, new UnlockedAccount(meta, secret));
    }
  }
}

/** Write JSON with 0600 perms via temp+rename. */
async function writeJsonPrivate(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  await assertOwnerOnly(path);
}

/** Reject files readable by group/other (POSIX only). */
async function assertOwnerOnly(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) {
      throw new Error(
        `wallet file ${path} is readable by group/other (mode ${info.mode.toString(8)}); refusing to use it. Run: chmod 600 "${path}"`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function structuredPolicyClone(policy: SigningPolicy): SigningPolicy {
  return JSON.parse(JSON.stringify(policy)) as SigningPolicy;
}

export { DecryptError, toChecksumAddress };
