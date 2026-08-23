/**
 * Vault passphrase resolution.
 *
 * Passphrases NEVER travel through tool arguments (they are session-logged).
 * The resolution chain, in order:
 *
 * 1. the `DSH_WALLET_PASSPHRASE` environment variable;
 * 2. the harness `credentials` service (env + `$DSH_HOME/.credentials.yaml`
 *    + `.env` layers) under the ref `DSH_WALLET_PASSPHRASE`;
 * 3. in `auto` mode only: generate a strong random passphrase and store it
 *    in the credentials service on first use.
 *
 * A `passphraseFile` path (read once, then deleted) is accepted by the
 * unlock tool for manual workflows.
 *
 * @module @dsh-wallet/plugin/passphrase
 */

import { randomBytes } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';

/** The credential ref used by every layer. */
export const WALLET_PASSPHRASE_REF = 'DSH_WALLET_PASSPHRASE';

/** What the credentials service must look like (subset). */
export interface CredentialsLike {
  resolve(ref: string): Promise<{ value?: string } | undefined>;
  set(ref: string, value: string): Promise<void>;
}

export type PassphraseMode = 'auto' | 'env' | 'manual';

/** Result of a resolution attempt. */
export interface ResolvedPassphrase {
  passphrase: string;
  source: 'env' | 'credentials' | 'generated' | 'file';
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
 * @param mode - passphrase mode from plugin config.
 * @param env - the host process environment (`DSH_WALLET_PASSPHRASE`).
 * @param credentials - the harness credentials service, when mounted.
 * @returns the passphrase and where it came from.
 */
export async function resolvePassphrase(
  mode: PassphraseMode,
  env: Record<string, string | undefined>,
  credentials: CredentialsLike | undefined,
): Promise<ResolvedPassphrase> {
  const fromEnv = env[WALLET_PASSPHRASE_REF];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return { passphrase: fromEnv, source: 'env' };
  }
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(WALLET_PASSPHRASE_REF);
      if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) {
        return { passphrase: resolved.value, source: 'credentials' };
      }
    } catch {
      // fall through to generation
    }
  }
  if (mode === 'auto') {
    const generated = randomBytes(32).toString('base64url');
    if (credentials !== undefined) {
      await credentials.set(WALLET_PASSPHRASE_REF, generated);
    }
    return { passphrase: generated, source: 'generated' };
  }
  throw new Error(
    `no vault passphrase configured: set the ${WALLET_PASSPHRASE_REF} environment variable, add it to the harness credentials, or use mode "auto"`,
  );
}
