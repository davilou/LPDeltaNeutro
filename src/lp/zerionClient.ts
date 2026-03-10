import type { ChainId, DexId } from './types';
import { logger } from '../utils/logger';
import { config } from '../config';

// Zerion chain slug → our ChainId
const ZERION_CHAIN_MAP: Record<string, ChainId> = {
  'ethereum': 'eth',
  'base': 'base',
  'binance-smart-chain': 'bsc',
  'arbitrum': 'arbitrum',
  'polygon': 'polygon',
  'avalanche': 'avalanche',
  'hyperevm': 'hyperliquid-l1',
};

const ZERION_SUPPORTED_CHAINS = new Set<ChainId>(Object.values(ZERION_CHAIN_MAP));

/** Returns true if this chain can be discovered via Zerion API */
export function isZerionSupportedChain(chain: ChainId): boolean {
  return ZERION_SUPPORTED_CHAINS.has(chain);
}

// Map Zerion protocol string → candidate DexIds
function protocolToDexIds(protocol: string | null | undefined): DexId[] {
  if (!protocol) return [];
  const p = protocol.toLowerCase();
  if (p.includes('uniswap-v4') || p.includes('uniswap v4')) return ['uniswap-v4'];
  if (p.includes('uniswap-v3') || p.includes('uniswap v3')) return ['uniswap-v3'];
  if (p.includes('uniswap')) return ['uniswap-v3', 'uniswap-v4']; // version unknown
  if (p.includes('pancake') && p.includes('v4')) return ['pancake-v4'];
  if (p.includes('pancake')) return ['pancake-v3'];
  if (p.includes('aerodrome')) return ['aerodrome-cl'];
  if (p.includes('project-x') || p.includes('project x')) return ['project-x'];
  return [];
}

export interface ZerionComplexPosition {
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

// Cache: deduplicates concurrent calls for the same wallet.
// All 18 EvmScanner instances share a single in-flight Zerion request.
const _complexPositionCache = new Map<string, Promise<ZerionComplexPosition[] | null>>();

/**
 * Fetches complex LP positions directly from Zerion.
 * Extracts tokens, amounts, pool address, and USD value.
 * Concurrent calls for the same wallet are deduplicated (single API hit).
 */
export async function getZerionComplexPositions(walletAddress: string): Promise<ZerionComplexPosition[] | null> {
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

async function _fetchComplexPositions(walletAddress: string): Promise<ZerionComplexPosition[] | null> {
  const apiKey = config.zerionApiKey;
  if (!apiKey) return null;

  const credentials = Buffer.from(`${apiKey}:`).toString('base64');
  const headers = {
    'Authorization': `Basic ${credentials}`,
    'Accept': 'application/json',
  };

  let url: string | null =
    `https://api.zerion.io/v1/wallets/${walletAddress}/positions/` +
    `?filter[positions]=only_complex&currency=usd&filter[position_types]=deposit&filter[trash]=only_non_trash&sort=value&sync=false`;

  const positionsByGroup = new Map<string, any[]>();
  const protocolMap = new Map<string, any>();

  try {
    while (url) {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        logger.warn(`[Zerion] HTTP ${res.status} fetching complex positions for ${walletAddress}`);
        return null;
      }

      const json = await res.json() as any;

      for (const item of json.data ?? []) {
        if (item.attributes.position_type !== 'deposit') continue;
        const groupId = item.attributes.group_id;
        if (!groupId) continue;

        if (!positionsByGroup.has(groupId)) {
          positionsByGroup.set(groupId, []);
        }
        positionsByGroup.get(groupId)!.push(item);
        protocolMap.set(groupId, item);
      }

      url = json.links?.next ?? null;
    }
  } catch (err) {
    logger.warn(`[Zerion] Request failed: ${err}`);
    return null;
  }

  const results: ZerionComplexPosition[] = [];

  for (const [groupId, items] of positionsByGroup) {
    const mainItem = items[0];
    const protocolStr = mainItem.attributes.protocol;
    const dexIds = protocolToDexIds(protocolStr);

    const zerionChain = mainItem.relationships?.chain?.data?.id;
    if (!zerionChain) continue;

    const chainId = ZERION_CHAIN_MAP[zerionChain];
    if (!chainId) continue;

    if (dexIds.length === 0) {
      logger.warn(`[Zerion] Unrecognized protocol="${protocolStr}" on chain="${zerionChain}" (${chainId}) — position skipped`);
      continue;
    }
    const dexId = dexIds[0];

    const name = mainItem.attributes.name || 'Unknown Position';
    const poolAddress = mainItem.attributes.pool_address?.toLowerCase();

    // We only support pool-based dexes right now
    if (!poolAddress) {
      logger.warn(`[Zerion] No pool_address for protocol="${protocolStr}" name="${name}" chain="${zerionChain}" — position skipped`);
      continue;
    }

    let totalUsd = 0;
    const tokens = [];

    for (const item of items) {
      const quantity = item.attributes.quantity;
      const amount = quantity ? Number(quantity.numeric || quantity.float) : 0;
      const usdValue = item.attributes.value || 0;
      const price = item.attributes.price || 0;

      let tokenAddr = '';
      const impls = item.attributes.fungible_info?.implementations || [];
      const impl = impls.find((i: any) => i.chain_id === zerionChain);
      if (impl && impl.address) {
        tokenAddr = impl.address.toLowerCase();
      }

      totalUsd += usdValue;

      tokens.push({
        address: tokenAddr,
        symbol: item.attributes.fungible_info?.symbol || 'UNKNOWN',
        decimals: quantity ? quantity.decimals : 18,
        amount,
        usdValue,
        price
      });
    }

    results.push({
      name,
      protocol: protocolStr,
      poolAddress,
      chainId,
      dexId,
      usdValue: totalUsd,
      tokens
    });
  }

  logger.info(`[Zerion] Fetched ${results.length} complex LP positions for ${walletAddress}`);
  return results;
}
