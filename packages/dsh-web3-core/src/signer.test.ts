import { describe, expect, it } from 'vitest';
import { Transaction, Wallet, getAddress } from 'ethers';
import {
  describeTransaction,
  populateTransaction,
  signMessage,
  signTransaction,
  signTypedData,
  verifyEip191,
  verifyEip712,
} from '../src/signer.js';
import { MockChainProvider } from './testing.js';

const HARDHAT_ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const HARDHAT_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('transaction population', () => {
  it('fills nonce, gas, and EIP-1559 fees from the provider', async () => {
    const provider = new MockChainProvider(31337);
    provider.nonces.set(HARDHAT_ACCOUNT_0.toLowerCase(), 7);
    const populated = await populateTransaction(
      { from: HARDHAT_ACCOUNT_0, chainId: 31337, to: RECIPIENT, value: '1000000000000000000' },
      provider,
    );
    expect(populated.type).toBe(2);
    expect(populated.nonce).toBe(7);
    expect(populated.maxFeePerGas).toBe(2_000_000_000n);
    expect(populated.gasLimit).toBe(51_000n); // 21000 estimate + 30000 buffer
    expect(populated.value).toBe(1_000_000_000_000_000_000n);
  });

  it('uses legacy gas price when the chain has no EIP-1559 fees', async () => {
    const provider = new MockChainProvider(31337);
    provider.feeData = { gasPrice: 1_500_000_000n };
    const populated = await populateTransaction(
      { from: HARDHAT_ACCOUNT_0, chainId: 31337, to: RECIPIENT },
      provider,
    );
    expect(populated.type).toBe(0);
    expect(populated.gasPrice).toBe(1_500_000_000n);
    expect(populated.maxFeePerGas).toBeUndefined();
  });

  it('describes itself for approvals without secrets', async () => {
    const provider = new MockChainProvider(1);
    const populated = await populateTransaction(
      {
        from: HARDHAT_ACCOUNT_0,
        chainId: 1,
        to: RECIPIENT,
        value: '1500000000000000000',
        data: '0xa9059cbb' + '00'.repeat(64),
      },
      provider,
    );
    const human = describeTransaction(populated);
    expect(human.chainId).toBe(1);
    expect(human.valueNative).toBe('1.5');
    expect(human.selector).toBe('0xa9059cbb');
    expect(human.dataLengthBytes).toBe(68);
    expect(JSON.stringify(human)).not.toContain(HARDHAT_KEY_0);
  });
});

describe('transaction signing', () => {
  it('signs an EIP-1559 transaction that recovers to the sender', async () => {
    const provider = new MockChainProvider(31337);
    provider.nonces.set(HARDHAT_ACCOUNT_0.toLowerCase(), 3);
    const wallet = new Wallet(HARDHAT_KEY_0);
    const populated = await populateTransaction(
      { from: wallet.address, chainId: 31337, to: RECIPIENT, value: 123n },
      provider,
    );
    const signed = await signTransaction(wallet, populated);
    expect(signed.raw).toMatch(/^0x02/); // EIP-1559 type prefix
    const parsed = Transaction.from(signed.raw);
    expect(parsed.type).toBe(2);
    expect(parsed.chainId).toBe(31337n);
    expect(parsed.to?.toLowerCase()).toBe(RECIPIENT.toLowerCase());
    expect(parsed.value).toBe(123n);
    expect(getAddress(parsed.from!)).toBe(HARDHAT_ACCOUNT_0);
    expect(signed.hash).toBe(parsed.hash);
  });

  it('signs a legacy transaction with EIP-155 replay protection', async () => {
    const provider = new MockChainProvider(31337);
    provider.feeData = { gasPrice: 1_000_000_000n };
    const wallet = new Wallet(HARDHAT_KEY_0);
    const populated = await populateTransaction(
      { from: wallet.address, chainId: 31337, to: RECIPIENT, type: 0 },
      provider,
    );
    const signed = await signTransaction(wallet, populated);
    const parsed = Transaction.from(signed.raw);
    expect(parsed.type).toBe(0);
    expect(parsed.chainId).toBe(31337n);
    expect(getAddress(parsed.from!)).toBe(HARDHAT_ACCOUNT_0);
  });
});

describe('message and typed-data signing', () => {
  it('signs EIP-191 personal messages verifiably', async () => {
    const wallet = new Wallet(HARDHAT_KEY_0);
    const { signature } = await signMessage(wallet, 'hello world');
    expect(verifyEip191('hello world', signature)).toBe(HARDHAT_ACCOUNT_0);
  });

  it('signs the canonical EIP-712 mail example verifiably', async () => {
    const wallet = new Wallet(HARDHAT_KEY_0);
    const domain = {
      name: 'Ether Mail',
      version: '1',
      chainId: 1,
      verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
    };
    const types = {
      Person: [
        { name: 'name', type: 'string' },
        { name: 'wallet', type: 'address' },
      ],
      Mail: [
        { name: 'from', type: 'Person' },
        { name: 'to', type: 'Person' },
        { name: 'contents', type: 'string' },
      ],
    };
    const value = {
      from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
      to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
      contents: 'Hello, Bob!',
    };
    const { signature } = await signTypedData(wallet, domain, types, value);
    expect(verifyEip712(domain, types, value, signature)).toBe(HARDHAT_ACCOUNT_0);
  });
});
