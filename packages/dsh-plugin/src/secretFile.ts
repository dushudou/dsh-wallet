/**
 * Secret-file intake: the only way key material enters the wallet from a
 * tool call. Files are read once and deleted immediately, so secrets never
 * sit in tool arguments (which are session-logged).
 *
 * @module @dsh-wallet/plugin/secretFile
 */

import { readFile, rm, stat } from 'node:fs/promises';

/**
 * Read a secret from a file and delete it.
 *
 * @param path - absolute path to a 0600 file containing the secret.
 * @returns the trimmed file contents.
 * @throws when the file is missing, empty, or group/world-readable.
 */
export async function readSecretFile(path: string): Promise<string> {
  const info = await stat(path).catch(() => {
    throw new Error(`secret file not found: ${path}`);
  });
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new Error(
      `secret file ${path} is readable by group/other; refusing to read it. Run: chmod 600 "${path}"`,
    );
  }
  const value = (await readFile(path, 'utf8')).trim();
  await rm(path, { force: true });
  if (value.length === 0) throw new Error(`secret file ${path} was empty (and has been deleted)`);
  return value;
}
