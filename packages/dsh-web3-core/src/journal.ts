/**
 * Local transaction journal: every transaction this wallet signed, with its
 * lifecycle status.
 *
 * The journal is what makes agent retries safe. A transaction is journaled
 * (with its hash) *before* broadcast, so a timeout or crash mid-broadcast
 * leaves a record the agent can query instead of blindly re-sending and
 * paying twice. It also backs status lookups, history, and speed-up/cancel
 * (which need the original nonce, calldata, and fees).
 *
 * Contains no secrets: only public transaction fields.
 *
 * @module dsh-web3-core/journal
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Intent } from './intent.js';

/** Lifecycle of a journaled transaction. */
export type JournalStatus =
  /** Accepted by the node, not yet mined. */
  | 'pending'
  /** Broadcast outcome unknown (network error after signing) — check before retrying. */
  | 'unknown'
  /** Explicitly rejected by the node; never entered the mempool. */
  | 'rejected'
  | 'success'
  | 'reverted'
  /** Superseded by a speed-up / cancel with the same nonce. */
  | 'replaced';

/** One journaled transaction. */
export interface JournalEntry {
  hash: string;
  chainId: number;
  from: string;
  to: string;
  nonce: number;
  valueWei: string;
  /** Full calldata (needed to re-sign a speed-up). */
  data: string;
  type: 0 | 2;
  gasLimit: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
  intent?: Intent;
  /** Human one-liner ("Send 5 USDC to 0x…"). */
  summary?: string;
  status: JournalStatus;
  /** Epoch ms when signed. */
  submittedAt: number;
  /** Epoch ms of the last status change. */
  updatedAt: number;
  blockNumber?: number;
  gasUsed?: string;
  /** Hash of the transaction that replaced this one. */
  replacedBy?: string;
  /** Hash of the transaction this one replaces (speed-up / cancel). */
  replaces?: string;
  /** Caller-supplied idempotency key: a repeat request returns this entry. */
  idempotencyKey?: string;
  /** Node error message for `rejected` / `unknown`. */
  error?: string;
}

interface JournalFile {
  version: 1;
  entries: JournalEntry[];
}

/** Keep the journal bounded. */
const MAX_ENTRIES = 1000;

/** Append/update store for signed transactions, backed by `tx-journal.json`. */
export class TxJournal {
  private state: JournalFile = { version: 1, entries: [] };
  private readonly path: string;

  constructor(directory: string) {
    this.path = join(directory, 'tx-journal.json');
  }

  /** Load from disk (missing file is an empty journal). */
  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as JournalFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('invalid tx journal');
      this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.state = { version: 1, entries: [] };
      else throw error;
    }
  }

  /** Record a newly signed transaction. */
  async add(entry: Omit<JournalEntry, 'updatedAt'>): Promise<JournalEntry> {
    const full: JournalEntry = { ...entry, updatedAt: entry.submittedAt };
    this.state.entries = [...this.state.entries.filter((existing) => existing.hash !== entry.hash), full].slice(-MAX_ENTRIES);
    await this.persist();
    return { ...full };
  }

  /** Patch an entry by hash; returns the updated entry. */
  async update(hash: string, patch: Partial<Omit<JournalEntry, 'hash'>>): Promise<JournalEntry | undefined> {
    const index = this.state.entries.findIndex((entry) => entry.hash.toLowerCase() === hash.toLowerCase());
    if (index < 0) return undefined;
    const next: JournalEntry = { ...this.state.entries[index]!, ...patch, updatedAt: Date.now() };
    this.state.entries[index] = next;
    await this.persist();
    return { ...next };
  }

  /** Look up by hash (case-insensitive). */
  get(hash: string): JournalEntry | undefined {
    const found = this.state.entries.find((entry) => entry.hash.toLowerCase() === hash.toLowerCase());
    return found === undefined ? undefined : { ...found };
  }

  /** Look up the entry created for an idempotency key. */
  byIdempotencyKey(key: string): JournalEntry | undefined {
    const found = [...this.state.entries].reverse().find((entry) => entry.idempotencyKey === key);
    return found === undefined ? undefined : { ...found };
  }

  /** Newest-first listing with optional filters. */
  list(filter: { from?: string; chainId?: number; limit?: number } = {}): JournalEntry[] {
    const from = filter.from?.toLowerCase();
    return [...this.state.entries]
      .reverse()
      .filter((entry) => (from === undefined || entry.from.toLowerCase() === from) && (filter.chainId === undefined || entry.chainId === filter.chainId))
      .slice(0, filter.limit ?? 20)
      .map((entry) => ({ ...entry }));
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${randomBytes(4).toString('hex')}`;
    await writeFile(tmp, `${JSON.stringify(this.state, undefined, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
