/**
 * Shared types for the dsh-wallet core library.
 *
 * @module @dsh-wallet/core/types
 */

/** How an account entered the vault. */
export type AccountSource =
  | 'generated'
  | 'imported-mnemonic'
  | 'imported-private-key'
  | 'imported-keystore';

/** Public, non-secret metadata for one vault account. Safe to display or log. */
export interface AccountMeta {
  /** Stable unique id (uuid v4). Key files are named after it. */
  id: string;
  /** Human label assigned at create/import time. */
  label: string;
  /** Checksummed EVM address (0x…). */
  address: string;
  /** Where the key material came from. */
  source: AccountSource;
  /** BIP-32 derivation path for HD accounts (m/44'/60'/0'/0/i). */
  derivationPath?: string;
  /** HD account index, when derived from a mnemonic. */
  index?: number;
  /** Groups accounts derived from the same mnemonic. */
  mnemonicId?: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Whether the user confirmed backing up the mnemonic (HD accounts). */
  backedUp?: boolean;
}

/** Vault index file (`vault.json`) - contains no secrets. */
export interface VaultIndex {
  version: 1;
  createdAt: string;
  updatedAt: string;
  accounts: AccountMeta[];
  activeAccountId?: string;
}

/** High-level vault status used by tools and the UI. */
export interface VaultStatus {
  /** Absolute path of the vault directory. */
  directory: string;
  /** Whether decrypted key material currently sits in memory. */
  unlocked: boolean;
  /** Milliseconds since the last unlock-key use (null when locked). */
  idleMs?: number;
  /** Configured auto-lock interval in milliseconds. */
  autoLockMs: number;
  accountCount: number;
  policySummary: {
    defaultEffect: import('./policy/types.js').PolicyEffect;
    ruleCount: number;
    updatedAt: string;
  };
  vaultCreatedAt: string;
}
