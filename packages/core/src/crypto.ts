/**
 * KDF + authenticated-encryption envelope for secrets at rest.
 *
 * Format (version 1): scrypt(passphrase, salt) -> AES-256-GCM(key, iv, aad).
 * GCM gives authenticated encryption: any tampering with the cipher text,
 * IV, tag, or AAD fails decryption instead of silently corrupting a key.
 *
 * @module @dsh-wallet/core/crypto
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** Scrypt parameters. Defaults cost ~100-200 ms on a modern laptop. */
export interface KdfParams {
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_KDF_PARAMS: KdfParams = { N: 32768, r: 8, p: 1 };

const SCRYPT_MAXMEM = 128 * 32768 * 8 * 2; // comfortably above 128 * N * r

/** Envelope persisted to disk. `salt`, `iv`, `tag`, `cipherText` are hex. */
export interface KeystoreEnvelope {
  version: 1;
  kdf: { name: 'scrypt'; n: number; r: number; p: number; salt: string };
  cipher: { name: 'aes-256-gcm'; iv: string; tag: string };
  /** Hex-encoded encrypted payload. */
  cipherText: string;
  /** Additional authenticated data bound into the GCM tag. */
  aad: string;
}

/** Derive the AES-256 key from passphrase + salt with the given parameters. */
async function deriveKey(passphrase: string, salt: Buffer, params: KdfParams): Promise<Buffer> {
  return scrypt(passphrase.normalize('NFKC'), salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: Math.max(SCRYPT_MAXMEM, 128 * params.N * params.r * 2),
  });
}

/** Encrypt a UTF-8 secret string into a tamper-evident envelope. */
export async function encryptSecret(
  plaintext: string,
  passphrase: string,
  options: { aad?: string; kdf?: KdfParams } = {},
): Promise<KeystoreEnvelope> {
  const kdf = options.kdf ?? DEFAULT_KDF_PARAMS;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const aad = options.aad ?? '';
  const key = await deriveKey(passphrase, salt, kdf);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    kdf: { name: 'scrypt', n: kdf.N, r: kdf.r, p: kdf.p, salt: salt.toString('hex') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('hex'), tag: tag.toString('hex') },
    cipherText: encrypted.toString('hex'),
    aad,
  };
}

/** Thrown when the passphrase is wrong or the envelope was tampered with. */
export class DecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptError';
  }
}

/** Decrypt an envelope back into the UTF-8 secret string. */
export async function decryptSecret(envelope: KeystoreEnvelope, passphrase: string): Promise<string> {
  if (envelope.version !== 1) throw new DecryptError(`unsupported keystore version ${String(envelope.version)}`);
  if (envelope.kdf.name !== 'scrypt') throw new DecryptError(`unsupported kdf ${envelope.kdf.name}`);
  if (envelope.cipher.name !== 'aes-256-gcm') throw new DecryptError(`unsupported cipher ${envelope.cipher.name}`);
  const salt = Buffer.from(envelope.kdf.salt, 'hex');
  const iv = Buffer.from(envelope.cipher.iv, 'hex');
  const tag = Buffer.from(envelope.cipher.tag, 'hex');
  const cipherText = Buffer.from(envelope.cipherText, 'hex');
  const key = await deriveKey(passphrase, salt, { N: envelope.kdf.n, r: envelope.kdf.r, p: envelope.kdf.p });
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(envelope.aad ?? '', 'utf8'));
  decipher.setAuthTag(tag);
  try {
    const plain = Buffer.concat([decipher.update(cipherText), decipher.final()]);
    return plain.toString('utf8');
  } catch (error) {
    throw new DecryptError(
      `decryption failed (wrong passphrase or tampered file): ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
}

/** Constant-time comparison of two hex strings; rejects length mismatch. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
