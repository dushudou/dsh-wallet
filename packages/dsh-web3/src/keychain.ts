/**
 * OS secret store for wallet secrets that must never sit in a plaintext file:
 * the vault passphrase and the PIN pepper.
 *
 * On macOS this is the login Keychain, driven through `/usr/bin/security`
 * (no native module). Values are written over stdin (`security -i`) so they
 * never appear in a process listing, and every write is read back to confirm
 * it landed (interactive mode does not report failures through its exit code).
 *
 * Items live under the service `dsh-web3`; the account name embeds the vault
 * path so two vaults never share a secret.
 *
 * @module dsh-web3/keychain
 */

import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/** Keychain service name for every dsh-web3 item. */
export const KEYCHAIN_SERVICE = 'dsh-web3';

/** A named-secret store scoped to one vault. */
export interface SecretStore {
  /** Human-readable backend name (shown in status / audit). */
  readonly kind: 'keychain';
  /** Read a secret; `undefined` when absent. Throws when the store fails. */
  get(name: string): Promise<string | undefined>;
  /** Create or replace a secret, verified by reading it back. */
  set(name: string, value: string): Promise<void>;
  /** Remove a secret; removing an absent one is a no-op. */
  delete(name: string): Promise<void>;
}

/** `security` exit code for "item not found". */
const NOT_FOUND = 44;

/** Characters that would break `security -i` quoting. */
const UNSAFE = /["\\\r\n]/;

function run(bin: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { encoding: 'utf8', timeout: 15_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1;
      resolve({ code, stdout, stderr });
    });
  });
}

function runWithStdin(bin: string, args: string[], input: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr });
    });
    child.stdin.end(input);
  });
}

/** macOS login Keychain, one vault's items. */
export class MacKeychain implements SecretStore {
  readonly kind = 'keychain' as const;
  private readonly scope: string;
  private readonly bin: string;
  private readonly service: string;

  /**
   * @param scope - the vault path (part of every account name).
   * @param options - `bin`/`service` overrides (tests).
   */
  constructor(scope: string, options: { bin?: string; service?: string } = {}) {
    this.scope = scope;
    this.bin = options.bin ?? '/usr/bin/security';
    this.service = options.service ?? KEYCHAIN_SERVICE;
  }

  private account(name: string): string {
    const account = `${name}@${this.scope}`;
    if (UNSAFE.test(account)) throw new Error(`keychain account name contains unsupported characters: ${account}`);
    return account;
  }

  async get(name: string): Promise<string | undefined> {
    const { code, stdout, stderr } = await run(this.bin, ['find-generic-password', '-s', this.service, '-a', this.account(name), '-w']);
    if (code === NOT_FOUND) return undefined;
    if (code !== 0) throw new Error(`keychain read failed (exit ${code}): ${stderr.trim()}`);
    const value = stdout.replace(/\n$/, '');
    return value.length > 0 ? value : undefined;
  }

  async set(name: string, value: string): Promise<void> {
    if (value.length === 0) throw new Error('refusing to store an empty secret in the keychain');
    if (UNSAFE.test(value)) throw new Error('keychain value contains unsupported characters');
    const account = this.account(name);
    const { stderr } = await runWithStdin(
      this.bin,
      ['-i'],
      `add-generic-password -U -s "${this.service}" -a "${account}" -l "${this.service} ${name}" -w "${value}"\n`,
    );
    if ((await this.get(name)) !== value) {
      throw new Error(`keychain write did not persist${stderr.trim() !== '' ? `: ${stderr.trim()}` : ''}`);
    }
  }

  async delete(name: string): Promise<void> {
    const { code, stderr } = await run(this.bin, ['delete-generic-password', '-s', this.service, '-a', this.account(name)]);
    if (code !== 0 && code !== NOT_FOUND) throw new Error(`keychain delete failed (exit ${code}): ${stderr.trim()}`);
  }
}

/** Which secret store to use: `auto` = Keychain on macOS, else none. */
export type SecretStoreMode = 'auto' | 'keychain' | 'none';

/** Build the secret store for a vault, or `undefined` when none applies. */
export function createSecretStore(mode: SecretStoreMode, vaultPath: string): SecretStore | undefined {
  if (mode === 'none') return undefined;
  if (mode === 'keychain' || process.platform === 'darwin') {
    if (process.platform !== 'darwin') throw new Error('secretStore "keychain" is only supported on macOS');
    return new MacKeychain(vaultPath);
  }
  return undefined;
}

/** Keychain item name of the PIN pepper. */
export const PIN_PEPPER_NAME = 'pin-pepper';

/**
 * Read the PIN pepper from the store, creating it on demand.
 *
 * @returns the 32-byte pepper, or `undefined` when absent and `create` is false.
 */
export async function pinPepper(store: SecretStore, create: boolean): Promise<Buffer | undefined> {
  const existing = await store.get(PIN_PEPPER_NAME);
  if (existing !== undefined) return Buffer.from(existing, 'base64url');
  if (!create) return undefined;
  const value = randomBytes(32).toString('base64url');
  await store.set(PIN_PEPPER_NAME, value);
  return Buffer.from(value, 'base64url');
}
