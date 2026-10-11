/**
 * Registry of well-known EVM chains with public RPC endpoints.
 *
 * Users can add custom chains at runtime (or override RPC URLs) through the
 * wallet plugin config or the `wallet_chains` tool surface.
 *
 * @module dsh-web3-core/chains
 */

/** One chain entry in the registry. */
export interface ChainInfo {
  chainId: number;
  name: string;
  shortName: string;
  /** Native currency symbol (ETH, POL, BNB…). */
  symbol: string;
  decimals: number;
  /** Public JSON-RPC endpoints used when the user configures none. */
  rpc: string[];
  /** Block explorer base URL (no trailing slash), when known. */
  explorer?: string;
  /** Whether this chain is a testnet / devnet. */
  testnet: boolean;
}

const REGISTRY: ChainInfo[] = [
  {
    chainId: 1,
    name: 'Ethereum Mainnet',
    shortName: 'Ethereum',
    symbol: 'ETH',
    decimals: 18,
    rpc: [
      'https://ethereum-rpc.publicnode.com',
      'https://cloudflare-eth.com',
      'https://eth.drpc.org',
      'https://1rpc.io/eth',
      'https://eth-mainnet.public.blastapi.io',
      'https://eth.llamarpc.com',
    ],
    explorer: 'https://etherscan.io',
    testnet: false,
  },
  {
    chainId: 10,
    name: 'OP Mainnet',
    shortName: 'Optimism',
    symbol: 'ETH',
    decimals: 18,
    rpc: ['https://mainnet.optimism.io', 'https://optimism.llamarpc.com'],
    explorer: 'https://optimistic.etherscan.io',
    testnet: false,
  },
  {
    chainId: 56,
    name: 'BNB Smart Chain',
    shortName: 'BSC',
    symbol: 'BNB',
    decimals: 18,
    rpc: ['https://bsc-dataseed.binance.org', 'https://bsc.publicnode.com'],
    explorer: 'https://bscscan.com',
    testnet: false,
  },
  {
    chainId: 100,
    name: 'Gnosis Chain',
    shortName: 'Gnosis',
    symbol: 'XDAI',
    decimals: 18,
    rpc: ['https://rpc.gnosischain.com'],
    explorer: 'https://gnosisscan.io',
    testnet: false,
  },
  {
    chainId: 137,
    name: 'Polygon PoS',
    shortName: 'Polygon',
    symbol: 'POL',
    decimals: 18,
    rpc: [
      'https://polygon-bor-rpc.publicnode.com',
      'https://polygon.drpc.org',
      'https://1rpc.io/matic',
      'https://polygon-rpc.com',
    ],
    explorer: 'https://polygonscan.com',
    testnet: false,
  },
  {
    chainId: 8453,
    name: 'Base',
    shortName: 'Base',
    symbol: 'ETH',
    decimals: 18,
    rpc: ['https://mainnet.base.org', 'https://base.llamarpc.com'],
    explorer: 'https://basescan.org',
    testnet: false,
  },
  {
    chainId: 42161,
    name: 'Arbitrum One',
    shortName: 'Arbitrum',
    symbol: 'ETH',
    decimals: 18,
    rpc: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum.llamarpc.com'],
    explorer: 'https://arbiscan.io',
    testnet: false,
  },
  {
    chainId: 43114,
    name: 'Avalanche C-Chain',
    shortName: 'Avalanche',
    symbol: 'AVAX',
    decimals: 18,
    rpc: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain.publicnode.com'],
    explorer: 'https://snowtrace.io',
    testnet: false,
  },
  {
    chainId: 11155111,
    name: 'Sepolia Testnet',
    shortName: 'Sepolia',
    symbol: 'ETH',
    decimals: 18,
    rpc: [
      'https://ethereum-sepolia-rpc.publicnode.com',
      'https://sepolia.gateway.tenderly.co',
      'https://sepolia.drpc.org',
      'https://1rpc.io/sepolia',
    ],
    explorer: 'https://sepolia.etherscan.io',
    testnet: true,
  },
  {
    chainId: 80002,
    name: 'Polygon Amoy Testnet',
    shortName: 'Amoy',
    symbol: 'POL',
    decimals: 18,
    rpc: [
      'https://polygon-amoy-bor-rpc.publicnode.com',
      'https://rpc-amoy.polygon.technology',
    ],
    explorer: 'https://amoy.polygonscan.com',
    testnet: true,
  },
  {
    chainId: 84532,
    name: 'Base Sepolia Testnet',
    shortName: 'Base Sepolia',
    symbol: 'ETH',
    decimals: 18,
    rpc: ['https://sepolia.base.org'],
    explorer: 'https://sepolia.basescan.org',
    testnet: true,
  },
  {
    chainId: 421614,
    name: 'Arbitrum Sepolia Testnet',
    shortName: 'Arbitrum Sepolia',
    symbol: 'ETH',
    decimals: 18,
    rpc: ['https://sepolia-rollup.arbitrum.io/rpc'],
    explorer: 'https://sepolia.arbiscan.io',
    testnet: true,
  },
  {
    chainId: 11155420,
    name: 'OP Sepolia Testnet',
    shortName: 'OP Sepolia',
    symbol: 'ETH',
    decimals: 18,
    rpc: ['https://sepolia.optimism.io'],
    explorer: 'https://sepolia-optimism.etherscan.io',
    testnet: true,
  },
  {
    chainId: 17000,
    name: 'Holesky Testnet',
    shortName: 'Holesky',
    symbol: 'ETH',
    decimals: 18,
    rpc: ['https://ethereum-holesky-rpc.publicnode.com'],
    explorer: 'https://holesky.etherscan.io',
    testnet: true,
  },
  {
    chainId: 31337,
    name: 'Localhost (anvil / hardhat)',
    shortName: 'localhost',
    symbol: 'ETH',
    decimals: 18,
    rpc: ['http://127.0.0.1:8545'],
    testnet: true,
  },
];

/** All built-in chains, sorted by chainId. */
export function listChains(): ChainInfo[] {
  return [...REGISTRY].sort((a, b) => a.chainId - b.chainId);
}

/** Look up a chain by id (built-in registry only). */
export function getChain(chainId: number): ChainInfo | undefined {
  return REGISTRY.find((chain) => chain.chainId === chainId);
}

/** Build an explorer URL for a transaction or address. */
export function explorerUrl(chainId: number, kind: 'tx' | 'address', value: string): string | undefined {
  const chain = getChain(chainId);
  if (chain?.explorer === undefined) return undefined;
  return `${chain.explorer}/${kind}/${value}`;
}
