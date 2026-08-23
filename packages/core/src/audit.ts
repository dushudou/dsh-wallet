/**
 * Append-only JSONL audit log for every security-relevant event.
 *
 * Entries contain addresses, decisions, rule ids, and tx hashes - never key
 * material. Every write passes through {@link assertNoSecrets} so a coding
 * mistake cannot silently persist a secret.
 *
 * @module @dsh-wallet/core/audit
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNoSecrets, type SecretLike } from './redact.js';

/** One audit entry. */
export interface AuditEntry {
  /** Epoch ms. */
  ts: number;
  /** Entry kind: `account.created`, `sign.decision`, `vault.unlocked`, … */
  kind: string;
  /** Free-form, secret-free details. */
  detail: Record<string, unknown>;
}

/** Whether an entry is allowed into the audit log. */
export function isSecretFreeEntry(entry: AuditEntry, secrets: readonly SecretLike[]): boolean {
  try {
    assertNoSecrets(entry, secrets);
    return true;
  } catch {
    return false;
  }
}

/** Daily-rotating JSONL audit writer. */
export class AuditLog {
  private readonly directory: string;

  constructor(vaultDirectory: string) {
    this.directory = join(vaultDirectory, 'audit');
  }

  private fileFor(ts: number): string {
    const day = new Date(ts).toISOString().slice(0, 10);
    return join(this.directory, `audit-${day}.jsonl`);
  }

  /**
   * Append one entry. Refuses (throws) when the entry would contain key
   * material - the caller treats that as a bug, not an audit failure.
   */
  async append(entry: AuditEntry, secrets: readonly SecretLike[] = []): Promise<void> {
    if (!isSecretFreeEntry(entry, secrets)) {
      throw new Error(`audit entry of kind "${entry.kind}" would contain key material; refusing to write`);
    }
    await mkdir(this.directory, { recursive: true });
    await appendFile(this.fileFor(entry.ts), `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** Read recent entries (newest first) across the last `days` files. */
  async recent(days = 1, limit = 50): Promise<AuditEntry[]> {
    const { readFile } = await import('node:fs/promises');
    const entries: AuditEntry[] = [];
    const today = new Date();
    for (let offset = 0; offset < days; offset += 1) {
      const day = new Date(today.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
      try {
        const raw = await readFile(join(this.directory, `audit-${day}.jsonl`), 'utf8');
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (trimmed === '') continue;
          try {
            entries.push(JSON.parse(trimmed) as AuditEntry);
          } catch {
            // Skip malformed line rather than dropping the whole day.
          }
        }
      } catch {
        // Missing day file - fine.
      }
    }
    return entries.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }
}
