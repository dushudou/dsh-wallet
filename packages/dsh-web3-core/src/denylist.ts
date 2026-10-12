/**
 * Address denylist: addresses the wallet refuses to pay or grant permissions to.
 *
 * Two sources, both local at decision time:
 *
 * - **user entries** (`denylist.json`): added by the user or the agent
 *   (adding only ever tightens, so the agent may do it), removed only from
 *   the settings panel.
 * - **feeds** (`denylist-feeds.json`): public lists downloaded and cached —
 *   the OFAC SDN Ethereum addresses and the ScamSniffer scam database.
 *   Lookups never touch the network; a refresh that fails or yields nothing
 *   keeps the previous cache, so a broken or emptied feed cannot silently
 *   disable protection.
 *
 * @module dsh-web3-core/denylist
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getAddress } from 'ethers';
import type { DenylistFeedId } from './security.js';

/** Why an address is denied. */
export type DenylistCategory = 'sanctioned' | 'scam' | 'user';

/** One user-managed entry. */
export interface DenylistEntry {
  /** Checksummed address. */
  address: string;
  category: DenylistCategory;
  label?: string;
  note?: string;
  addedAt: string;
}

/** A positive lookup. */
export interface DenylistHit {
  address: string;
  category: DenylistCategory;
  /** `user`, or the feed id. */
  source: 'user' | DenylistFeedId;
  label?: string;
  note?: string;
}

/** A downloadable feed. */
export interface DenylistFeedSpec {
  id: DenylistFeedId;
  name: string;
  url: string;
  category: DenylistCategory;
}

/** Built-in feeds (plain JSON arrays of 0x addresses). */
export const DENYLIST_FEEDS: readonly DenylistFeedSpec[] = [
  {
    id: 'ofac',
    name: 'OFAC SDN (Ethereum addresses)',
    url: 'https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.json',
    category: 'sanctioned',
  },
  {
    id: 'scamsniffer',
    name: 'ScamSniffer scam database',
    url: 'https://raw.githubusercontent.com/scamsniffer/scam-database/main/blacklist/address.json',
    category: 'scam',
  },
];

/** Cached state of one feed. */
export interface FeedState {
  fetchedAt?: string;
  lastAttemptAt?: string;
  count: number;
  error?: string;
}

interface UserFile {
  version: 1;
  entries: DenylistEntry[];
}

interface FeedFile {
  version: 1;
  feeds: Partial<Record<DenylistFeedId, FeedState & { addresses: string[] }>>;
}

/** Minimal `fetch` shape (injectable for tests). */
export type FeedFetcher = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FEED_BYTES = 20 * 1024 * 1024;
const MAX_FEED_ENTRIES = 500_000;
const FEED_TIMEOUT_MS = 20_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Parse a feed body: a JSON array of strings, or one address per line. */
export function parseFeed(body: string): string[] {
  let items: unknown[];
  const trimmed = body.trim();
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('feed is not a JSON array');
    items = parsed;
  } else {
    items = trimmed.split(/\r?\n/);
  }
  const out = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const candidate = item.trim();
    if (ADDRESS.test(candidate)) out.add(candidate.toLowerCase());
    if (out.size > MAX_FEED_ENTRIES) throw new Error(`feed has more than ${String(MAX_FEED_ENTRIES)} entries`);
  }
  return [...out];
}

/** The denylist store (user entries + cached feeds). */
export class Denylist {
  private user: UserFile = { version: 1, entries: [] };
  private feedFile: FeedFile = { version: 1, feeds: {} };
  private feedSets = new Map<DenylistFeedId, Set<string>>();
  private readonly userPath: string;
  private readonly feedPath: string;

  constructor(directory: string) {
    this.userPath = join(directory, 'denylist.json');
    this.feedPath = join(directory, 'denylist-feeds.json');
  }

  async load(): Promise<void> {
    this.user = (await readJson<UserFile>(this.userPath)) ?? { version: 1, entries: [] };
    if (this.user.version !== 1 || !Array.isArray(this.user.entries)) throw new Error('invalid denylist.json');
    // A corrupt feed cache is only a cache: start empty and re-download.
    const feeds = await readJson<FeedFile>(this.feedPath).catch(() => undefined);
    this.feedFile = feeds !== undefined && feeds.version === 1 && feeds.feeds !== null && typeof feeds.feeds === 'object' ? feeds : { version: 1, feeds: {} };
    this.feedSets.clear();
    for (const [id, state] of Object.entries(this.feedFile.feeds) as Array<[DenylistFeedId, FeedState & { addresses: string[] }]>) {
      if (Array.isArray(state?.addresses)) this.feedSets.set(id, new Set(state.addresses.map((address) => address.toLowerCase())));
    }
  }

  /**
   * Look an address up: user entries first, then each *enabled* feed.
   *
   * @param enabled - which feeds count (disabled feeds are ignored).
   */
  lookup(address: string, enabled: Partial<Record<DenylistFeedId, boolean>>): DenylistHit | undefined {
    const lower = address.toLowerCase();
    const entry = this.user.entries.find((candidate) => candidate.address.toLowerCase() === lower);
    if (entry !== undefined) {
      return {
        address: entry.address,
        category: entry.category,
        source: 'user',
        ...(entry.label !== undefined ? { label: entry.label } : {}),
        ...(entry.note !== undefined ? { note: entry.note } : {}),
      };
    }
    for (const spec of DENYLIST_FEEDS) {
      if (enabled[spec.id] !== true) continue;
      if (this.feedSets.get(spec.id)?.has(lower) === true) return { address: safeChecksum(address), category: spec.category, source: spec.id };
    }
    return undefined;
  }

  /** User entries. */
  list(): DenylistEntry[] {
    return this.user.entries.map((entry) => ({ ...entry }));
  }

  /** Add (or update the label/note of) a user entry. */
  async add(input: { address: string; label?: string; note?: string; category?: DenylistCategory }): Promise<DenylistEntry> {
    const address = getAddress(input.address);
    const label = input.label?.trim();
    if (label !== undefined && label.length > 64) throw new Error('label must be at most 64 characters');
    const existing = this.user.entries.find((entry) => entry.address === address);
    const entry: DenylistEntry = {
      address,
      category: input.category ?? existing?.category ?? 'user',
      ...(label !== undefined && label !== '' ? { label } : existing?.label !== undefined ? { label: existing.label } : {}),
      ...(input.note !== undefined ? { note: input.note.slice(0, 280) } : existing?.note !== undefined ? { note: existing.note } : {}),
      addedAt: existing?.addedAt ?? new Date().toISOString(),
    };
    this.user.entries = [...this.user.entries.filter((candidate) => candidate.address !== address), entry];
    await writePrivate(this.userPath, this.user);
    return { ...entry };
  }

  /** Remove a user entry (feeds are not editable). */
  async remove(address: string): Promise<DenylistEntry | undefined> {
    const lower = address.toLowerCase();
    const found = this.user.entries.find((entry) => entry.address.toLowerCase() === lower);
    if (found === undefined) return undefined;
    this.user.entries = this.user.entries.filter((entry) => entry !== found);
    await writePrivate(this.userPath, this.user);
    return { ...found };
  }

  /** Per-feed cache status (secret-free, no address lists). */
  feedStatus(): Array<DenylistFeedSpec & FeedState> {
    return DENYLIST_FEEDS.map((spec) => {
      const state = this.feedFile.feeds[spec.id];
      return {
        ...spec,
        count: state?.count ?? 0,
        ...(state?.fetchedAt !== undefined ? { fetchedAt: state.fetchedAt } : {}),
        ...(state?.lastAttemptAt !== undefined ? { lastAttemptAt: state.lastAttemptAt } : {}),
        ...(state?.error !== undefined ? { error: state.error } : {}),
      };
    });
  }

  /**
   * Download enabled feeds that are older than `maxAgeMs` (or all, with
   * `force`). A failed or empty download keeps the previous list.
   */
  async refreshFeeds(options: {
    enabled: Partial<Record<DenylistFeedId, boolean>>;
    fetcher?: FeedFetcher;
    maxAgeMs?: number;
    force?: boolean;
  }): Promise<Array<DenylistFeedSpec & FeedState>> {
    const fetcher = options.fetcher ?? (globalThis.fetch as unknown as FeedFetcher | undefined);
    if (fetcher === undefined) throw new Error('no fetch implementation available');
    const maxAge = options.maxAgeMs ?? DAY_MS;
    const now = Date.now();
    let changed = false;
    for (const spec of DENYLIST_FEEDS) {
      if (options.enabled[spec.id] !== true) continue;
      const previous = this.feedFile.feeds[spec.id];
      const fresh = previous?.fetchedAt !== undefined && now - Date.parse(previous.fetchedAt) < maxAge;
      if (fresh && options.force !== true) continue;
      const attemptAt = new Date(now).toISOString();
      try {
        const response = await fetcher(spec.url, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
        const body = await response.text();
        if (body.length > MAX_FEED_BYTES) throw new Error('feed is too large');
        const addresses = parseFeed(body);
        if (addresses.length === 0) throw new Error('feed contained no addresses; keeping the previous list');
        this.feedFile.feeds[spec.id] = { addresses, count: addresses.length, fetchedAt: attemptAt, lastAttemptAt: attemptAt };
        this.feedSets.set(spec.id, new Set(addresses));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.feedFile.feeds[spec.id] = {
          addresses: previous?.addresses ?? [],
          count: previous?.count ?? 0,
          ...(previous?.fetchedAt !== undefined ? { fetchedAt: previous.fetchedAt } : {}),
          lastAttemptAt: attemptAt,
          error: message,
        };
      }
      changed = true;
    }
    if (changed) await writePrivate(this.feedPath, this.feedFile);
    return this.feedStatus();
  }
}

function safeChecksum(address: string): string {
  try {
    return getAddress(address.toLowerCase());
  } catch {
    return address;
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}
