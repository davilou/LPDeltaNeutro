import type { ChainId, DexId } from './types';
import { logger } from '../utils/logger';
import { config } from '../config';

// Zapper numeric chainId → our ChainId
const ZAPPER_CHAIN_MAP: Record<number, ChainId> = {
  1: 'eth',
  8453: 'base',
  56: 'bsc',
  42161: 'arbitrum',
  137: 'polygon',
  43114: 'avalanche',
  999: 'hyperliquid-l1',
};

const ZAPPER_SUPPORTED_CHAINS = new Set<ChainId>(Object.values(ZAPPER_CHAIN_MAP));

/** Returns true if this chain can be discovered via Zapper API */
export function isZapperSupportedChain(chain: ChainId): boolean {
  return ZAPPER_SUPPORTED_CHAINS.has(chain);
}

// Map Zapper app displayName → candidate DexIds
function appNameToDexIds(displayName: string | null | undefined): DexId[] {
  if (!displayName) return [];
  const n = displayName.toLowerCase();
  if (n.includes('uniswap') && n.includes('v4')) return ['uniswap-v4'];
  if (n.includes('uniswap') && n.includes('v3')) return ['uniswap-v3'];
  if (n.includes('uniswap')) return ['uniswap-v3', 'uniswap-v4'];
  if (n.includes('pancakeswap') && n.includes('v4')) return ['pancake-v4'];
  if (n.includes('pancakeswap') && n.includes('v3')) return ['pancake-v3'];
  if (n.includes('pancakeswap') || n.includes('pancake')) return ['pancake-v3'];
  if (n.includes('aerodrome')) return ['aerodrome-cl'];
  if (n.includes('project x') || n.includes('project-x')) return ['project-x'];
  return [];
}

export interface ZapperComplexPosition {
  name: string;
  protocol: string;
  poolAddress: string;
  chainId: ChainId;
  dexId: DexId;
  usdValue: number;
  tokens: {
    address: string;
    symbol: string;
    decimals: number;
    amount: number;
    usdValue: number;
    price: number;
  }[];
}

const GRAPHQL_QUERY = `query LPPositions($addresses: [Address!]!) {
  portfolioV2(addresses: $addresses) {
    appBalances {
      byApp(first: 20) {
        edges {
          node {
            app { displayName }
            network { name chainId }
            positionBalances(first: 50) {
              edges {
                node {
                  ... on ContractPositionBalance {
                    type address balanceUSD groupLabel
                    tokens {
                      metaType
                      token {
                        ... on BaseTokenPositionBalance {
                          address symbol balance balanceUSD price
                        }
                      }
                    }
                    displayProps { label }
                  }
                  ... on AppTokenPositionBalance {
                    type symbol balance balanceUSD price groupLabel
                    displayProps { label }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

// Cache: deduplicates concurrent calls for the same wallet.
// All EvmScanner instances share a single in-flight Zapper request.
const _complexPositionCache = new Map<string, Promise<ZapperComplexPosition[] | null>>();

/**
 * Fetches complex LP positions from Zapper GraphQL API.
 * Concurrent calls for the same wallet are deduplicated (single API hit).
 */
export async function getZapperComplexPositions(walletAddress: string): Promise<ZapperComplexPosition[] | null> {
  const cacheKey = walletAddress.toLowerCase();

  if (_complexPositionCache.has(cacheKey)) {
    return _complexPositionCache.get(cacheKey)!;
  }

  const promise = _fetchComplexPositions(walletAddress);
  _complexPositionCache.set(cacheKey, promise);

  // Auto-clear after 30s so subsequent scans get fresh data
  setTimeout(() => _complexPositionCache.delete(cacheKey), 30_000);

  return promise;
}

async function _fetchComplexPositions(walletAddress: string): Promise<ZapperComplexPosition[] | null> {
  const apiKey = config.zapperApiKey;
  if (!apiKey) return null;

  const credentials = Buffer.from(`${apiKey}:`).toString('base64');

  try {
    const res = await fetch('https://public.zapper.xyz/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${credentials}`,
      },
      body: JSON.stringify({
        query: GRAPHQL_QUERY,
        variables: { addresses: [walletAddress] },
      }),
    });

    if (!res.ok) {
      logger.warn(`[Zapper] HTTP ${res.status} fetching positions for ${walletAddress}`);
      return null;
    }

    const json = await res.json() as any;
    const appEdges = json?.data?.portfolioV2?.appBalances?.byApp?.edges;
    if (!appEdges || !Array.isArray(appEdges)) {
      logger.warn(`[Zapper] Unexpected response structure for ${walletAddress}`);
      return null;
    }

    const results: ZapperComplexPosition[] = [];

    for (const appEdge of appEdges) {
      const appNode = appEdge?.node;
      if (!appNode) continue;

      const displayName: string = appNode.app?.displayName ?? '';
      const dexIds = appNameToDexIds(displayName);
      if (dexIds.length === 0) continue; // not a supported DEX

      const numericChainId: number | undefined = appNode.network?.chainId;
      if (!numericChainId) continue;

      const chainId = ZAPPER_CHAIN_MAP[numericChainId];
      if (!chainId) continue;

      const dexId = dexIds[0];

      const posEdges = appNode.positionBalances?.edges;
      if (!posEdges || !Array.isArray(posEdges)) continue;

      for (const posEdge of posEdges) {
        const posNode = posEdge?.node;
        if (!posNode) continue;

        // Only interested in contract positions (CL liquidity)
        const posType: string = posNode.type ?? '';
        if (posType !== 'contract-position') continue;

        const balanceUSD: number = posNode.balanceUSD ?? 0;
        if (balanceUSD < 10) continue; // filter <$10 positions

        const poolAddress: string = (posNode.address ?? '').toLowerCase();
        if (!poolAddress) continue;

        const label: string = posNode.displayProps?.label ?? '';

        // Extract tokens (only "supplied" metaType = actual liquidity tokens)
        const tokens: ZapperComplexPosition['tokens'] = [];
        const rawTokens = posNode.tokens ?? [];
        for (const t of rawTokens) {
          const tokenData = t?.token;
          if (!tokenData) continue;
          // Include supplied tokens (skip claimable/rewards)
          if (t.metaType && t.metaType !== 'supplied') continue;

          tokens.push({
            address: (tokenData.address ?? '').toLowerCase(),
            symbol: tokenData.symbol ?? 'UNKNOWN',
            decimals: 18, // Zapper doesn't return decimals — will be resolved on-chain
            amount: tokenData.balance ?? 0,
            usdValue: tokenData.balanceUSD ?? 0,
            price: tokenData.price ?? 0,
          });
        }

        results.push({
          name: label || `${displayName} Position`,
          protocol: displayName,
          poolAddress,
          chainId,
          dexId,
          usdValue: balanceUSD,
          tokens,
        });
      }
    }

    logger.info(`[Zapper] Fetched ${results.length} CL positions (>$10) for ${walletAddress}`);
    for (const p of results) {
      const tokenSymbols = p.tokens.map(t => t.symbol).join(' / ');
      logger.info(`[Zapper]   → ${p.protocol} | ${p.chainId} | ${tokenSymbols} | $${p.usdValue.toFixed(2)} | pool=${p.poolAddress} | "${p.name}"`);
    }
    return results;
  } catch (err) {
    logger.warn(`[Zapper] Request failed: ${err}`);
    return null;
  }
}
