import { describe, expect, it } from 'vitest';
import { explorerUrl, getChain, listChains } from '../src/chains.js';

describe('chain registry', () => {
  it('contains the major mainnets and testnets', () => {
    const ids = listChains().map((chain) => chain.chainId);
    for (const expected of [1, 10, 56, 100, 137, 8453, 42161, 43114, 11155111, 31337]) {
      expect(ids).toContain(expected);
    }
  });

  it('looks up chains and flags testnets', () => {
    expect(getChain(1)?.testnet).toBe(false);
    expect(getChain(11155111)?.testnet).toBe(true);
    expect(getChain(999999)).toBeUndefined();
  });

  it('builds explorer urls', () => {
    expect(explorerUrl(1, 'tx', '0xabc')).toBe('https://etherscan.io/tx/0xabc');
    expect(explorerUrl(31337, 'tx', '0xabc')).toBeUndefined();
  });
});
