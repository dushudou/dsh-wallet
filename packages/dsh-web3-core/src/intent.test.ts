import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, MaxUint256 } from 'ethers';
import {
  PERMIT2_ADDRESS,
  classifyTransaction,
  classifyTypedData,
  encodeErc20Approve,
  encodeErc20Transfer,
} from '../src/intent.js';
import { evaluatePolicy, normalizeChainId, validatePolicy } from '../src/policy/evaluate.js';
import { detectPreset, policyPreset } from '../src/policy/presets.js';
import type { PolicyRequest, SigningPolicy } from '../src/policy/types.js';
import { findKnownToken, knownTokens } from '../src/tokens.js';
import { SpendTracker } from '../src/policy/spend.js';
import { TxJournal } from '../src/journal.js';
import { AddressBook } from '../src/addressbook.js';
import { WalletVault } from '../src/vault.js';

const ACCOUNT = { address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' };
const ALICE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const SPENDER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';

function policyWith(rules: SigningPolicy['rules'], defaultEffect: SigningPolicy['defaultEffect'] = 'ask'): SigningPolicy {
  return { version: 1, updatedAt: new Date().toISOString(), defaultEffect, rules };
}

function tx(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return { type: 'signTransaction', account: ACCOUNT, chainId: 8453, to: USDC_BASE, value: '0', data: '0x', ...overrides };
}

function transferAuthorization(amount: string, to = ALICE) {
  return {
    domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_BASE },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    value: { from: ACCOUNT.address, to, value: amount, validAfter: 0, validBefore: 2_000_000_000, nonce: `0x${'11'.repeat(32)}` },
  };
}

describe('intent classification: transactions', () => {
  it('classifies native transfers', () => {
    expect(classifyTransaction({ to: ALICE, value: '5', data: '0x' })).toMatchObject({ kind: 'native-transfer', recipient: ALICE, amount: '5' });
  });

  it('decodes ERC-20 transfer to the real recipient', () => {
    const intent = classifyTransaction({ to: USDC_BASE, data: encodeErc20Transfer(ALICE, 2_500_000n) });
    expect(intent).toMatchObject({ kind: 'token-transfer', token: USDC_BASE, recipient: ALICE, amount: '2500000', method: 'transfer' });
  });

  it('flags unlimited approvals and treats approve(0) as a revoke', () => {
    expect(classifyTransaction({ to: USDC_BASE, data: encodeErc20Approve(SPENDER, MaxUint256) })).toMatchObject({
      kind: 'token-approve',
      spender: SPENDER,
      unlimited: true,
    });
    expect(classifyTransaction({ to: USDC_BASE, data: encodeErc20Approve(SPENDER, 5n) })).toMatchObject({ kind: 'token-approve', amount: '5' });
    expect(classifyTransaction({ to: USDC_BASE, data: encodeErc20Approve(SPENDER, 0n) }).kind).toBe('token-revoke');
  });

  it('decodes setApprovalForAll, NFT transfers, and Permit2 approve', () => {
    const iface = new Interface([
      'function setApprovalForAll(address,bool)',
      'function safeTransferFrom(address,address,uint256)',
      'function approve(address token, address spender, uint160 amount, uint48 expiration)',
    ]);
    expect(classifyTransaction({ to: USDC_BASE, data: iface.encodeFunctionData('setApprovalForAll', [SPENDER, true]) })).toMatchObject({
      kind: 'nft-approval',
      unlimited: true,
    });
    expect(classifyTransaction({ to: USDC_BASE, data: iface.encodeFunctionData('setApprovalForAll', [SPENDER, false]) }).kind).toBe('token-revoke');
    expect(
      classifyTransaction({ to: USDC_BASE, data: iface.encodeFunctionData('safeTransferFrom', [ACCOUNT.address, ALICE, 7n]) }),
    ).toMatchObject({ kind: 'nft-transfer', recipient: ALICE });
    expect(
      classifyTransaction({ to: PERMIT2_ADDRESS, data: iface.encodeFunctionData('approve', [USDC_BASE, SPENDER, 2n ** 160n - 1n, 0]) }),
    ).toMatchObject({ kind: 'token-approve', token: USDC_BASE, spender: SPENDER, unlimited: true });
  });

  it('falls back to contract-call for unknown calldata', () => {
    expect(classifyTransaction({ to: USDC_BASE, data: '0xdeadbeef' }).kind).toBe('contract-call');
  });
});

describe('intent classification: typed data', () => {
  it('decodes EIP-3009 transfer authorizations (x402)', () => {
    expect(classifyTypedData(transferAuthorization('1000'))).toMatchObject({
      kind: 'transfer-authorization',
      token: USDC_BASE,
      recipient: ALICE,
      amount: '1000',
    });
  });

  it('decodes EIP-2612 and Permit2 permits', () => {
    const permit = classifyTypedData({
      domain: { chainId: 1, verifyingContract: USDC_BASE },
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      value: { owner: ACCOUNT.address, spender: SPENDER, value: MaxUint256.toString(), nonce: 0, deadline: 1 },
    });
    expect(permit).toMatchObject({ kind: 'permit', spender: SPENDER, unlimited: true });

    const permitSingle = classifyTypedData({
      domain: { chainId: 1, verifyingContract: PERMIT2_ADDRESS },
      types: {
        PermitDetails: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint160' },
          { name: 'expiration', type: 'uint48' },
          { name: 'nonce', type: 'uint48' },
        ],
        PermitSingle: [
          { name: 'details', type: 'PermitDetails' },
          { name: 'spender', type: 'address' },
          { name: 'sigDeadline', type: 'uint256' },
        ],
      },
      value: { details: { token: USDC_BASE, amount: '100', expiration: 0, nonce: 0 }, spender: SPENDER, sigDeadline: 5 },
    });
    expect(permitSingle).toMatchObject({ kind: 'permit', token: USDC_BASE, spender: SPENDER, amount: '100' });
  });

  it('marks unknown payloads as generic typed data', () => {
    expect(
      classifyTypedData({ domain: {}, types: { Mail: [{ name: 'contents', type: 'string' }] }, value: { contents: 'hi' } }),
    ).toMatchObject({ kind: 'typed-data', method: 'Mail' });
  });
});

describe('policy guardrails', () => {
  const valueOnlyAllow = policyWith([
    { id: 'small', effect: 'allow', priority: 10, match: { type: 'signTransaction', maxTxValue: '10000000000000000' } },
  ]);

  it('downgrades a value-capped allow rule to ask for token transfers (value is 0)', () => {
    const decision = evaluatePolicy(valueOnlyAllow, tx({ data: encodeErc20Transfer(ALICE, 10n ** 12n) }));
    expect(decision.effect).toBe('ask');
    expect(decision.guardrail).toBe('intent-not-covered');
    expect(decision.request).toMatchObject({ intent: 'token-transfer', recipient: ALICE, amount: '1000000000000' });
  });

  it('still auto-signs harmless native transfers under the same rule', () => {
    expect(evaluatePolicy(valueOnlyAllow, tx({ to: ALICE, value: '1000' })).effect).toBe('allow');
  });

  it('always asks for unlimited approvals, even when the rule opts in', () => {
    const policy = policyWith([
      { id: 'approvals', effect: 'allow', match: { intents: ['token-approve'], tokenLimits: [{ token: '*' }] } },
    ]);
    const decision = evaluatePolicy(policy, tx({ data: encodeErc20Approve(SPENDER, MaxUint256) }));
    expect(decision.effect).toBe('ask');
    expect(decision.guardrail).toBe('unlimited-permission');
    expect(evaluatePolicy(policy, tx({ data: encodeErc20Approve(SPENDER, 5n) })).effect).toBe('allow');
  });

  it('enforces per-token per-tx and daily caps', () => {
    const policy = policyWith([
      {
        id: 'usdc',
        effect: 'allow',
        match: { intents: ['token-transfer'], tokenLimits: [{ token: USDC_BASE, maxPerTx: '1000000', maxPerDay: '3000000' }] },
      },
    ]);
    const small = tx({ data: encodeErc20Transfer(ALICE, 900_000n) });
    expect(evaluatePolicy(policy, small).effect).toBe('allow');
    const large = evaluatePolicy(policy, tx({ data: encodeErc20Transfer(ALICE, 1_000_001n) }));
    expect(large.effect).toBe('ask');
    expect(large.guardrail).toBe('token-per-tx-cap');
    const overDaily = evaluatePolicy(policy, small, 0n, { tokenSpentLast24h: 2_500_000n });
    expect(overDaily.effect).toBe('ask');
    expect(overDaily.guardrail).toBe('token-daily-cap');
    // A token without a limit entry is never auto-signed.
    const other = evaluatePolicy(policy, tx({ to: ALICE, data: encodeErc20Transfer(SPENDER, 1n) }));
    expect(other.guardrail).toBe('token-not-limited');
  });

  it('matches recipients against the decoded token recipient, not the token contract', () => {
    const policy = policyWith([
      { id: 'alice', effect: 'allow', match: { recipients: [ALICE], intents: ['token-transfer'], tokenLimits: [{ token: '*' }] } },
    ]);
    expect(evaluatePolicy(policy, tx({ data: encodeErc20Transfer(ALICE, 1n) })).effect).toBe('allow');
    expect(evaluatePolicy(policy, tx({ data: encodeErc20Transfer(SPENDER, 1n) })).effect).toBe('ask');
  });

  it('a default "allow" never covers sensitive intents', () => {
    const decision = evaluatePolicy(policyWith([], 'allow'), tx({ data: encodeErc20Transfer(ALICE, 1n) }));
    expect(decision.effect).toBe('ask');
    expect(decision.guardrail).toBe('intent-not-covered');
  });

  it('normalizes string chain ids so deny rules cannot be sidestepped', () => {
    const policy = policyWith([{ id: 'no-mainnet', effect: 'deny', priority: 100, match: { chainIds: [1] } }], 'allow');
    const decision = evaluatePolicy(policy, tx({ to: ALICE, chainId: '1' as unknown as number }));
    expect(decision.effect).toBe('deny');
    expect(normalizeChainId('0x2105')).toBe(8453);
    expect(normalizeChainId(8453n)).toBe(8453);
    expect(normalizeChainId('base')).toBeUndefined();
  });

  it('validates the new matcher fields', () => {
    const errors = validatePolicy(
      policyWith([
        {
          id: 'bad',
          effect: 'allow',
          match: { intents: ['teleport' as never], tokenLimits: [{ token: 'usdc', maxPerTx: '1.5' }] },
        },
      ]),
    );
    expect(errors.join('\n')).toContain('intents');
    expect(errors.join('\n')).toContain('token must be a 0x address');
    expect(errors.join('\n')).toContain('maxPerTx');
  });
});

describe('micropay preset', () => {
  const request = (amount: string, to = ALICE): PolicyRequest => ({
    type: 'signTypedData',
    account: ACCOUNT,
    chainId: 8453,
    to: USDC_BASE,
    typedData: JSON.stringify(transferAuthorization(amount, to)),
  });

  it('asks for the first payment to a new merchant, then auto-signs small payments', () => {
    const policy = policyPreset('micropay');
    expect(validatePolicy(policy)).toEqual([]);
    expect(detectPreset(policy)).toBe('micropay');
    const first = evaluatePolicy(policy, request('500000'));
    expect(first.effect).toBe('ask');
    const seen = evaluatePolicy(policy, request('500000'), 0n, { events: [{ ts: Date.now() - 1000, from: ACCOUNT.address, to: ALICE }] });
    expect(seen.effect).toBe('allow');
    const tooBig = evaluatePolicy(policy, request('1000001'), 0n, { events: [{ ts: Date.now() - 1000, from: ACCOUNT.address, to: ALICE }] });
    expect(tooBig.effect).toBe('ask');
    expect(tooBig.guardrail).toBe('token-per-tx-cap');
  });

  it('keeps the strict ceiling for native transfers', () => {
    const decision = evaluatePolicy(policyPreset('micropay'), tx({ to: ALICE, chainId: 1, value: '60000000000000000' }));
    expect(decision.effect).toBe('deny');
  });

  it('lets localhost sign token moves freely under strict', () => {
    const decision = evaluatePolicy(policyPreset('strict'), tx({ chainId: 31337, data: encodeErc20Transfer(ALICE, 10n ** 30n) }));
    expect(decision.effect).toBe('allow');
  });
});

describe('token registry', () => {
  it('resolves symbols and addresses per chain', () => {
    expect(findKnownToken(8453, 'usdc')?.address).toBe(USDC_BASE);
    expect(findKnownToken(8453, USDC_BASE.toLowerCase())?.symbol).toBe('USDC');
    expect(findKnownToken(56, 'USDT')?.decimals).toBe(18);
    expect(findKnownToken(8453, 'DOGE')).toBeUndefined();
    expect(knownTokens(84532).map((token) => token.symbol)).toContain('USDC');
  });
});

describe('persistence helpers', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-web3-core-intent-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('tracks per-token rolling spend', async () => {
    const spend = new SpendTracker(dir);
    await spend.load();
    await spend.record({ chainId: 8453, from: ACCOUNT.address, to: ALICE, valueWei: '0', token: USDC_BASE, tokenAmount: '700' });
    await spend.record({ chainId: 8453, from: ACCOUNT.address, to: ALICE, valueWei: '0', token: USDC_BASE, tokenAmount: '300', ts: Date.now() - 2 * 86_400_000 });
    expect(spend.tokenSpentLast24h(ACCOUNT.address, USDC_BASE.toLowerCase())).toBe(700n);
  });

  it('journals transactions with idempotency lookup', async () => {
    const journal = new TxJournal(dir);
    await journal.load();
    await journal.add({
      hash: '0xabc',
      chainId: 1,
      from: ACCOUNT.address,
      to: ALICE,
      nonce: 0,
      valueWei: '1',
      data: '0x',
      type: 2,
      gasLimit: '21000',
      status: 'pending',
      submittedAt: Date.now(),
      idempotencyKey: 'pay-alice-1',
    });
    await journal.update('0xABC', { status: 'success', blockNumber: 5 });
    const reloaded = new TxJournal(dir);
    await reloaded.load();
    expect(reloaded.get('0xabc')).toMatchObject({ status: 'success', blockNumber: 5 });
    expect(reloaded.byIdempotencyKey('pay-alice-1')?.hash).toBe('0xabc');
    expect(reloaded.list({ from: ACCOUNT.address.toLowerCase() })).toHaveLength(1);
  });

  it('resolves address-book labels exactly and rejects address-like labels', async () => {
    const book = new AddressBook(dir);
    await book.load();
    await book.upsert({ label: 'Alice', address: ALICE.toLowerCase(), chainIds: [8453] });
    expect(book.resolve('alice', 8453)?.address).toBe(ALICE);
    expect(book.resolve('alice', 1)).toBeUndefined();
    expect(book.resolve('ali')).toBeUndefined();
    expect(book.labelFor(ALICE)).toBe('Alice');
    await expect(book.upsert({ label: 'vitalik.eth', address: ALICE })).rejects.toThrow(/ENS/);
    const raw = JSON.parse(await readFile(join(dir, 'address-book.json'), 'utf8'));
    expect(raw.entries).toHaveLength(1);
  });

  it('derives sibling HD accounts from the same seed', async () => {
    const vault = await WalletVault.open({ directory: dir, kdf: { N: 1024, r: 8, p: 1 } });
    const { meta } = await vault.importMnemonic({ mnemonic: HARDHAT_MNEMONIC, label: 'hh' }, 'pw');
    await vault.unlock('pw');
    const { meta: second } = await vault.deriveAccount({ fromAccountId: meta.id });
    expect(second.address).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    expect(second.index).toBe(1);
    expect(second.mnemonicId).toBe(meta.mnemonicId);
    const { meta: third } = await vault.deriveAccount({ fromAccountId: meta.id, label: 'three' });
    expect(third.index).toBe(2);
    await expect(vault.deriveAccount({ fromAccountId: meta.id, index: 1 })).rejects.toThrow(/already exists/);
    vault.lock();
  });
});
