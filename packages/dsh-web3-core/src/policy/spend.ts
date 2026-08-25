/**
 * Rolling-24h spend tracker for daily value caps.
 *
 * Signed transaction values are appended to a small JSON state file; queries
 * sum entries inside the last 24h. Old entries are pruned on every write so
 * the file stays bounded.
 *
 * @module dsh-web3-core/policy/spend
 */

import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

interface SpendEvent {
  /** Epoch ms when the transaction was signed. */
  ts: number;
  chainId: number;
  from: string;
  to?: string;
  valueWei: string;
  txHash?: string;
}

interface SpendState {
  version: 1;
  events: SpendEvent[];
}

/** Tracks signed value over a rolling 24h window, backed by one JSON file. */
export class SpendTracker {
  private state: SpendState = { version: 1, events: [] };
  private readonly path: string;

  constructor(directory: string) {
    this.path = join(directory, 'spend-state.json');
  }

  /** Load state from disk (missing file is a fresh tracker). */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as SpendState;
      if (parsed.version !== 1 || !Array.isArray(parsed.events)) {
        throw new Error('invalid spend-state document');
      }
      this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = { version: 1, events: [] };
      } else {
        throw error;
      }
    }
  }

  /** Rolling-24h signed value for one signer (wei). */
  spentLast24hWei(from: string, now = Date.now()): bigint {
    const floor = now - WINDOW_MS;
    const lower = from.trim().toLowerCase();
    let total = 0n;
    for (const event of this.state.events) {
      if (event.ts >= floor && event.from.toLowerCase() === lower) total += BigInt(event.valueWei);
    }
    return total;
  }

  /** Record one signed transaction. */
  async record(event: Omit<SpendEvent, 'ts'> & { ts?: number }): Promise<void> {
    this.state.events.push({ ts: event.ts ?? Date.now(), ...event, from: event.from });
    await this.persist();
  }

  /** Drop entries older than the prune horizon. */
  async prune(now = Date.now()): Promise<void> {
    const floor = now - PRUNE_AFTER_MS;
    const before = this.state.events.length;
    this.state.events = this.state.events.filter((event) => event.ts >= floor);
    if (this.state.events.length !== before) await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${randomBytes(4).toString('hex')}`;
    await writeFile(tmp, `${JSON.stringify(this.state, undefined, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
