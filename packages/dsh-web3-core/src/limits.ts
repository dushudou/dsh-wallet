/**
 * Hard wallet limits: the user's "never exceed" rules.
 *
 * The signing policy decides *who decides* (sign automatically, ask a human,
 * refuse). Limits sit on top of it and are absolute: a request that breaks a
 * limit is refused even if a rule would auto-sign it or the human clicks
 * "approve" — approval fatigue and prompt injection cannot talk past them.
 *
 * - `whitelistOnly`: direct transfers (native, token, NFT, payment
 *   authorizations) may only go to trusted contacts or the wallet's own
 *   accounts. Contract interactions are governed by the policy instead.
 * - `usd`: per-transaction / rolling-24h caps on known USD stablecoins
 *   (1 token = 1 USD), summed wallet-wide across chains.
 * - `native`: per-transaction / rolling-24h caps per native coin symbol
 *   (`ETH` covers every ETH-native chain), summed wallet-wide.
 *
 * Testnets are exempt unless `includeTestnets` is set. Limits are edited only
 * in the settings panel; model tools can read them but never loosen them.
 *
 * @module dsh-web3-core/limits
 */

import { parseUnits } from 'ethers';
import type { Intent, IntentKind } from './intent.js';
import { getChain, listChains } from './chains.js';
import { knownTokens } from './tokens.js';

/** Caps for one asset class, in whole units (decimal strings, e.g. "250"). */
export interface AssetCap {
  perTx?: string;
  perDay?: string;
}

/** Caps of one band (hard ceiling or automatic budget), per asset class. */
export interface LimitBand {
  /** Caps on known USD stablecoins. */
  usd: AssetCap;
  /** Caps per native coin symbol (`ETH`, `BNB`, `POL`, …). */
  native: Record<string, AssetCap>;
}

/**
 * The persisted limits document (`limits.json`).
 *
 * Two bands, both wallet-wide and rolling over 24h:
 * - the top-level `usd` / `native` caps are the **hard ceiling**: above it a
 *   request is refused, in every autonomy mode, until the user raises it in
 *   the settings panel;
 * - `auto` is the **automatic budget** used by the semi-managed mode: above it
 *   (but within the hard ceiling) a request is held for the human instead of
 *   being signed. The full-managed mode has no automatic budget.
 */
export interface WalletLimits extends LimitBand {
  version: 1;
  updatedAt: string;
  /** Direct transfers only to trusted contacts and own accounts. */
  whitelistOnly: boolean;
  /** Automatic budget (semi-managed mode). Defaults to a tenth of the hard ceiling. */
  auto: LimitBand;
  /** Apply caps and the whitelist on testnets too (default: exempt). */
  includeTestnets?: boolean;
}

/** One signed operation in the spend window (see `SpendTracker.windowEvents`). */
export interface SpendWindowEvent {
  ts: number;
  chainId: number;
  valueWei: string;
  token?: string;
  tokenAmount?: string;
}

/** The request being checked. */
export interface LimitRequest {
  chainId?: number;
  /** Native value moved by the operation (wei). */
  valueWei?: bigint;
  intent: Intent;
}

/** Facts the check needs from the wallet. */
export interface LimitContext {
  /** Whether an address is a trusted contact or one of the wallet's own accounts. */
  isWhitelisted(address: string): boolean;
  /** Signed operations of the last 24h, wallet-wide. */
  recentSpend: readonly SpendWindowEvent[];
}

/** Outcome of {@link checkLimits}. */
export type LimitVerdict =
  | { ok: true }
  | { ok: false; code: 'RECIPIENT_NOT_WHITELISTED' | 'LIMIT_EXCEEDED'; limit: string; reason: string };

/** Intents that hand assets directly to a recipient or a pulling spender (whitelist scope). */
const DIRECT_TRANSFER_INTENTS: readonly IntentKind[] = [
  'native-transfer',
  'token-transfer',
  'nft-transfer',
  'transfer-authorization',
  'permit-transfer',
];

/** Intents whose `amount` actually leaves the wallet (USD cap scope). */
const SPENDING_TOKEN_INTENTS: readonly IntentKind[] = ['token-transfer', 'transfer-authorization', 'permit-transfer'];

const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Fixed-point precision used to compare stablecoins with different decimals. */
const USD_DECIMALS = 18;

/** Default stablecoin caps (USD): small amounts per transaction and per day. */
export const DEFAULT_USD_CAP: AssetCap = { perTx: '100', perDay: '1000' };
/** Default cap for every native coin, in whole coins. */
export const DEFAULT_NATIVE_CAP: AssetCap = { perTx: '1', perDay: '100' };

/**
 * The limits a fresh wallet starts with: the small-amount profile — 100 USD
 * per transaction / 1000 USD per day on stablecoins, and 1 / 100 coins on
 * every native coin the wallet knows. Testnets stay exempt by default.
 */
export function defaultLimits(): WalletLimits {
  const native: Record<string, AssetCap> = {};
  for (const chain of listChains()) {
    if (!chain.testnet) native[chain.symbol.toUpperCase()] = { ...DEFAULT_NATIVE_CAP };
  }
  const usd = { ...DEFAULT_USD_CAP };
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    whitelistOnly: false,
    usd,
    native,
    auto: defaultAutoBand({ usd, native }),
  };
}

/** A tenth of one decimal amount (exact, no float rounding). */
function tenth(amount: string | undefined): string | undefined {
  // Invalid input is left for validateLimits to report, not parsed here.
  if (amount === undefined || !AMOUNT_RE.test(amount)) return undefined;
  const scaled = parseUnits(amount, 18) / 10n;
  return formatFixed(scaled, 18);
}

/** The automatic budget that follows a hard ceiling: a tenth of every cap. */
export function defaultAutoBand(hard: LimitBand): LimitBand {
  const native: Record<string, AssetCap> = {};
  for (const [symbol, cap] of Object.entries(hard.native)) {
    const perTx = tenth(cap.perTx);
    const perDay = tenth(cap.perDay);
    if (perTx !== undefined || perDay !== undefined) native[symbol] = { ...(perTx !== undefined ? { perTx } : {}), ...(perDay !== undefined ? { perDay } : {}) };
  }
  const usd: AssetCap = {};
  const usdTx = tenth(hard.usd.perTx);
  const usdDay = tenth(hard.usd.perDay);
  if (usdTx !== undefined) usd.perTx = usdTx;
  if (usdDay !== undefined) usd.perDay = usdDay;
  return { usd, native };
}

/** Decimal strings only: no signs, exponents, separators, or units. */
const AMOUNT_RE = /^(0|[1-9]\d{0,17})(\.\d{1,18})?$/;

function capErrors(cap: unknown, path: string): string[] {
  if (cap === undefined) return [];
  if (cap === null || typeof cap !== 'object' || Array.isArray(cap)) return [`${path} must be an object`];
  const errors: string[] = [];
  for (const [key, value] of Object.entries(cap as Record<string, unknown>)) {
    if (key !== 'perTx' && key !== 'perDay') errors.push(`${path}.${key} is not a known cap`);
    else if (value !== undefined && (typeof value !== 'string' || !AMOUNT_RE.test(value))) {
      errors.push(`${path}.${key} must be a plain decimal amount like "250" or "0.5"`);
    }
  }
  return errors;
}

/** Structural validation; returns human-readable problems (empty when valid). */
export function validateLimits(input: unknown): string[] {
  if (input === null || typeof input !== 'object') return ['limits must be an object'];
  const limits = input as Partial<WalletLimits>;
  const errors: string[] = [];
  if (limits.version !== 1) errors.push('version must be 1');
  if (typeof limits.whitelistOnly !== 'boolean') errors.push('whitelistOnly must be a boolean');
  if (limits.includeTestnets !== undefined && typeof limits.includeTestnets !== 'boolean') errors.push('includeTestnets must be a boolean');
  errors.push(...capErrors(limits.usd ?? {}, 'usd'));
  if (limits.native === null || typeof limits.native !== 'object' || Array.isArray(limits.native)) errors.push('native must be an object');
  else {
    for (const [symbol, cap] of Object.entries(limits.native)) {
      if (!/^[A-Z][A-Z0-9]{1,9}$/.test(symbol)) errors.push(`native.${symbol}: symbol must be upper-case, e.g. "ETH"`);
      errors.push(...capErrors(cap, `native.${symbol}`));
    }
  }
  if (limits.auto !== undefined) {
    if (limits.auto === null || typeof limits.auto !== 'object') errors.push('auto must be an object');
    else {
      errors.push(...capErrors(limits.auto.usd ?? {}, 'auto.usd'));
      for (const [symbol, cap] of Object.entries(limits.auto.native ?? {})) errors.push(...capErrors(cap, `auto.native.${symbol}`));
    }
  }
  return errors;
}

/** Normalize a partial document (UI / file input) into a full, validated one. Throws on invalid input. */
export function normalizeLimits(input: unknown): WalletLimits {
  const raw = (input ?? {}) as Partial<WalletLimits>;
  const clean = (cap: AssetCap | undefined): AssetCap => {
    const out: AssetCap = {};
    if (cap?.perTx !== undefined && cap.perTx !== '') out.perTx = cap.perTx.trim();
    if (cap?.perDay !== undefined && cap.perDay !== '') out.perDay = cap.perDay.trim();
    return out;
  };
  const native: Record<string, AssetCap> = {};
  for (const [symbol, cap] of Object.entries(raw.native ?? {})) {
    const cleaned = clean(cap);
    if (cleaned.perTx !== undefined || cleaned.perDay !== undefined) native[symbol.trim().toUpperCase()] = cleaned;
  }
  const hard: LimitBand = { usd: clean(raw.usd), native };
  const autoNative: Record<string, AssetCap> = {};
  for (const [symbol, cap] of Object.entries(raw.auto?.native ?? {})) {
    const cleaned = clean(cap);
    if (cleaned.perTx !== undefined || cleaned.perDay !== undefined) autoNative[symbol.trim().toUpperCase()] = cleaned;
  }
  const limits: WalletLimits = {
    version: 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    whitelistOnly: raw.whitelistOnly === true,
    ...hard,
    // A document without an automatic budget (written before it existed) gets the default one.
    auto: raw.auto === undefined ? defaultAutoBand(hard) : { usd: clean(raw.auto.usd), native: autoNative },
    ...(raw.includeTestnets === true ? { includeTestnets: true } : {}),
  };
  const errors = validateLimits(limits);
  if (errors.length > 0) throw new Error(`invalid limits: ${errors.join('; ')}`);
  return limits;
}

function capValue(amount: string | undefined, decimals: number): bigint | undefined {
  return amount === undefined ? undefined : parseUnits(amount, decimals);
}

/** Stablecoin metadata for a token on a chain, from the curated registry. */
function stableToken(chainId: number | undefined, token: string | undefined): { decimals: number; symbol: string } | undefined {
  if (chainId === undefined || token === undefined) return undefined;
  const wanted = token.toLowerCase();
  const found = knownTokens(chainId).find((entry) => entry.stable === true && entry.address.toLowerCase() === wanted);
  return found === undefined ? undefined : { decimals: found.decimals, symbol: found.symbol };
}

/** Scale an atomic stablecoin amount to {@link USD_DECIMALS}. */
function toUsdFixed(amount: bigint, decimals: number): bigint {
  return decimals <= USD_DECIMALS ? amount * 10n ** BigInt(USD_DECIMALS - decimals) : amount / 10n ** BigInt(decimals - USD_DECIMALS);
}

function formatFixed(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${fraction.length > 0 ? `.${fraction}` : ''}`;
}

function isExempt(limits: WalletLimits, chainId: number | undefined): boolean {
  if (limits.includeTestnets === true || chainId === undefined) return false;
  return getChain(chainId)?.testnet === true;
}

/** USD stablecoins spent wallet-wide in the window (18-decimal fixed point). */
function usdSpent(events: readonly SpendWindowEvent[], now: number): bigint {
  let total = 0n;
  for (const event of events) {
    if (event.ts < now - WINDOW_MS || event.token === undefined || event.tokenAmount === undefined) continue;
    const stable = stableToken(event.chainId, event.token);
    if (stable !== undefined) total += toUsdFixed(BigInt(event.tokenAmount), stable.decimals);
  }
  return total;
}

/** Native coin of one symbol spent wallet-wide in the window (wei). */
function nativeSpent(events: readonly SpendWindowEvent[], symbol: string, now: number): bigint {
  let total = 0n;
  for (const event of events) {
    if (event.ts < now - WINDOW_MS) continue;
    if ((getChain(event.chainId)?.symbol ?? 'ETH') === symbol) total += BigInt(event.valueWei);
  }
  return total;
}

/**
 * Check one signing request against one band of the limits. Pure: reads only
 * its arguments. Returns the first violated cap with a user-facing reason.
 *
 * `band: 'hard'` checks the hard ceiling (and the transfer whitelist);
 * `band: 'auto'` checks the automatic budget only.
 */
export function checkLimits(
  limits: WalletLimits,
  request: LimitRequest,
  context: LimitContext,
  now = Date.now(),
  band: 'hard' | 'auto' = 'hard',
): LimitVerdict {
  if (isExempt(limits, request.chainId)) return { ok: true };
  const { intent } = request;
  const caps: LimitBand = band === 'auto' ? limits.auto : limits;
  const label = band === 'auto' ? 'auto.' : '';

  if (band === 'hard' && limits.whitelistOnly && DIRECT_TRANSFER_INTENTS.includes(intent.kind)) {
    // A Permit2 signature transfer names no recipient: the spender chooses
    // where the tokens go, so the spender itself must be trusted.
    const recipient = intent.recipient ?? (intent.kind === 'permit-transfer' ? intent.spender : undefined);
    if (recipient === undefined || !context.isWhitelisted(recipient)) {
      return {
        ok: false,
        code: 'RECIPIENT_NOT_WHITELISTED',
        limit: 'whitelist',
        reason: `transfer whitelist is on and ${recipient ?? 'the recipient'} is not a trusted contact`,
      };
    }
  }

  const value = request.valueWei ?? 0n;
  if (value > 0n) {
    const chain = request.chainId !== undefined ? getChain(request.chainId) : undefined;
    const symbol = chain?.symbol ?? 'ETH';
    const decimals = chain?.decimals ?? 18;
    const cap = caps.native[symbol];
    const perTx = capValue(cap?.perTx, decimals);
    if (perTx !== undefined && value > perTx) {
      return {
        ok: false,
        code: 'LIMIT_EXCEEDED',
        limit: `${label}native.${symbol}.perTx`,
        reason: `${formatFixed(value, decimals)} ${symbol} exceeds the per-transaction limit of ${cap?.perTx ?? ''} ${symbol}`,
      };
    }
    const perDay = capValue(cap?.perDay, decimals);
    if (perDay !== undefined) {
      const spent = nativeSpent(context.recentSpend, symbol, now);
      if (spent + value > perDay) {
        return {
          ok: false,
          code: 'LIMIT_EXCEEDED',
          limit: `${label}native.${symbol}.perDay`,
          reason: `${formatFixed(value, decimals)} ${symbol} would bring today's total to ${formatFixed(spent + value, decimals)} ${symbol}, over the daily limit of ${cap?.perDay ?? ''} ${symbol}`,
        };
      }
    }
  }

  if (SPENDING_TOKEN_INTENTS.includes(intent.kind) && intent.amount !== undefined) {
    const stable = stableToken(request.chainId, intent.token);
    if (stable !== undefined) {
      const amount = toUsdFixed(BigInt(intent.amount), stable.decimals);
      const perTx = capValue(caps.usd.perTx, USD_DECIMALS);
      if (perTx !== undefined && amount > perTx) {
        return {
          ok: false,
          code: 'LIMIT_EXCEEDED',
          limit: `${label}usd.perTx`,
          reason: `${formatFixed(amount, USD_DECIMALS)} ${stable.symbol} exceeds the per-transaction limit of $${caps.usd.perTx ?? ''}`,
        };
      }
      const perDay = capValue(caps.usd.perDay, USD_DECIMALS);
      if (perDay !== undefined) {
        const spent = usdSpent(context.recentSpend, now);
        if (spent + amount > perDay) {
          return {
            ok: false,
            code: 'LIMIT_EXCEEDED',
            limit: `${label}usd.perDay`,
            reason: `${formatFixed(amount, USD_DECIMALS)} ${stable.symbol} would bring today's stablecoin total to $${formatFixed(spent + amount, USD_DECIMALS)}, over the daily limit of $${caps.usd.perDay ?? ''}`,
          };
        }
      }
    }
  }
  return { ok: true };
}

/** Wallet-wide usage against each configured daily cap (for the settings panel). */
export function limitUsage(limits: WalletLimits, recentSpend: readonly SpendWindowEvent[], now = Date.now()): {
  usdSpentToday: string;
  nativeSpentToday: Record<string, string>;
} {
  const nativeSpentToday: Record<string, string> = {};
  for (const symbol of Object.keys(limits.native)) nativeSpentToday[symbol] = formatFixed(nativeSpent(recentSpend, symbol, now), 18);
  return { usdSpentToday: formatFixed(usdSpent(recentSpend, now), USD_DECIMALS), nativeSpentToday };
}

function capTightened(prev: string | undefined, next: string | undefined, decimals: number): boolean {
  if (prev === undefined) return true; // adding (or keeping no) cap never loosens
  if (next === undefined) return false; // removing a cap loosens
  return parseUnits(next, decimals) <= parseUnits(prev, decimals);
}

/**
 * Whether `next` is at least as strict as `prev` everywhere. Tightening needs
 * no step-up confirmation; anything else must be re-confirmed with the PIN.
 */
export function isTighteningLimits(prev: WalletLimits, next: WalletLimits): boolean {
  if (prev.whitelistOnly && !next.whitelistOnly) return false;
  if (prev.includeTestnets === true && next.includeTestnets !== true) return false;
  if (!capTightened(prev.usd.perTx, next.usd.perTx, USD_DECIMALS)) return false;
  if (!capTightened(prev.usd.perDay, next.usd.perDay, USD_DECIMALS)) return false;
  for (const [symbol, cap] of Object.entries(prev.native)) {
    const after = next.native[symbol];
    if (!capTightened(cap.perTx, after?.perTx, 18)) return false;
    if (!capTightened(cap.perDay, after?.perDay, 18)) return false;
  }
  // The automatic budget is part of the same ceiling: loosening it needs the PIN too.
  const prevAuto: LimitBand = prev.auto ?? { usd: {}, native: {} };
  const nextAuto: LimitBand = next.auto ?? { usd: {}, native: {} };
  if (!capTightened(prevAuto.usd.perTx, nextAuto.usd.perTx, USD_DECIMALS)) return false;
  if (!capTightened(prevAuto.usd.perDay, nextAuto.usd.perDay, USD_DECIMALS)) return false;
  for (const [symbol, cap] of Object.entries(prevAuto.native)) {
    const after = nextAuto.native[symbol];
    if (!capTightened(cap.perTx, after?.perTx, 18)) return false;
    if (!capTightened(cap.perDay, after?.perDay, 18)) return false;
  }
  return true;
}

/** Whether any limit is configured at all. */
export function hasLimits(limits: WalletLimits): boolean {
  return (
    limits.whitelistOnly ||
    limits.usd.perTx !== undefined ||
    limits.usd.perDay !== undefined ||
    Object.values(limits.native).some((cap) => cap.perTx !== undefined || cap.perDay !== undefined)
  );
}
