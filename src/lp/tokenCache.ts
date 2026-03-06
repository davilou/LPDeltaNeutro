import { ChainId } from './types';

export interface TokenMeta {
  symbol: string;
  decimals: number;
}

// Global cache — shared across all reader/scanner instances for the same chain.
// Avoids redundant decimals()/symbol() RPC calls.
const caches = new Map<ChainId, Map<string, TokenMeta>>();

export function getTokenCache(chain: ChainId): Map<string, TokenMeta> {
  let cache = caches.get(chain);
  if (!cache) {
    cache = new Map();
    caches.set(chain, cache);
  }
  return cache;
}

/** Inject known tokens into the cache (avoids RPC calls for well-known tokens). */
export function seedTokenCache(chain: ChainId, tokens: Record<string, TokenMeta>): void {
  const cache = getTokenCache(chain);
  for (const [addr, meta] of Object.entries(tokens)) {
    cache.set(addr.toLowerCase(), meta);
  }
}

/** Known tokens per chain — seeded at startup to avoid RPC calls. */
export const KNOWN_TOKENS_BY_CHAIN: Partial<Record<ChainId, Record<string, TokenMeta>>> = {
  base: {
    '0x0000000000000000000000000000000000000000': { symbol: 'ETH',   decimals: 18 },
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC',  decimals: 6  },
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { symbol: 'USDbC', decimals: 6  },
    '0x4200000000000000000000000000000000000006': { symbol: 'WETH',  decimals: 18 },
    '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': { symbol: 'cbBTC', decimals: 8  },
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI',   decimals: 18 },
    '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': { symbol: 'USDT',  decimals: 6  },
  },
  eth: {
    '0x0000000000000000000000000000000000000000': { symbol: 'ETH',   decimals: 18 },
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH',  decimals: 18 },
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC',  decimals: 6  },
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT',  decimals: 6  },
    '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI',   decimals: 18 },
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC',  decimals: 8  },
  },
  bsc: {
    '0x0000000000000000000000000000000000000000': { symbol: 'BNB',   decimals: 18 },
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': { symbol: 'WBNB',  decimals: 18 },
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { symbol: 'USDC',  decimals: 18 },
    '0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT',  decimals: 18 },
    '0xe9e7cea3dedca5984780bafc599bd69add087d56': { symbol: 'BUSD',  decimals: 18 },
  },
  arbitrum: {
    '0x0000000000000000000000000000000000000000': { symbol: 'ETH',   decimals: 18 },
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': { symbol: 'WETH',  decimals: 18 },
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { symbol: 'USDC',  decimals: 6  },
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT',  decimals: 6  },
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI',   decimals: 18 },
  },
  polygon: {
    '0x0000000000000000000000000000000000000000': { symbol: 'MATIC', decimals: 18 },
    '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': { symbol: 'WMATIC',decimals: 18 },
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': { symbol: 'USDC',  decimals: 6  },
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': { symbol: 'USDT',  decimals: 6  },
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': { symbol: 'DAI',   decimals: 18 },
  },
  avalanche: {
    '0x0000000000000000000000000000000000000000': { symbol: 'AVAX',  decimals: 18 },
    '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7': { symbol: 'WAVAX', decimals: 18 },
    '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': { symbol: 'USDC',  decimals: 6  },
    '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7': { symbol: 'USDT',  decimals: 6  },
  },
};
