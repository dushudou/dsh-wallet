/**
 * Registry of well-known ERC-20 tokens per chain.
 *
 * Agents refer to tokens by symbol ("send 5 USDC"); resolving a symbol to a
 * contract address is exactly where a hallucinated or look-alike address
 * would lose funds, so symbols resolve only through this curated table (or
 * the user's configured tokens) — never through model-supplied guesses.
 * Decimals listed here are cross-checked against the chain at transfer time.
 *
 * @module dsh-web3-core/tokens
 */

/** One well-known token on one chain. */
export interface KnownToken {
  chainId: number;
  /** Checksummed contract address. */
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /** EIP-712 domain (name/version) for EIP-2612 / EIP-3009 signing, when known. */
  eip712?: { name: string; version: string };
  /** Whether this token is a USD stablecoin. */
  stable?: boolean;
}

const USD_COIN_V2 = { name: 'USD Coin', version: '2' };
const USDC_V2 = { name: 'USDC', version: '2' };

const REGISTRY: KnownToken[] = [
  // Ethereum
  { chainId: 1, address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin', decimals: 6, eip712: USD_COIN_V2, stable: true },
  { chainId: 1, address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', name: 'Tether USD', decimals: 6, stable: true },
  { chainId: 1, address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', name: 'Dai Stablecoin', decimals: 18, stable: true },
  { chainId: 1, address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
  // OP Mainnet
  { chainId: 10, address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', name: 'USD Coin', decimals: 6, eip712: USD_COIN_V2, stable: true },
  { chainId: 10, address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', symbol: 'USDT', name: 'Tether USD', decimals: 6, stable: true },
  { chainId: 10, address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
  // BNB Smart Chain (note: 18-decimal stablecoins)
  { chainId: 56, address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', name: 'USD Coin', decimals: 18, stable: true },
  { chainId: 56, address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', name: 'Tether USD', decimals: 18, stable: true },
  // Polygon PoS
  { chainId: 137, address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', name: 'USD Coin', decimals: 6, eip712: USD_COIN_V2, stable: true },
  { chainId: 137, address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT', name: 'Tether USD', decimals: 6, stable: true },
  { chainId: 137, address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
  // Base
  { chainId: 8453, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6, eip712: USD_COIN_V2, stable: true },
  { chainId: 8453, address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
  // Arbitrum One
  { chainId: 42161, address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', name: 'USD Coin', decimals: 6, eip712: USD_COIN_V2, stable: true },
  { chainId: 42161, address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', name: 'Tether USD', decimals: 6, stable: true },
  { chainId: 42161, address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
  // Avalanche C-Chain
  { chainId: 43114, address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', symbol: 'USDC', name: 'USD Coin', decimals: 6, eip712: USD_COIN_V2, stable: true },
  { chainId: 43114, address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', symbol: 'USDT', name: 'Tether USD', decimals: 6, stable: true },
  // Sepolia (Circle testnet USDC)
  { chainId: 11155111, address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', symbol: 'USDC', name: 'USDC', decimals: 6, eip712: USDC_V2, stable: true },
  // Base Sepolia (Circle testnet USDC)
  { chainId: 84532, address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', symbol: 'USDC', name: 'USDC', decimals: 6, eip712: USDC_V2, stable: true },
];

/** All well-known tokens on one chain. */
export function knownTokens(chainId: number): KnownToken[] {
  return REGISTRY.filter((token) => token.chainId === Number(chainId)).map((token) => ({ ...token }));
}

/** Look up a well-known token by symbol (case-insensitive) or address. */
export function findKnownToken(chainId: number, symbolOrAddress: string): KnownToken | undefined {
  const needle = symbolOrAddress.trim().toLowerCase();
  const found = REGISTRY.find(
    (token) =>
      token.chainId === Number(chainId) &&
      (token.address.toLowerCase() === needle || token.symbol.toLowerCase() === needle),
  );
  return found === undefined ? undefined : { ...found };
}
