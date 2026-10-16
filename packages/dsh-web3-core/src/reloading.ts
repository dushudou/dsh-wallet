/**
 * A JSON state file kept in memory that follows the file on disk.
 *
 * The vault is shared by every process that opens the same directory: the DSH
 * host, a CLI run, a second plugin instance. Each of them writes whole files
 * (atomic rename). An in-memory copy taken once at open goes stale the moment
 * another process adds an account or changes a limit, so reads re-check the
 * file's identity (inode, size, mtime) and re-parse it when it changed.
 *
 * A file that fails to parse or validate keeps the last good value; the next
 * change retries. Writers update the value in memory and then write the file,
 * so the in-process view never lags its own writes.
 *
 * @module dsh-web3-core/reloading
 */

import { readFileSync, statSync } from 'node:fs';

/** A value backed by one JSON file, re-read when the file changes on disk. */
export class ReloadingState<T> {
  private value: T;
  private stamp: string | undefined;

  constructor(
    private readonly path: string,
    initial: T,
    private readonly parse: (raw: unknown) => T,
  ) {
    this.value = initial;
    this.stamp = stampOf(path);
  }

  /** Current value, after picking up any change made by another process. */
  get(): T {
    const stamp = stampOf(this.path);
    if (stamp === undefined || stamp === this.stamp) return this.value;
    try {
      const next = this.parse(JSON.parse(readFileSync(this.path, 'utf8')));
      this.value = next;
      this.stamp = stamp;
    } catch {
      // Keep the last good value; the next change to the file retries.
    }
    return this.value;
  }

  /** Replace the in-memory value. The caller writes the file afterwards. */
  set(next: T): void {
    this.value = next;
  }
}

/** Identity of the file's current revision, or undefined when it is missing. */
function stampOf(path: string): string | undefined {
  try {
    const info = statSync(path);
    return `${String(info.ino)}:${String(info.size)}:${String(info.mtimeMs)}`;
  } catch {
    return undefined;
  }
}
