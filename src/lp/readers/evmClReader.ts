import { ethers } from 'ethers';
import { LPPosition } from '../../types';
import { logger } from '../../utils/logger';
import { getCachedPrice } from '../../utils/priceApi';
import { ChainId, DexId, ILPReader, PositionId } from '../types';
import { ChainDexAddresses, getChainDexAddresses } from '../chainRegistry';
import { getLpProvider } from '../chainProviders';
import { getTokenCache, TokenMeta, KNOWN_TOKENS_BY_CHAIN, seedTokenCache } from '../tokenCache';
import { config } from '../../config';
import { ERC20_ABI, POOL_V3_ABI, POOL_CL_ABI, POSITION_MANAGER_V3_ABI } from '../abis';

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

/**
 * LP reader for Uniswap V3-compatible DEXes on EVM chains.
 * Supports: Uniswap V3, Pancakeswap V3, Aerodrome CL — any DEX sharing the V3 position model.
 */
export class EvmClReader implements ILPReader {
  private readonly chain: ChainId;
  private readonly dex: DexId;
  private readonly addresses: ChainDexAddresses;
  private readonly slotAbi: string[];
  private readonly positionDataCache: Map<number, CachedPositionData> = new Map();

  constructor(chain: ChainId, dex: DexId) {
    this.chain = chain;
    this.dex = dex;
    this.addresses = getChainDexAddresses(chain, dex);
    this.slotAbi = dex === 'aerodrome-cl' ? POOL_CL_ABI : POOL_V3_ABI;

    if (!this.addresses.positionManagerV3) {
      throw new Error(`EvmClReader: no positionManagerV3 address for ${chain}:${dex}`);
    }

    const known = KNOWN_TOKENS_BY_CHAIN[chain];
    if (known) seedTokenCache(chain, known);
  }

  async readPosition(id: PositionId, poolAddress: string): Promise<LPPosition> {
    const tokenId = Number(id);
    const fallback = getLpProvider(this.chain);

    return fallback.call(async (provider) => {
      const pm = new ethers.Contract(this.addresses.positionManagerV3!, POSITION_MANAGER_V3_ABI, provider);
      const now = Date.now();
      const cached = this.positionDataCache.get(tokenId);
      const needsFullRefresh = !cached || (now - cached.cachedAt > config.positionCacheTtlMs);

      let liquidity: bigint;
      let tickLower: number;
      let tickUpper: number;
      let token0Info: TokenMeta = { symbol: 'UNKNOWN', decimals: 18 };
      let token1Info: TokenMeta = { symbol: 'UNKNOWN', decimals: 18 };
      let tokensOwed0: number;
      let tokensOwed1: number;

      if (needsFullRefresh) {
        logger.debug(`[Cache][${this.chain}:${this.dex}] Full refresh V3 #${tokenId}`);
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
          logger.debug(`[Cache][${this.chain}:${this.dex}] Fee refresh V3 #${tokenId}`);
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
          logger.debug(`[Cache][${this.chain}:${this.dex}] Cached V3 #${tokenId} (${cached.feesCycleCount}/${config.positionCacheRefreshCycles})`);
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
        const poolContract = new ethers.Contract(poolAddress, this.slotAbi, provider);
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

  refreshFees(id: PositionId): void {
    const cached = this.positionDataCache.get(Number(id));
    if (cached) cached.feesCycleCount = config.positionCacheRefreshCycles;
  }

  async getBlockOrSlot(): Promise<number> {
    return getLpProvider(this.chain).call(p => p.getBlockNumber());
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
