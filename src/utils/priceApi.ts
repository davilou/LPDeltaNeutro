import { logger } from './logger';
import type { ChainId } from '../lp/types';

// Native ETH in Uniswap V4 is address(0) — map to wrapped native token per chain
const ETH_NATIVE = '0x0000000000000000000000000000000000000000';

const WRAPPED_NATIVE: Record<string, string> = {
  'base':      '0x4200000000000000000000000000000000000006',
  'eth':       '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  'bsc':       '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  'arbitrum':  '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  'polygon':   '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
  'avalanche':        '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAE',
  'hyperliquid-l1':   '0x5555555555555555555555555555555555555555', // WHYPE
  'solana':           'So11111111111111111111111111111111111111112', // Wrapped SOL
};

// DexScreener chain slugs: https://api.dexscreener.com/latest/dex/pools/{chain}/{address}
const DEX_SCREENER_CHAIN: Record<string, string> = {
  'base':             'base',
  'eth':              'ethereum',
  'bsc':              'bsc',
  'arbitrum':         'arbitrum',
  'polygon':          'polygon',
  'avalanche':        'avalanche',
  'hyperliquid-l1':   'hyperevm',
  'solana':           'solana',
};

// CoinGecko asset platform IDs
const COINGECKO_PLATFORM: Record<string, string> = {
  'base':      'base',
  'eth':       'ethereum',
  'bsc':       'binance-smart-chain',
  'arbitrum':  'arbitrum-one',
  'polygon':   'polygon-pos',
  'avalanche': 'avalanche',
  'solana':    'solana',
  // hyperliquid-l1 not yet indexed by CoinGecko
};

function normalizeForApi(addr: string, chain: string): string {
  return addr.toLowerCase() === ETH_NATIVE ? (WRAPPED_NATIVE[chain] ?? WRAPPED_NATIVE['base']) : addr;
}

export interface PriceCacheEntry {
  price: number;
  updatedAt: number;
}

// Keyed by tokenId (number for EVM, string for Solana)
export const poolPriceCache: Map<string | number, PriceCacheEntry> = new Map();

export function getCachedPrice(tokenId: string | number): number | null {
  const entry = poolPriceCache.get(tokenId);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > 60_000) return null;
  return entry.price;
}

// GET /latest/dex/pairs/{chain}/{poolAddress}
// Returns priceNative (price of baseToken in quoteToken, human-readable) and baseToken address.
// V4 pool IDs are 32-byte hashes (66 chars) — DexScreener doesn't index them; skip immediately.
async function fetchPoolPriceDexScreener(
  poolAddress: string,
  chain: string,
): Promise<{ priceNative: number; baseTokenAddress: string } | null> {
  // V4 PoolId (32 bytes = 66 chars with 0x prefix) cannot be queried by pool address
  if (poolAddress.length > 42) return null;
  const chainSlug = DEX_SCREENER_CHAIN[chain];
  if (!chainSlug) return null;
  try {
    const url = `https://api.dexscreener.com/latest/dex/pairs/${chainSlug}/${poolAddress.toLowerCase()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) {
      logger.debug(`[PriceApi] DexScreener pairs HTTP ${res.status} for ${chainSlug}/${poolAddress}`);
      return null;
    }
    const data = await res.json() as Record<string, unknown>;
    const pairs = (data?.pairs as unknown[]);
    if (!Array.isArray(pairs) || pairs.length === 0) {
      logger.debug(`[PriceApi] DexScreener pairs no results for ${chainSlug}/${poolAddress}`);
      return null;
    }
    const pair = pairs[0] as Record<string, unknown>;
    const priceNative = parseFloat(pair?.priceNative as string);
    if (!isFinite(priceNative) || priceNative <= 0) return null;
    const baseToken = pair?.baseToken as Record<string, unknown>;
    return {
      priceNative,
      baseTokenAddress: (baseToken?.address as string ?? '').toLowerCase(),
    };
  } catch {
    return null;
  }
}

// GET /api/v3/simple/token_price/{platform}?contract_addresses={addr}&vs_currencies=usd
// Returns USD price of the given token (normalizes address(0) → wrapped native)
async function fetchTokenPriceCoingecko(tokenAddress: string, chain: string): Promise<number | null> {
  const platform = COINGECKO_PLATFORM[chain];
  if (!platform) return null;
  const addr = normalizeForApi(tokenAddress, chain);
  try {
    const url = `https://api.coingecko.com/api/v3/simple/token_price/${platform}?contract_addresses=${addr}&vs_currencies=usd`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    const entry = data?.[addr.toLowerCase()] as Record<string, unknown> | undefined;
    const price = entry?.usd;
    if (typeof price !== 'number' || price <= 0) return null;
    return price;
  } catch {
    return null;
  }
}

// DexScreener token endpoint — returns USD price of a token using priceUsd field.
// Used as secondary fallback (e.g. V4 pools that DexScreener doesn't index by pool ID).
async function fetchTokenUsdDexScreener(tokenAddress: string, chain: string): Promise<number | null> {
  const chainSlug = DEX_SCREENER_CHAIN[chain];
  if (!chainSlug) return null;
  const addr = normalizeForApi(tokenAddress, chain);
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${chainSlug}/${addr}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    const pairs = data?.pairs as unknown[];
    if (!Array.isArray(pairs) || pairs.length === 0) return null;
    // Take priceUsd from the most liquid pair (DexScreener returns them sorted by liquidity)
    const pair = pairs[0] as Record<string, unknown>;
    const priceUsd = parseFloat(pair?.priceUsd as string);
    if (!isFinite(priceUsd) || priceUsd <= 0) return null;
    return priceUsd;
  } catch {
    return null;
  }
}

export const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'USDbC', 'DAI', 'USDS', 'crvUSD']);

/** Returns true if the chain is supported by any external price API. */
export function isChainPriceSupported(chain: string): boolean {
  return chain in DEX_SCREENER_CHAIN || chain in COINGECKO_PLATFORM;
}

/**
 * Fetches the current pool price in Uniswap format (human-readable token1/token0).
 * Primary source: DexScreener (uses poolAddress — works best for V3).
 * Fallback: CoinGecko token price (works for any token by address).
 * Returns null if all sources fail.
 */
export async function fetchPoolPrice(
  poolAddress: string,
  token0Address: string,
  token0Symbol: string,
  token1Address: string,
  token1Symbol: string,
  chain: ChainId = 'base',
): Promise<number | null> {
  // --- DexScreener ---
  const dex = await fetchPoolPriceDexScreener(poolAddress, chain);
  if (dex !== null) {
    // priceNative = price of baseToken in quoteToken (human-readable)
    // Uniswap price = human-readable token1 per token0
    if (dex.baseTokenAddress === token0Address.toLowerCase()) {
      // baseToken is token0 → priceNative already is (token1 per token0)
      return dex.priceNative;
    } else {
      // baseToken is token1 → priceNative is (token0 per token1) → invert
      return 1 / dex.priceNative;
    }
  }

  // --- Fallback by token (DexScreener token endpoint, then CoinGecko) ---
  // Determine volatile token; get its USD price and convert to Uniswap format
  const token0IsStable = STABLE_SYMBOLS.has(token0Symbol);
  const token1IsStable = STABLE_SYMBOLS.has(token1Symbol);

  let volatileAddress: string;
  let volatileSymbol: string;
  let uniswapFromUsd: (usd: number) => number;

  if (!token0IsStable && token1IsStable) {
    // token0 volatile, token1 stable → Uniswap price ≈ USD price of token0
    volatileAddress = token0Address;
    volatileSymbol = token0Symbol;
    uniswapFromUsd = (usd) => usd;
  } else if (token0IsStable && !token1IsStable) {
    // token0 stable, token1 volatile → Uniswap price = 1 / USD price of token1
    volatileAddress = token1Address;
    volatileSymbol = token1Symbol;
    uniswapFromUsd = (usd) => 1 / usd;
  } else {
    return null; // both stable or both volatile — not supported
  }

  const dexToken = await fetchTokenUsdDexScreener(volatileAddress, chain);
  if (dexToken !== null) {
    logger.debug(`[PriceApi] DexScreener token fallback: ${volatileSymbol}=$${dexToken.toFixed(4)}`);
    return uniswapFromUsd(dexToken);
  }

  const cgToken = await fetchTokenPriceCoingecko(volatileAddress, chain);
  if (cgToken !== null) {
    logger.debug(`[PriceApi] CoinGecko fallback: ${volatileSymbol}=$${cgToken.toFixed(4)}`);
    return uniswapFromUsd(cgToken);
  }

  return null;
}

/**
 * Fetches the USD price of a single token by address.
 * Primary: DexScreener token endpoint. Fallback: CoinGecko.
 */
export async function fetchTokenUsd(tokenAddress: string, chain: ChainId): Promise<number | null> {
  const dex = await fetchTokenUsdDexScreener(tokenAddress, chain);
  if (dex !== null) return dex;
  return fetchTokenPriceCoingecko(tokenAddress, chain);
}
