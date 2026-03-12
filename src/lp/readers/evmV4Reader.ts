import { ethers } from 'ethers';
import { LPPosition } from '../../types';
import { logger } from '../../utils/logger';
import { getCachedPrice } from '../../utils/priceApi';
import { ChainId, DexId, ILPReader, PositionId } from '../types';
import { ChainDexAddresses, getChainDexAddresses } from '../chainRegistry';
import { getLpProvider } from '../chainProviders';
import { getTokenCache, TokenMeta, KNOWN_TOKENS_BY_CHAIN, seedTokenCache } from '../tokenCache';
import { config } from '../../config';
import { ERC20_ABI, POSITION_MANAGER_V4_ABI, STATE_VIEW_V4_ABI } from '../abis';

interface CachedV4PositionData {
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  token0Address: string;
  token1Address: string;
  tokensOwed0: number;
  tokensOwed1: number;
  feesCycleCount: number;
  cachedAt: number;
  poolId: string;
}

export class EvmV4Reader implements ILPReader {
  private readonly chain: ChainId;
  private readonly dex: DexId;
  private readonly addresses: ChainDexAddresses;
  private readonly positionDataCache: Map<number, CachedV4PositionData> = new Map();

  constructor(chain: ChainId, dex: DexId) {
    this.chain = chain;
    this.dex = dex;
    this.addresses = getChainDexAddresses(chain, dex);

    if (!this.addresses.positionManagerV4 || !this.addresses.stateViewV4) {
      throw new Error(`EvmV4Reader: missing positionManagerV4 or stateViewV4 for ${chain}:${dex}`);
    }

    const known = KNOWN_TOKENS_BY_CHAIN[chain];
    if (known) seedTokenCache(chain, known);
  }

  async readPosition(id: PositionId, _poolAddress: string): Promise<LPPosition> {
    const tokenId = Number(id);
    const fallback = getLpProvider(this.chain);

    return fallback.call(async (provider) => {
      const pmAddress = this.addresses.positionManagerV4!;
      const svAddress = this.addresses.stateViewV4!;
      const pm = new ethers.Contract(pmAddress, POSITION_MANAGER_V4_ABI, provider);
      const stateView = new ethers.Contract(svAddress, STATE_VIEW_V4_ABI, provider);
      const now = Date.now();
      const cached = this.positionDataCache.get(tokenId);
      const needsFullRefresh = !cached || (now - cached.cachedAt > config.positionCacheTtlMs);

      let liquidity: bigint = 0n;
      let tickLower = 0;
      let tickUpper = 0;
      let token0Info: TokenMeta = { symbol: 'UNKNOWN', decimals: 18 };
      let token1Info: TokenMeta = { symbol: 'UNKNOWN', decimals: 18 };
      let tokensOwed0 = 0;
      let tokensOwed1 = 0;
      let poolId = '';

      if (needsFullRefresh) {
        logger.debug(`[Cache][${this.chain}:${this.dex}] Full refresh V4 #${tokenId}`);
        const { poolKey, info } = await pm.getPoolAndPositionInfo(tokenId);

        const infoBig = BigInt(info as string);
        const rawTickLower = Number((infoBig >> 8n) & 0xFFFFFFn);
        tickLower = rawTickLower > 0x7FFFFFn ? rawTickLower - 0x1000000 : rawTickLower;
        const rawTickUpper = Number((infoBig >> 32n) & 0xFFFFFFn);
        tickUpper = rawTickUpper > 0x7FFFFFn ? rawTickUpper - 0x1000000 : rawTickUpper;

        liquidity = BigInt(await pm.getPositionLiquidity(tokenId));

        [token0Info, token1Info] = await Promise.all([
          this.getTokenInfo(provider, poolKey.currency0),
          this.getTokenInfo(provider, poolKey.currency1),
        ]);

        poolId = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ['address', 'address', 'uint24', 'int24', 'address'],
            [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
          )
        );

        tokensOwed0 = 0;
        tokensOwed1 = 0;
        try {
          const fees = await this.computeV4Fees(stateView, pmAddress, poolId, tokenId, tickLower, tickUpper, liquidity);
          tokensOwed0 = Number(ethers.formatUnits(fees.fees0, token0Info.decimals));
          tokensOwed1 = Number(ethers.formatUnits(fees.fees1, token1Info.decimals));
        } catch (err) {
          logger.warn(`[V4][${this.chain}] Failed to compute fees for NFT #${tokenId}: ${err}`);
        }

        this.positionDataCache.set(tokenId, {
          liquidity, tickLower, tickUpper,
          token0Address: poolKey.currency0,
          token1Address: poolKey.currency1,
          tokensOwed0, tokensOwed1,
          feesCycleCount: 0,
          cachedAt: now,
          poolId,
        });
      } else {
        cached.feesCycleCount++;
        liquidity = cached.liquidity;
        tickLower = cached.tickLower;
        tickUpper = cached.tickUpper;
        poolId = cached.poolId;

        [token0Info, token1Info] = await Promise.all([
          this.getTokenInfo(provider, cached.token0Address),
          this.getTokenInfo(provider, cached.token1Address),
        ]);

        if (cached.feesCycleCount >= config.positionCacheRefreshCycles) {
          try {
            const fees = await this.computeV4Fees(stateView, pmAddress, poolId, tokenId, tickLower, tickUpper, liquidity);
            cached.tokensOwed0 = Number(ethers.formatUnits(fees.fees0, token0Info.decimals));
            cached.tokensOwed1 = Number(ethers.formatUnits(fees.fees1, token1Info.decimals));
          } catch (err) {
            logger.warn(`[V4][${this.chain}] Failed to refresh fees for NFT #${tokenId}: ${err}`);
          }
          cached.feesCycleCount = 0;
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
        const slot0 = await stateView.getSlot0(poolId);
        tickCurrent = Number(slot0.tick);
      }

      const price = Math.pow(1.0001, tickCurrent) * Math.pow(10, decimalAdj);
      const [amount0, amount1] = this.computeAmountsFromTicks(liquidity, tickCurrent, tickLower, tickUpper);

      const entry = this.positionDataCache.get(tokenId)!;
      const rangeStatus = tickCurrent < tickLower ? 'below-range'
        : tickCurrent >= tickUpper ? 'above-range'
        : 'in-range';

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
    return getLpProvider(this.chain).call(p => p.getBlockNumber());
  }

  /** Returns the cached V4 pool ID (bytes32) for this tokenId, or null if not yet cached. */
  getV4PoolId(tokenId: number): string | null {
    return this.positionDataCache.get(tokenId)?.poolId ?? null;
  }

  private async computeV4Fees(
    stateView: ethers.Contract,
    pmAddress: string,
    poolId: string,
    tokenId: number,
    tickLower: number,
    tickUpper: number,
    liquidity: bigint,
  ): Promise<{ fees0: bigint; fees1: bigint }> {
    const tokenIdBytes32 = ethers.zeroPadValue(ethers.toBeHex(tokenId), 32);
    const positionId = ethers.keccak256(
      ethers.solidityPacked(
        ['address', 'int24', 'int24', 'bytes32'],
        [pmAddress, tickLower, tickUpper, tokenIdBytes32],
      )
    );
    const [posInfo, growthInside] = await Promise.all([
      stateView.getPositionInfo(poolId, positionId),
      stateView.getFeeGrowthInside(poolId, tickLower, tickUpper),
    ]);
    const delta0 = BigInt.asUintN(256, BigInt(growthInside.feeGrowthInside0X128) - BigInt(posInfo.feeGrowthInside0LastX128));
    const delta1 = BigInt.asUintN(256, BigInt(growthInside.feeGrowthInside1X128) - BigInt(posInfo.feeGrowthInside1LastX128));
    return { fees0: (liquidity * delta0) >> 128n, fees1: (liquidity * delta1) >> 128n };
  }

  private async getTokenInfo(provider: ethers.Provider, address: string): Promise<TokenMeta> {
    const addr = address.toLowerCase();
    const cache = getTokenCache(this.chain);
    const cached = cache.get(addr);
    if (cached) return cached;
    try {
      const erc20 = new ethers.Contract(address, ERC20_ABI, provider);
      const [decimals, symbol] = await Promise.all([erc20.decimals(), erc20.symbol()]);
      const info: TokenMeta = { symbol: String(symbol), decimals: Number(decimals) };
      cache.set(addr, info);
      return info;
    } catch {
      return { symbol: 'UNKNOWN', decimals: 18 };
    }
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
