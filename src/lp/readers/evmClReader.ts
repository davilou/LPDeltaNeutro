import { ethers } from 'ethers';
import { LPPosition } from '../../types';
import { logger } from '../../utils/logger';
import { getCachedPrice } from '../../utils/priceApi';
import { ChainId, DexId, ILPReader, PositionId } from '../types';
import { ChainDexAddresses, getChainDexAddresses } from '../chainRegistry';
import { getChainProvider } from '../chainProviders';
import { getTokenCache, TokenMeta, KNOWN_TOKENS_BY_CHAIN, seedTokenCache } from '../tokenCache';
import { config } from '../../config';

const POSITION_MANAGER_V3_ABI = [
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) returns (uint256 amount0, uint256 amount1)',
];

const POOL_V3_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

interface CachedPositionData {
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  token0Address: string;
  token1Address: string;
  tokensOwed0: number;
  tokensOwed1: number;
  feesCycleCount: number;
  cachedAt: number;
}

const POSITION_CACHE_TTL_MS = 30 * 60 * 1_000;

/**
 * LP reader for Uniswap V3-compatible DEXes on EVM chains.
 * Supports: Uniswap V3, Pancakeswap V3, Aerodrome CL — any DEX sharing the V3 position model.
 */
export class EvmClReader implements ILPReader {
  private readonly chain: ChainId;
  private readonly dex: DexId;
  private readonly addresses: ChainDexAddresses;
  private readonly positionDataCache: Map<number, CachedPositionData> = new Map();

  constructor(chain: ChainId, dex: DexId) {
    this.chain = chain;
    this.dex = dex;
    this.addresses = getChainDexAddresses(chain, dex);

    if (!this.addresses.positionManagerV3) {
      throw new Error(`EvmClReader: no positionManagerV3 address for ${chain}:${dex}`);
    }

    const known = KNOWN_TOKENS_BY_CHAIN[chain];
    if (known) seedTokenCache(chain, known);
  }

  async readPosition(id: PositionId, poolAddress: string): Promise<LPPosition> {
    const tokenId = Number(id);
    const fallback = getChainProvider(this.chain);

    return fallback.call(async (provider) => {
      const pm = new ethers.Contract(this.addresses.positionManagerV3!, POSITION_MANAGER_V3_ABI, provider);
      const now = Date.now();
      const cached = this.positionDataCache.get(tokenId);
      const needsFullRefresh = !cached || (now - cached.cachedAt > POSITION_CACHE_TTL_MS);

      let liquidity: bigint;
      let tickLower: number;
      let tickUpper: number;
      let token0Info: TokenMeta = { symbol: 'UNKNOWN', decimals: 18 };
      let token1Info: TokenMeta = { symbol: 'UNKNOWN', decimals: 18 };
      let tokensOwed0: number;
      let tokensOwed1: number;

      if (needsFullRefresh) {
        logger.info(`[Cache][${this.chain}:${this.dex}] Full refresh for V3 NFT #${tokenId}`);
        const pos = await pm.positions(tokenId);
        tickLower = Number(pos.tickLower);
        tickUpper = Number(pos.tickUpper);
        liquidity = BigInt(pos.liquidity);

        [token0Info, token1Info] = await Promise.all([
          this.getTokenInfo(provider, pos.token0),
          this.getTokenInfo(provider, pos.token1),
        ]);

        tokensOwed0 = Number(ethers.formatUnits(pos.tokensOwed0, token0Info.decimals));
        tokensOwed1 = Number(ethers.formatUnits(pos.tokensOwed1, token1Info.decimals));

        try {
          const MAX_UINT128 = (1n << 128n) - 1n;
          const res = await pm.collect.staticCall({
            tokenId,
            recipient: ethers.ZeroAddress,
            amount0Max: MAX_UINT128,
            amount1Max: MAX_UINT128,
          });
          tokensOwed0 = Number(ethers.formatUnits(res.amount0, token0Info.decimals));
          tokensOwed1 = Number(ethers.formatUnits(res.amount1, token1Info.decimals));
        } catch { }

        this.positionDataCache.set(tokenId, {
          liquidity, tickLower, tickUpper,
          token0Address: pos.token0,
          token1Address: pos.token1,
          tokensOwed0, tokensOwed1,
          feesCycleCount: 0,
          cachedAt: now,
        });
      } else {
        cached.feesCycleCount++;
        liquidity = cached.liquidity;
        tickLower = cached.tickLower;
        tickUpper = cached.tickUpper;

        [token0Info, token1Info] = await Promise.all([
          this.getTokenInfo(provider, cached.token0Address),
          this.getTokenInfo(provider, cached.token1Address),
        ]);

        if (cached.feesCycleCount >= config.positionCacheRefreshCycles) {
          logger.info(`[Cache][${this.chain}:${this.dex}] Refreshing fees for V3 NFT #${tokenId}`);
          try {
            const MAX_UINT128 = (1n << 128n) - 1n;
            const res = await pm.collect.staticCall({
              tokenId,
              recipient: ethers.ZeroAddress,
              amount0Max: MAX_UINT128,
              amount1Max: MAX_UINT128,
            });
            cached.tokensOwed0 = Number(ethers.formatUnits(res.amount0, token0Info.decimals));
            cached.tokensOwed1 = Number(ethers.formatUnits(res.amount1, token1Info.decimals));
          } catch { }
          cached.feesCycleCount = 0;
        } else {
          logger.info(`[Cache][${this.chain}:${this.dex}] Using cached position #${tokenId} (fee cycle ${cached.feesCycleCount}/${config.positionCacheRefreshCycles})`);
        }

        tokensOwed0 = cached.tokensOwed0;
        tokensOwed1 = cached.tokensOwed1;
      }

      const decimalAdj = token0Info.decimals - token1Info.decimals;
      let tickCurrent: number;
      const cachedPrice = getCachedPrice(tokenId);
      if (cachedPrice !== null) {
        const rawPrice = cachedPrice / Math.pow(10, decimalAdj);
        tickCurrent = Math.round(Math.log(rawPrice) / Math.log(1.0001));
      } else {
        const poolContract = new ethers.Contract(poolAddress, POOL_V3_ABI, provider);
        const slot0 = await poolContract.slot0();
        tickCurrent = Number(slot0.tick);
      }

      const price = Math.pow(1.0001, tickCurrent) * Math.pow(10, decimalAdj);
      const [amount0, amount1] = this.computeAmountsFromTicks(liquidity, tickCurrent, tickLower, tickUpper);

      const rangeStatus = tickCurrent < tickLower ? 'below-range'
        : tickCurrent >= tickUpper ? 'above-range'
        : 'in-range';

      const entry = this.positionDataCache.get(tokenId)!;

      return {
        token0: {
          address: entry.token0Address,
          symbol: token0Info.symbol,
          decimals: token0Info.decimals,
          amount: amount0,
          amountFormatted: Number(ethers.formatUnits(amount0, token0Info.decimals)),
        },
        token1: {
          address: entry.token1Address,
          symbol: token1Info.symbol,
          decimals: token1Info.decimals,
          amount: amount1,
          amountFormatted: Number(ethers.formatUnits(amount1, token1Info.decimals)),
        },
        price, rangeStatus, tickLower, tickUpper, tickCurrent,
        tokensOwed0, tokensOwed1, liquidity,
      };
    });
  }

  invalidateCache(id: PositionId): void {
    this.positionDataCache.delete(Number(id));
  }

  async getBlockOrSlot(): Promise<number> {
    return getChainProvider(this.chain).call(p => p.getBlockNumber());
  }

  private async getTokenInfo(provider: ethers.Provider, address: string): Promise<TokenMeta> {
    const addr = address.toLowerCase();
    const cache = getTokenCache(this.chain);
    const cached = cache.get(addr);
    if (cached) return cached;

    const token = new ethers.Contract(address, ERC20_ABI, provider);
    for (let i = 0; i < 3; i++) {
      try {
        const [decimals, symbol] = await Promise.all([token.decimals(), token.symbol()]);
        const info: TokenMeta = { symbol: String(symbol), decimals: Number(decimals) };
        cache.set(addr, info);
        return info;
      } catch (err) {
        if (i === 2) logger.warn(`Failed to get token info for ${address}: ${err}`);
        await new Promise(r => setTimeout(r, 500 * (i + 1)));
      }
    }
    return { symbol: 'UNKNOWN', decimals: 18 };
  }

  private computeAmountsFromTicks(
    liquidity: bigint, tickCurrent: number, tickLower: number, tickUpper: number,
  ): [bigint, bigint] {
    const sqrtPriceCurrent = Math.sqrt(Math.pow(1.0001, tickCurrent));
    const sqrtPriceLower   = Math.sqrt(Math.pow(1.0001, tickLower));
    const sqrtPriceUpper   = Math.sqrt(Math.pow(1.0001, tickUpper));
    const liq = Number(liquidity);
    let amount0 = 0, amount1 = 0;

    if (tickCurrent < tickLower) {
      amount0 = liq * (1 / sqrtPriceLower - 1 / sqrtPriceUpper);
    } else if (tickCurrent >= tickUpper) {
      amount1 = liq * (sqrtPriceUpper - sqrtPriceLower);
    } else {
      amount0 = liq * (1 / sqrtPriceCurrent - 1 / sqrtPriceUpper);
      amount1 = liq * (sqrtPriceCurrent - sqrtPriceLower);
    }

    return [BigInt(Math.floor(amount0)), BigInt(Math.floor(amount1))];
  }
}
