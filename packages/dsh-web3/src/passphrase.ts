/**
 * Vault passphrase resolution.
 *
 * Passphrases NEVER travel through tool arguments (they are session-logged).
 * The resolution chain, in order:
 *
 * 1. the `DSH_WALLET_PASSPHRASE` environment variable;
 * 2. the OS keychain (macOS), when available;
 * 3. the harness `credentials` service (env + `$DSH_HOME/.credentials.yaml`
 *    + `.env` layers) under the ref `DSH_WALLET_PASSPHRASE` — a value from the
 *    plaintext file is migrated into the keychain on first read;
 * 4. in `auto` mode only, while the vault has no accounts: generate a strong
 *    random passphrase and store it in the keychain (else credentials).
 *
 * A `passphraseFile` path (read once, then deleted) is accepted by the
 * unlock tool for manual workflows.
 *
 * @module dsh-web3/passphrase
 */

import { randomBytes } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import type { SecretStore } from './keychain.js';

/** The credential ref used by every layer. */
export const WALLET_PASSPHRASE_REF = 'DSH_WALLET_PASSPHRASE';

/** What the credentials service must look like (subset). */
export interface CredentialsLike {
  resolve(ref: string): Promise<{ value?: string; source?: string } | undefined>;
  set(ref: string, value: string): Promise<void>;
  /** Remove a stored reference (used after migrating it to the keychain). */
  unset?(ref: string): Promise<void>;
}

export type PassphraseMode = 'auto' | 'env' | 'manual';

/** Result of a resolution attempt. */
export interface ResolvedPassphrase {
  passphrase: string;
  source: 'env' | 'keychain' | 'credentials' | 'generated' | 'file';
  /** Set when the passphrase was just moved out of the plaintext credentials file. */
  migrated?: boolean;
}

/** Read a passphrase from a file; the file is deleted after a successful read. */
export async function passphraseFromFile(path: string): Promise<string> {
  const info = await stat(path);
  if (info.mode & 0o077) {
    throw new Error(
      `passphrase file ${path} is readable by group/other; refusing to read it. Run: chmod 600 "${path}"`,
    );
  }
  const value = (await readFile(path, 'utf8')).trim();
  if (value.length === 0) throw new Error(`passphrase file ${path} is empty`);
  await rm(path, { force: true });
  return value;
}

/**
 * Resolve the vault passphrase.
 *
 * Order: environment → OS keychain → harness credentials → generate (`auto`).
 * A passphrase found in the plaintext credentials file is moved into the
 * keychain (verified, then unset from the file) when a keychain is available.
 * Generation is refused once the vault holds accounts: a store that failed to
 * answer must never be "fixed" by minting a passphrase that cannot decrypt
 * the existing keys.
 *
 * @param mode - passphrase mode from plugin config.
 * @param env - the host process environment (`DSH_WALLET_PASSPHRASE`).
 * @param credentials - the harness credentials service, when mounted.
 * @param options - `keychain` store and whether generating is allowed.
 * @returns the passphrase and where it came from.
 */
export async function resolvePassphrase(
  mode: PassphraseMode,
  env: Record<string, string | undefined>,
  credentials: CredentialsLike | undefined,
  options: { keychain?: SecretStore; allowGenerate?: boolean } = {},
): Promise<ResolvedPassphrase> {
  const { keychain, allowGenerate = true } = options;
  const fromEnv = env[WALLET_PASSPHRASE_REF];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return { passphrase: fromEnv, source: 'env' };
  }
  if (keychain !== undefined) {
    // A keychain error propagates: falling through could end in generation.
    const stored = await keychain.get(WALLET_PASSPHRASE_REF);
    if (stored !== undefined) return { passphrase: stored, source: 'keychain' };
  }
  if (credentials !== undefined) {
    let resolved: { value?: string; source?: string } | undefined;
    try {
      resolved = await credentials.resolve(WALLET_PASSPHRASE_REF);
    } catch {
      resolved = undefined;
    }
    if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) {
      if (keychain !== undefined && resolved.source === 'file') {
        await keychain.set(WALLET_PASSPHRASE_REF, resolved.value);
        await credentials.unset?.(WALLET_PASSPHRASE_REF);
        return { passphrase: resolved.value, source: 'keychain', migrated: true };
      }
      return { passphrase: resolved.value, source: 'credentials' };
    }
  }
  if (mode === 'auto') {
    if (!allowGenerate) {
      throw new Error(
        `vault passphrase not found (${WALLET_PASSPHRASE_REF}) but the vault already holds accounts; restore it in the keychain, credentials, or environment — a new one cannot decrypt existing keys`,
      );
    }
    const generated = randomBytes(32).toString('base64url');
    if (keychain !== undefined) {
      await keychain.set(WALLET_PASSPHRASE_REF, generated);
    } else if (credentials !== undefined) {
      await credentials.set(WALLET_PASSPHRASE_REF, generated);
    }
    return { passphrase: generated, source: 'generated' };
  }
  throw new Error(
    `no vault passphrase configured: set the ${WALLET_PASSPHRASE_REF} environment variable, add it to the harness credentials, or use mode "auto"`,
  );
}
