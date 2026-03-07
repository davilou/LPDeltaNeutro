import { ChainId } from './types';
import { FallbackProvider } from '../utils/fallbackProvider';
import { config } from '../config';

const providers = new Map<ChainId, FallbackProvider>();

const CHAIN_IDS: Partial<Record<ChainId, number>> = {
  base:      8453,
  eth:       1,
  bsc:       56,
  arbitrum:  42161,
  polygon:   137,
  avalanche: 43114,
};

function getRpcUrls(chain: ChainId): string[] {
  switch (chain) {
    case 'base':           return config.httpRpcUrls;
    case 'eth':            return config.ethHttpRpcUrls;
    case 'bsc':            return config.bscHttpRpcUrls;
    case 'arbitrum':       return config.arbHttpRpcUrls;
    case 'polygon':        return config.polygonHttpRpcUrls;
    case 'avalanche':      return config.avaxHttpRpcUrls;
    case 'hyperliquid-l1': return config.hlL1HttpRpcUrls;
    case 'solana':         return []; // Phase 2
    default:               return [];
  }
}

/**
 * Returns a shared FallbackProvider for the given chain.
 * Lazy-initialised on first call; singleton per chain.
 */
export function getChainProvider(chain: ChainId): FallbackProvider {
  const cached = providers.get(chain);
  if (cached) return cached;

  const urls = getRpcUrls(chain);
  if (urls.length === 0) {
    throw new Error(`No RPC URLs configured for chain=${chain}. Set ${chain.toUpperCase().replace(/-/g, '_')}_HTTP_RPC_URL in .env`);
  }

  const provider = new FallbackProvider(urls, CHAIN_IDS[chain]);
  providers.set(chain, provider);
  return provider;
}
