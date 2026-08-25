import { describe, expect, it } from 'vitest';
import { DecryptError, decryptSecret, encryptSecret } from '../src/crypto.js';

describe('keystore crypto envelope', () => {
  it('round-trips a secret', async () => {
    const envelope = await encryptSecret('super secret key material', 'correct horse battery staple', { aad: 'account-1' });
    expect(envelope.version).toBe(1);
    expect(envelope.kdf.name).toBe('scrypt');
    expect(envelope.cipher.name).toBe('aes-256-gcm');
    const plain = await decryptSecret(envelope, 'correct horse battery staple');
    expect(plain).toBe('super secret key material');
  });

  it('rejects the wrong passphrase', async () => {
    const envelope = await encryptSecret('secret', 'pass-one');
    await expect(decryptSecret(envelope, 'pass-two')).rejects.toBeInstanceOf(DecryptError);
  });

  it('detects cipher-text tampering', async () => {
    const envelope = await encryptSecret('secret', 'pass', { aad: 'acct' });
    const tampered = { ...envelope, cipherText: `0f${envelope.cipherText.slice(2)}` };
    if (tampered.cipherText === envelope.cipherText) return; // first byte already 0f
    await expect(decryptSecret(tampered, 'pass')).rejects.toBeInstanceOf(DecryptError);
  });

  it('detects AAD substitution (renamed account file)', async () => {
    const envelope = await encryptSecret('secret', 'pass', { aad: 'account-1' });
    const swapped = { ...envelope, aad: 'account-2' };
    await expect(decryptSecret(swapped, 'pass')).rejects.toBeInstanceOf(DecryptError);
  });

  it('uses fresh random salt and iv every time', async () => {
    const a = await encryptSecret('same secret', 'same pass');
    const b = await encryptSecret('same secret', 'same pass');
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
    expect(a.cipherText).not.toBe(b.cipherText);
  });

  it('rejects unsupported envelope versions', async () => {
    const envelope = await encryptSecret('secret', 'pass');
    await expect(decryptSecret({ ...envelope, version: 99 as unknown as 1 }, 'pass')).rejects.toBeInstanceOf(DecryptError);
  });
});
