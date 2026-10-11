/**
 * Address book: human labels for counterparties.
 *
 * Lets a user say "send 5 USDC to Alice" and have the *wallet* — not the
 * model — resolve "Alice" to a stored address. Resolution is exact-label
 * only (case-insensitive); there is no fuzzy matching, because a near-miss
 * match is how funds reach the wrong person.
 *
 * @module dsh-web3-core/addressbook
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getAddress } from 'ethers';

/** One address-book entry. */
export interface AddressBookEntry {
  label: string;
  /** Checksummed address. */
  address: string;
  /** Optional free-form note. */
  note?: string;
  /** Restrict the entry to specific chains (all chains when omitted). */
  chainIds?: number[];
  /**
   * On the transfer whitelist. Only the settings panel sets this; a label
   * re-pointed at a different address always loses it.
   */
  trusted?: boolean;
  createdAt: string;
}

interface AddressBookFile {
  version: 1;
  entries: AddressBookEntry[];
}

/** Label -> address store backed by `address-book.json`. */
export class AddressBook {
  private state: AddressBookFile = { version: 1, entries: [] };
  private readonly path: string;

  constructor(directory: string) {
    this.path = join(directory, 'address-book.json');
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as AddressBookFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('invalid address book');
      this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.state = { version: 1, entries: [] };
      else throw error;
    }
  }

  list(): AddressBookEntry[] {
    return this.state.entries.map((entry) => ({ ...entry }));
  }

  /** Exact (case-insensitive) label lookup, honoring per-entry chain scoping. */
  resolve(label: string, chainId?: number): AddressBookEntry | undefined {
    const wanted = label.trim().toLowerCase();
    const found = this.state.entries.find(
      (entry) =>
        entry.label.toLowerCase() === wanted &&
        (chainId === undefined || entry.chainIds === undefined || entry.chainIds.includes(chainId)),
    );
    return found === undefined ? undefined : { ...found };
  }

  /** Reverse lookup: the label stored for an address, if any. */
  labelFor(address: string): string | undefined {
    const wanted = address.toLowerCase();
    return this.state.entries.find((entry) => entry.address.toLowerCase() === wanted)?.label;
  }

  /** The entry stored under a label (case-insensitive), if any. */
  get(label: string): AddressBookEntry | undefined {
    const wanted = label.trim().toLowerCase();
    const found = this.state.entries.find((entry) => entry.label.toLowerCase() === wanted);
    return found === undefined ? undefined : { ...found };
  }

  /** Whether an address belongs to a trusted (whitelisted) contact. */
  isTrusted(address: string): boolean {
    const wanted = address.toLowerCase();
    return this.state.entries.some((entry) => entry.trusted === true && entry.address.toLowerCase() === wanted);
  }

  /**
   * Add or replace an entry (labels are unique, case-insensitive). `trusted`
   * omitted keeps the existing flag only while the address is unchanged.
   */
  async upsert(input: { label: string; address: string; note?: string; chainIds?: number[]; trusted?: boolean }): Promise<AddressBookEntry> {
    const label = input.label.trim();
    if (label.length === 0 || label.length > 64) throw new Error('label must be 1-64 characters');
    if (/^0x[0-9a-fA-F]{40}$/.test(label) || label.includes('.')) {
      throw new Error('label must not look like an address or ENS name');
    }
    const address = getAddress(input.address);
    const previous = this.get(label);
    const sameAddress = previous !== undefined && previous.address === address;
    const trusted = input.trusted ?? (sameAddress && previous.trusted === true);
    const entry: AddressBookEntry = {
      label,
      address,
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.chainIds !== undefined ? { chainIds: input.chainIds.map(Number) } : {}),
      ...(trusted ? { trusted: true } : {}),
      createdAt: sameAddress ? previous.createdAt : new Date().toISOString(),
    };
    this.state.entries = [...this.state.entries.filter((existing) => existing.label.toLowerCase() !== label.toLowerCase()), entry];
    await this.persist();
    return { ...entry };
  }

  /** Set or clear the whitelist flag on an existing entry. */
  async setTrusted(label: string, trusted: boolean): Promise<AddressBookEntry> {
    const wanted = label.trim().toLowerCase();
    const found = this.state.entries.find((entry) => entry.label.toLowerCase() === wanted);
    if (found === undefined) throw new Error(`no contact labelled "${label}"`);
    const next: AddressBookEntry = { ...found };
    if (trusted) next.trusted = true;
    else delete next.trusted;
    this.state.entries = this.state.entries.map((entry) => (entry === found ? next : entry));
    await this.persist();
    return { ...next };
  }

  /** Remove by label; returns the removed entry. */
  async remove(label: string): Promise<AddressBookEntry | undefined> {
    const wanted = label.trim().toLowerCase();
    const found = this.state.entries.find((entry) => entry.label.toLowerCase() === wanted);
    if (found === undefined) return undefined;
    this.state.entries = this.state.entries.filter((entry) => entry !== found);
    await this.persist();
    return { ...found };
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${randomBytes(4).toString('hex')}`;
    await writeFile(tmp, `${JSON.stringify(this.state, undefined, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
