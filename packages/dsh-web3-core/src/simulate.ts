/**
 * Transaction simulation: what a transaction *actually* does to the signer's
 * assets, reconciled against what it *claims* to do.
 *
 * The simulation itself is `eth_simulateV1` (execution-apis) with
 * `traceTransfers: true`, which reports native-coin movements as synthetic
 * ERC-20 `Transfer` logs from {@link NATIVE_PSEUDO_ADDRESS}. No third party
 * is involved — only the chain's RPC.
 *
 * Reconciliation turns differences into findings:
 *
 * - a transfer / approval whose simulation moves *more* than it says
 *   (extra outflows, hidden approvals) → `high`
 * - the declared movement missing or a different amount → `high`
 * - the recipient forwarding the funds onward in the same transaction
 *   (sweeper / compromised address) → `high`
 * - a reverting simulation → `high`
 * - for opaque contract calls: the net asset changes as `info`, and `warn`
 *   when assets leave and nothing comes back
 *
 * @module dsh-web3-core/simulate
 */

import { formatUnits, getAddress } from 'ethers';
import { getChain } from './chains.js';
import { findKnownToken } from './tokens.js';
import type { Intent } from './intent.js';
import { finding, type RiskFinding } from './security.js';

/** Address `eth_simulateV1` uses for native-coin transfer logs. */
export const NATIVE_PSEUDO_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/** keccak256("Transfer(address,address,uint256)") — ERC-20 and ERC-721. */
export const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** keccak256("Approval(address,address,uint256)") — ERC-20 and ERC-721. */
export const TOPIC_APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
/** keccak256("ApprovalForAll(address,address,bool)"). */
export const TOPIC_APPROVAL_FOR_ALL = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31';

/** One emitted log. */
export interface SimulationLog {
  address: string;
  topics: string[];
  data: string;
}

/** Raw simulation outcome for one call. */
export interface SimulationResult {
  status: 'success' | 'reverted';
  error?: string;
  gasUsed?: bigint;
  logs: SimulationLog[];
}

/** Thrown by providers whose RPC does not implement `eth_simulateV1`. */
export class SimulationUnsupportedError extends Error {
  constructor(message = 'the RPC endpoint does not support eth_simulateV1') {
    super(message);
    this.name = 'SimulationUnsupportedError';
  }
}

/** An asset moving between two addresses. */
export interface AssetMovement {
  /** Checksummed token contract, or `native`. */
  asset: string;
  standard: 'native' | 'erc20' | 'erc721';
  from: string;
  to: string;
  /** Fungible amount in atomic units (decimal string). */
  amount?: string;
  /** NFT id (decimal string). */
  tokenId?: string;
}

/** A permission granted during the simulated call. */
export interface ApprovalChange {
  token: string;
  owner: string;
  spender: string;
  standard: 'erc20' | 'erc721' | 'all';
  amount?: string;
  unlimited?: boolean;
  approved?: boolean;
}

/** Decoded effects of a simulated call, from the signer's point of view. */
export interface SimulationSummary {
  status: 'success' | 'reverted';
  error?: string;
  /** Every decoded movement, in log order. */
  movements: AssetMovement[];
  /** Movements leaving the signer. */
  outgoing: AssetMovement[];
  /** Movements reaching the signer. */
  incoming: AssetMovement[];
  /** Permissions over the signer's assets. */
  approvals: ApprovalChange[];
  /** Whether the RPC reported native transfers (traceTransfers honored). */
  nativeTraced: boolean;
}

function topicAddress(topic: string | undefined): string | undefined {
  if (topic === undefined || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return undefined;
  try {
    return getAddress(`0x${topic.slice(26)}`);
  } catch {
    return undefined;
  }
}

function word(data: string, index = 0): bigint | undefined {
  const hex = data.startsWith('0x') ? data.slice(2) : data;
  const slice = hex.slice(index * 64, index * 64 + 64);
  return slice.length === 64 ? BigInt(`0x${slice}`) : undefined;
}

const UNLIMITED_THRESHOLD = 2n ** 128n;

/** Decode transfer / approval logs and split them relative to `account`. */
export function summarizeSimulation(result: SimulationResult, account: string): SimulationSummary {
  const me = account.toLowerCase();
  const movements: AssetMovement[] = [];
  const approvals: ApprovalChange[] = [];
  let nativeTraced = false;
  for (const log of result.logs) {
    const topic0 = log.topics[0]?.toLowerCase();
    const emitter = log.address.toLowerCase();
    if (topic0 === TOPIC_TRANSFER) {
      const from = topicAddress(log.topics[1]);
      const to = topicAddress(log.topics[2]);
      if (from === undefined || to === undefined) continue;
      if (emitter === NATIVE_PSEUDO_ADDRESS) {
        nativeTraced = true;
        const amount = word(log.data);
        if (amount !== undefined) movements.push({ asset: 'native', standard: 'native', from, to, amount: amount.toString() });
      } else if (log.topics.length === 4) {
        const id = log.topics[3];
        movements.push({ asset: getAddress(log.address), standard: 'erc721', from, to, ...(id !== undefined ? { tokenId: BigInt(id).toString() } : {}) });
      } else {
        const amount = word(log.data);
        if (amount !== undefined) movements.push({ asset: getAddress(log.address), standard: 'erc20', from, to, amount: amount.toString() });
      }
    } else if (topic0 === TOPIC_APPROVAL) {
      const owner = topicAddress(log.topics[1]);
      const spender = topicAddress(log.topics[2]);
      if (owner === undefined || spender === undefined || owner.toLowerCase() !== me) continue;
      if (log.topics.length === 4) {
        approvals.push({ token: getAddress(log.address), owner, spender, standard: 'erc721' });
      } else {
        const amount = word(log.data);
        if (amount === undefined) continue;
        approvals.push({ token: getAddress(log.address), owner, spender, standard: 'erc20', amount: amount.toString(), ...(amount >= UNLIMITED_THRESHOLD ? { unlimited: true } : {}) });
      }
    } else if (topic0 === TOPIC_APPROVAL_FOR_ALL) {
      const owner = topicAddress(log.topics[1]);
      const spender = topicAddress(log.topics[2]);
      if (owner === undefined || spender === undefined || owner.toLowerCase() !== me) continue;
      const approved = (word(log.data) ?? 0n) !== 0n;
      approvals.push({ token: getAddress(log.address), owner, spender, standard: 'all', approved, ...(approved ? { unlimited: true } : {}) });
    }
  }
  return {
    status: result.status,
    ...(result.error !== undefined ? { error: result.error } : {}),
    movements,
    outgoing: movements.filter((entry) => entry.from.toLowerCase() === me),
    incoming: movements.filter((entry) => entry.to.toLowerCase() === me),
    approvals,
    nativeTraced,
  };
}

/** Human description of a movement's asset + amount on a chain. */
export function describeMovement(movement: Pick<AssetMovement, 'asset' | 'standard' | 'amount' | 'tokenId'>, chainId: number | undefined): string {
  if (movement.standard === 'native') {
    const chain = chainId !== undefined ? getChain(chainId) : undefined;
    return `${formatUnits(BigInt(movement.amount ?? 0), chain?.decimals ?? 18)} ${chain?.symbol ?? 'native coin'}`;
  }
  if (movement.standard === 'erc721') return `NFT #${movement.tokenId ?? '?'} of ${movement.asset}`;
  const known = chainId !== undefined ? findKnownToken(chainId, movement.asset) : undefined;
  return known !== undefined ? `${formatUnits(BigInt(movement.amount ?? 0), known.decimals)} ${known.symbol}` : `${movement.amount ?? '?'} units of token ${movement.asset}`;
}

interface Expected {
  asset: string;
  to: string;
  amount: bigint;
}

/** Movements the intent itself declares, or `undefined` when the call is opaque. */
function expectedOutflows(intent: Intent, tx: { to: string; value: bigint }): Expected[] | undefined {
  const native: Expected[] = tx.value > 0n ? [{ asset: 'native', to: tx.to, amount: tx.value }] : [];
  switch (intent.kind) {
    case 'native-transfer':
      return native;
    case 'token-transfer':
      // transferFrom may move someone else's tokens: not reconcilable here.
      if (intent.method !== 'transfer' || intent.token === undefined || intent.recipient === undefined || intent.amount === undefined) return undefined;
      return [...native, { asset: intent.token, to: intent.recipient, amount: BigInt(intent.amount) }];
    case 'token-approve':
    case 'token-revoke':
    case 'nft-approval':
      return native;
    default:
      return undefined;
  }
}

const CHECK = 'simulation';

/**
 * Compare a simulation with the declared intent.
 *
 * @param input.recipients - addresses that receive assets by design (used to
 *   detect immediate forwarding).
 */
export function reconcileSimulation(input: {
  intent: Intent;
  account: string;
  chainId?: number;
  tx: { to: string; value: bigint };
  summary: SimulationSummary;
}): RiskFinding[] {
  const { intent, summary, chainId } = input;
  const out: RiskFinding[] = [];
  const describe = (movement: Pick<AssetMovement, 'asset' | 'standard' | 'amount' | 'tokenId'>) => describeMovement(movement, chainId);

  if (summary.status === 'reverted') {
    out.push(finding(CHECK, 'SIMULATION_REVERTED', 'high', `simulation shows the transaction failing on-chain${summary.error !== undefined ? `: ${summary.error}` : ''}`));
    return out;
  }

  const expected = expectedOutflows(intent, input.tx);
  if (expected !== undefined) {
    const outgoing = summary.outgoing.filter((movement) => movement.standard !== 'native' || summary.nativeTraced);
    const unmatched = [...outgoing];
    for (const want of expected) {
      if (want.asset === 'native' && !summary.nativeTraced) continue;
      const sameAsset = (movement: AssetMovement) =>
        (want.asset === 'native' ? movement.standard === 'native' : movement.asset.toLowerCase() === want.asset.toLowerCase()) &&
        movement.to.toLowerCase() === want.to.toLowerCase();
      const exact = unmatched.findIndex((movement) => sameAsset(movement) && BigInt(movement.amount ?? -1) === want.amount);
      if (exact >= 0) {
        unmatched.splice(exact, 1);
        continue;
      }
      const near = unmatched.findIndex(sameAsset);
      const wantText = describe({ asset: want.asset, standard: want.asset === 'native' ? 'native' : 'erc20', amount: want.amount.toString() });
      if (near >= 0) {
        const [moved] = unmatched.splice(near, 1);
        out.push(finding(CHECK, 'SIMULATION_AMOUNT_MISMATCH', 'high', `simulation moves ${describe(moved!)} to ${want.to}, but the request says ${wantText}`, want.to));
      } else {
        out.push(finding(CHECK, 'SIMULATION_MISMATCH', 'high', `simulation does not show the declared transfer of ${wantText} to ${want.to} — the token may not behave like a standard ERC-20`, want.to));
      }
    }
    for (const extra of unmatched) {
      out.push(
        finding(CHECK, 'SIMULATION_UNEXPECTED_OUTFLOW', 'high', `simulation shows this transaction ALSO sending ${describe(extra)} to ${extra.to}, which the request does not mention (fee-on-transfer or malicious token)`, extra.to),
      );
    }
    const allowedApproval = intent.kind === 'token-approve' || intent.kind === 'token-revoke' || intent.kind === 'nft-approval';
    for (const approval of summary.approvals) {
      const declared =
        allowedApproval &&
        intent.token !== undefined &&
        approval.token.toLowerCase() === intent.token.toLowerCase() &&
        intent.spender !== undefined &&
        approval.spender.toLowerCase() === intent.spender.toLowerCase();
      if (!declared) out.push(approvalFinding(approval, chainId));
    }
  } else {
    for (const approval of summary.approvals) out.push(approvalFinding(approval, chainId));
    const outText = summary.outgoing.map((movement) => `−${describe(movement)} → ${movement.to}`);
    const inText = summary.incoming.map((movement) => `+${describe(movement)} ← ${movement.from}`);
    if (outText.length > 0 || inText.length > 0) {
      out.push(finding(CHECK, 'SIMULATION_ASSET_CHANGES', 'info', `simulated balance changes for your account: ${[...outText, ...inText].join('; ')}`));
    }
    if (summary.outgoing.length > 0 && summary.incoming.length === 0) {
      out.push(finding(CHECK, 'SIMULATION_NOTHING_BACK', 'warn', 'simulation shows assets leaving your account and nothing coming back'));
    }
  }

  // Funds that reach a recipient and leave it again in the same transaction.
  const reached = new Map<string, AssetMovement>();
  for (const movement of summary.outgoing) reached.set(`${movement.to.toLowerCase()}|${movement.asset.toLowerCase()}`, movement);
  const flagged = new Set<string>();
  for (const movement of summary.movements) {
    const key = `${movement.from.toLowerCase()}|${movement.asset.toLowerCase()}`;
    const original = reached.get(key);
    if (original === undefined || flagged.has(key) || movement.from.toLowerCase() === input.account.toLowerCase()) continue;
    if (expected === undefined && movement.from.toLowerCase() === input.tx.to.toLowerCase()) continue; // routers pass funds on by design
    flagged.add(key);
    out.push(
      finding(
        CHECK,
        'RECIPIENT_FORWARDS_FUNDS',
        'high',
        `${movement.from} immediately forwards the ${describe(original)} it receives to ${movement.to} — the recipient may be a compromised or sweeper address; confirm it with the payee`,
        movement.from,
      ),
    );
  }
  return out;
}

function approvalFinding(approval: ApprovalChange, chainId: number | undefined): RiskFinding {
  const known = chainId !== undefined ? findKnownToken(chainId, approval.token) : undefined;
  const what =
    approval.standard === 'all'
      ? `${approval.approved === false ? 'revokes' : 'grants'} control of ALL your NFTs in ${approval.token}`
      : approval.standard === 'erc721'
        ? `approves an NFT of ${approval.token}`
        : `approves ${approval.unlimited === true ? 'UNLIMITED' : known !== undefined ? `${formatUnits(BigInt(approval.amount ?? 0), known.decimals)}` : `${approval.amount ?? '?'} units of`} ${known?.symbol ?? `token ${approval.token}`}`;
  const severity = approval.standard === 'all' && approval.approved === false ? 'info' : 'high';
  return finding(CHECK, 'SIMULATION_HIDDEN_APPROVAL', severity, `simulation shows this transaction ${what} to ${approval.spender}`, approval.spender);
}
