/**
 * Secret redaction and leak prevention.
 *
 * The wallet's last line of defense for "never leak key material": tool
 * results and audit entries pass through {@link assertNoSecrets} before they
 * leave the vault, which scans every string for exact matches of the live
 * secrets. Strings that merely look like keys are masked by
 * {@link redactHexLike}.
 *
 * @module @dsh-wallet/core/redact
 */

/** A raw secret: hex string (with or without 0x), mnemonic phrase, or bytes. */
export type SecretLike = string | Uint8Array;

const HEX_0X = /^0x[0-9a-fA-F]*$/;
const HEX_BARE = /^[0-9a-fA-F]+$/;

function secretVariants(secret: SecretLike): string[] {
  if (typeof secret === 'string') {
    const variants = new Set<string>();
    const trimmed = secret.trim();
    variants.add(trimmed);
    if (HEX_0X.test(trimmed)) {
      variants.add(trimmed.slice(2)); // bare hex
      variants.add(trimmed.toLowerCase());
      variants.add(trimmed.slice(2).toLowerCase());
    }
    return [...variants].filter((variant) => variant.length >= 16);
  }
  const hex = Buffer.from(secret).toString('hex');
  return [hex, `0x${hex}`].filter((variant) => variant.length >= 16);
}

/** Collect every candidate secret form (private key, mnemonic, both cases). */
export function collectSecretVariants(secrets: readonly SecretLike[]): string[] {
  const variants: string[] = [];
  for (const secret of secrets) variants.push(...secretVariants(secret));
  return variants;
}

/** Deep-walk a JSON value and throw if any secret appears in a string field. */
export function assertNoSecrets(value: unknown, secrets: readonly SecretLike[], path = '$'): void {
  const variants = collectSecretVariants(secrets);
  scan(value, variants, path);
}

function scan(value: unknown, variants: string[], path: string): void {
  if (typeof value === 'string') {
    for (const variant of variants) {
      if (value.includes(variant)) {
        throw new Error(
          `secret leak detected at ${path}: refusing to return or persist a value containing key material`,
        );
      }
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) scan(value[i], variants, `${path}[${String(i)}]`);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    scan(child, variants, `${path}.${key}`);
  }
}

/** Mask a hex string for display: keeps the prefix and a short head/tail. */
export function maskHex(value: string, keep = 8): string {
  if (value.length <= keep * 2 + 4) return `${value.slice(0, 6)}…${value.slice(-4)}`;
  return `${value.slice(0, keep)}…${value.slice(-4)}`;
}

/** Mask an address for compact display: 0x1234…cdef. */
export function maskAddress(address: string): string {
  return maskHex(address, 6);
}

/** Replace anything that looks like a bare private key or mnemonic with [REDACTED]. */
export function redactHexLike(value: string): string {
  // 64 hex chars (bare or 0x-prefixed) is private-key shaped.
  const privateKeyLike = /\b(?:0x)?[0-9a-fA-F]{64}\b/g;
  return value.replace(privateKeyLike, '[REDACTED-HEX64]');
}

/** Strip key-shaped fields out of a shallow record (defense in depth). */
export function redactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (/privatekey|mnemonic|secret|passphrase|seed/i.test(key)) {
      out[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      out[key] = redactHexLike(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Whether a string looks like a 32-byte hex private key. */
export function looksLikePrivateKey(value: string): boolean {
  const trimmed = value.trim();
  return HEX_0X.test(trimmed) ? trimmed.length === 66 : HEX_BARE.test(trimmed) && trimmed.length === 64;
}
