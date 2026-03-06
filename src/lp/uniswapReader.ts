import { ethers } from 'ethers';
import { config } from '../config';
import { LPPosition, TokenInfo } from '../types';
import { logger } from '../utils/logger';
import { FallbackProvider } from '../utils/fallbackProvider';
import { getCachedPrice } from '../utils/priceApi';

const POSITION_MANAGER_V3_ABI = [
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) returns (uint256 amount0, uint256 amount1)',
];

const POSITION_MANAGER_V4_ABI = [
  // PositionInfo encoded as bytes32 to avoid ethers.js v6 signed-uint overflow on high bits
  'function getPoolAndPositionInfo(uint256 tokenId) view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bytes32 info)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)',
  'function collect(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) returns (uint256 amount0, uint256 amount1)',
];

const STATE_VIEW_V4_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getPositionInfo(bytes32 poolId, bytes32 positionId) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)',
  'function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)',
];

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const POOL_V3_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

// Fallback token info for known Base chain tokens — used when RPC fails to return ERC20 metadata
const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  // Native ETH in Uniswap V4 is address(0)
  '0x0000000000000000000000000000000000000000': { symbol: 'ETH',   decimals: 18 },
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC',  decimals: 6  },
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { symbol: 'USDbC', decimals: 6  },
  '0x4200000000000000000000000000000000000006': { symbol: 'WETH',  decimals: 18 },
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': { symbol: 'cbBTC', decimals: 8  },
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI',   decimals: 18 },
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': { symbol: 'USDT',  decimals: 6  },
};

const POSITION_MANAGER_V3_ADDRESS = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const POSITION_MANAGER_V4_ADDRESS_DEFAULT = '0x7c5f5a4bbd8fd63184577525326123b519429bdc';
const STATE_VIEW_V4_ADDRESS = '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71';
const POSITION_CACHE_TTL_MS = 30 * 60 * 1_000; // 30 minutes

interface CachedPositionData {
  version: 'v3' | 'v4';
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  token0Address: string;
  token1Address: string;
  tokensOwed0: number;
  tokensOwed1: number;
  feesCycleCount: number;
  cachedAt: number;
  // V4-specific: needed for slot0 RPC fallback
  poolId?: string;
}

export class UniswapReader {
  private fallback: FallbackProvider;
  private tokenInfoCache: Map<string, Omit<TokenInfo, 'amount' | 'amountFormatted'>> = new Map();
  private positionDataCache: Map<number, CachedPositionData> = new Map();

  constructor() {
    this.fallback = new FallbackProvider(config.httpRpcUrls);
  }

  async readPosition(tokenId: number, poolAddress: string, version: 'v3' | 'v4' = 'v3'): Promise<LPPosition> {
    return this.fallback.call(async (provider) => {
      if (version === 'v4') {
        return this.readV4Position(tokenId, provider);
      } else {
        return this.readV3Position(tokenId, poolAddress, provider);
      }
    });
  }

  private async readV3Position(tokenId: number, poolAddress: string, provider: ethers.Provider): Promise<LPPosition> {
    const pm = new ethers.Contract(POSITION_MANAGER_V3_ADDRESS, POSITION_MANAGER_V3_ABI, provider);
    const now = Date.now();
    const cached = this.positionDataCache.get(tokenId);
    const needsFullRefresh = !cached || cached.version !== 'v3' || (now - cached.cachedAt > POSITION_CACHE_TTL_MS);

    let liquidity: bigint;
    let tickLower: number;
    let tickUpper: number;
    let token0Info: Omit<TokenInfo, 'amount' | 'amountFormatted'>;
    let token1Info: Omit<TokenInfo, 'amount' | 'amountFormatted'>;
    let tokensOwed0: number;
    let tokensOwed1: number;

    if (needsFullRefresh) {
      logger.info(`[Cache] Full refresh for V3 NFT #${tokenId}`);
      const pos = await pm.positions(tokenId);
      tickLower = Number(pos.tickLower);
      tickUpper = Number(pos.tickUpper);
      liquidity = BigInt(pos.liquidity);

      [token0Info, token1Info] = await Promise.all([
        this.getTokenInfo(provider, pos.token0),
        this.getTokenInfo(provider, pos.token1),
      ]);

      // Fetch fees
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
        version: 'v3',
        liquidity,
        tickLower,
        tickUpper,
        token0Address: pos.token0,
        token1Address: pos.token1,
        tokensOwed0,
        tokensOwed1,
        feesCycleCount: 0,
        cachedAt: now,
      });
    } else {
      // Cache hit
      cached.feesCycleCount++;
      liquidity = cached.liquidity;
      tickLower = cached.tickLower;
      tickUpper = cached.tickUpper;

      [token0Info, token1Info] = await Promise.all([
        this.getTokenInfo(provider, cached.token0Address),
        this.getTokenInfo(provider, cached.token1Address),
      ]);

      if (cached.feesCycleCount >= config.positionCacheRefreshCycles) {
        logger.info(`[Cache] Refreshing fees via RPC for V3 NFT #${tokenId}`);
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
        logger.info(`[Cache] Using cached position for V3 NFT #${tokenId} (fee cycle ${cached.feesCycleCount}/${config.positionCacheRefreshCycles})`);
      }

      tokensOwed0 = cached.tokensOwed0;
      tokensOwed1 = cached.tokensOwed1;
    }

    // Resolve tick from poolPriceCache (0 RPC) or fallback to slot0 (1 RPC)
    const decimalAdj = token0Info.decimals - token1Info.decimals;
    let tickCurrent: number;
    const cachedPrice = getCachedPrice(tokenId);
    if (cachedPrice !== null) {
      // price = 1.0001^tick * 10^decimalAdj → rawPrice = price / 10^decimalAdj = 1.0001^tick
      const rawPrice = cachedPrice / Math.pow(10, decimalAdj);
      tickCurrent = Math.round(Math.log(rawPrice) / Math.log(1.0001));
    } else {
      const poolContract = new ethers.Contract(poolAddress, POOL_V3_ABI, provider);
      const slot0 = await poolContract.slot0();
      tickCurrent = Number(slot0.tick);
    }

    const price = Math.pow(1.0001, tickCurrent) * Math.pow(10, decimalAdj);
    const [amount0, amount1] = this.computeAmountsFromTicks(liquidity, tickCurrent, tickLower, tickUpper);

    let rangeStatus: 'in-range' | 'above-range' | 'below-range';
    if (tickCurrent < tickLower) {
      rangeStatus = 'below-range';
    } else if (tickCurrent >= tickUpper) {
      rangeStatus = 'above-range';
    } else {
      rangeStatus = 'in-range';
    }

    return {
      token0: { ...token0Info, amount: amount0, amountFormatted: Number(ethers.formatUnits(amount0, token0Info.decimals)) },
      token1: { ...token1Info, amount: amount1, amountFormatted: Number(ethers.formatUnits(amount1, token1Info.decimals)) },
      price,
      rangeStatus,
      tickLower,
      tickUpper,
      tickCurrent,
      tokensOwed0,
      tokensOwed1,
      liquidity,
    };
  }

  private async readV4Position(tokenId: number, provider: ethers.Provider): Promise<LPPosition> {
    const pmAddress = config.positionManagerV4Address || POSITION_MANAGER_V4_ADDRESS_DEFAULT;
    const pm = new ethers.Contract(pmAddress, POSITION_MANAGER_V4_ABI, provider);
    const now = Date.now();
    const cached = this.positionDataCache.get(tokenId);
    const needsFullRefresh = !cached || cached.version !== 'v4' || (now - cached.cachedAt > POSITION_CACHE_TTL_MS);

    let liquidity: bigint;
    let tickLower: number;
    let tickUpper: number;
    let token0Info: Omit<TokenInfo, 'amount' | 'amountFormatted'>;
    let token1Info: Omit<TokenInfo, 'amount' | 'amountFormatted'>;
    let tokensOwed0: number;
    let tokensOwed1: number;
    let poolId: string;

    if (needsFullRefresh) {
      logger.info(`[Cache] Full refresh for V4 NFT #${tokenId}`);
      const { poolKey, info } = await pm.getPoolAndPositionInfo(tokenId);

      // PositionInfo (bytes32) bit layout:
      // bits 0-7: flags, bits 8-31: tickLower (int24), bits 32-55: tickUpper (int24)
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

      // Fees via StateView (V4 collect.staticCall fails due to PoolManager lock mechanism)
      tokensOwed0 = 0;
      tokensOwed1 = 0;
      try {
        const stateView = new ethers.Contract(STATE_VIEW_V4_ADDRESS, STATE_VIEW_V4_ABI, provider);
        const fees = await this.computeV4Fees(stateView, pmAddress, poolId, tokenId, tickLower, tickUpper, liquidity);
        tokensOwed0 = Number(ethers.formatUnits(fees.fees0, token0Info.decimals));
        tokensOwed1 = Number(ethers.formatUnits(fees.fees1, token1Info.decimals));
      } catch (err) {
        logger.warn(`[V4] Failed to compute fees for NFT #${tokenId}: ${err}`);
      }

      this.positionDataCache.set(tokenId, {
        version: 'v4',
        liquidity,
        tickLower,
        tickUpper,
        token0Address: poolKey.currency0,
        token1Address: poolKey.currency1,
        tokensOwed0,
        tokensOwed1,
        feesCycleCount: 0,
        cachedAt: now,
        poolId,
      });
    } else {
      // Cache hit
      cached.feesCycleCount++;
      liquidity = cached.liquidity;
      tickLower = cached.tickLower;
      tickUpper = cached.tickUpper;
      poolId = cached.poolId!;

      [token0Info, token1Info] = await Promise.all([
        this.getTokenInfo(provider, cached.token0Address),
        this.getTokenInfo(provider, cached.token1Address),
      ]);

      if (cached.feesCycleCount >= config.positionCacheRefreshCycles) {
        logger.info(`[Cache] Refreshing fees via StateView for V4 NFT #${tokenId}`);
        try {
          const stateView = new ethers.Contract(STATE_VIEW_V4_ADDRESS, STATE_VIEW_V4_ABI, provider);
          const fees = await this.computeV4Fees(stateView, pmAddress, poolId, tokenId, tickLower, tickUpper, liquidity);
          cached.tokensOwed0 = Number(ethers.formatUnits(fees.fees0, token0Info.decimals));
          cached.tokensOwed1 = Number(ethers.formatUnits(fees.fees1, token1Info.decimals));
        } catch (err) {
          logger.warn(`[V4] Failed to refresh fees for NFT #${tokenId}: ${err}`);
        }
        cached.feesCycleCount = 0;
      } else {
        logger.info(`[Cache] Using cached position for V4 NFT #${tokenId} (fee cycle ${cached.feesCycleCount}/${config.positionCacheRefreshCycles})`);
      }

      tokensOwed0 = cached.tokensOwed0;
      tokensOwed1 = cached.tokensOwed1;
    }

    // Resolve tick from poolPriceCache (0 RPC) or fallback to getSlot0 (1 RPC)
    const decimalAdj = token0Info.decimals - token1Info.decimals;
    let tickCurrent: number;
    const cachedPrice = getCachedPrice(tokenId);
    if (cachedPrice !== null) {
      const rawPrice = cachedPrice / Math.pow(10, decimalAdj);
      tickCurrent = Math.round(Math.log(rawPrice) / Math.log(1.0001));
    } else {
      const stateView = new ethers.Contract(STATE_VIEW_V4_ADDRESS, STATE_VIEW_V4_ABI, provider);
      const slot0 = await stateView.getSlot0(poolId);
      tickCurrent = Number(slot0.tick);
    }

    const price = Math.pow(1.0001, tickCurrent) * Math.pow(10, decimalAdj);
    const [amount0, amount1] = this.computeAmountsFromTicks(liquidity, tickCurrent, tickLower, tickUpper);

    let rangeStatus: 'in-range' | 'above-range' | 'below-range';
    if (tickCurrent < tickLower) {
      rangeStatus = 'below-range';
    } else if (tickCurrent >= tickUpper) {
      rangeStatus = 'above-range';
    } else {
      rangeStatus = 'in-range';
    }

    return {
      token0: { ...token0Info, amount: amount0, amountFormatted: Number(ethers.formatUnits(amount0, token0Info.decimals)) },
      token1: { ...token1Info, amount: amount1, amountFormatted: Number(ethers.formatUnits(amount1, token1Info.decimals)) },
      price,
      rangeStatus,
      tickLower,
      tickUpper,
      tickCurrent,
      tokensOwed0,
      tokensOwed1,
      liquidity,
    };
  }

  /**
   * Compute uncollected V4 fees using StateView.
   * Uses getFeeGrowthInside (avoids manual tick math) + getPositionInfo for last-stored baseline.
   * fees = liquidity * (feeGrowthInside - feeGrowthInsideLast) >> 128
   */
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

    // positionId = keccak256(abi.encodePacked(owner, tickLower, tickUpper, salt))
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

    return {
      fees0: (liquidity * delta0) >> 128n,
      fees1: (liquidity * delta1) >> 128n,
    };
  }

  private async getTokenInfo(
    provider: ethers.Provider,
    address: string
  ): Promise<Omit<TokenInfo, 'amount' | 'amountFormatted'>> {
    const addr = address.toLowerCase();
    const cached = this.tokenInfoCache.get(addr);
    if (cached && cached.symbol !== 'UNKNOWN') return cached;

    const token = new ethers.Contract(address, ERC20_ABI, provider);

    // Retry logic for token info (critical for price calc)
    for (let i = 0; i < 3; i++) {
      try {
        const [decimals, symbol] = await Promise.all([
          token.decimals(),
          token.symbol()
        ]);
        const info = { address, symbol: String(symbol), decimals: Number(decimals) };
        this.tokenInfoCache.set(addr, info);
        return info;
      } catch (err) {
        if (i === 2) {
          logger.warn(`Failed to get token info for ${address} after 3 attempts: ${err}`);
          break;
        }
        await new Promise(r => setTimeout(r, 500 * (i + 1)));
      }
    }

    const known = KNOWN_TOKENS[addr];
    if (known) {
      logger.warn(`Using hardcoded token info for ${addr}: ${known.symbol} (${known.decimals} decimals)`);
      this.tokenInfoCache.set(addr, { address, ...known });
      return { address, ...known };
    }

    return { address, symbol: 'UNKNOWN', decimals: 18 };
  }

  private computeAmountsFromTicks(
    liquidity: bigint,
    tickCurrent: number,
    tickLower: number,
    tickUpper: number
  ): [bigint, bigint] {
    const sqrtPriceCurrent = Math.sqrt(Math.pow(1.0001, tickCurrent));
    const sqrtPriceLower = Math.sqrt(Math.pow(1.0001, tickLower));
    const sqrtPriceUpper = Math.sqrt(Math.pow(1.0001, tickUpper));

    const liq = Number(liquidity);
    let amount0 = 0;
    let amount1 = 0;

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

  /** Clears the position data cache for a given tokenId (e.g. after LP is closed). */
  invalidateCache(tokenId: number): void {
    this.positionDataCache.delete(tokenId);
  }

  /** Returns the V4 pool ID (bytes32 hex) cached after the first full refresh, or null. */
  getV4PoolId(tokenId: number): string | null {
    const cached = this.positionDataCache.get(tokenId);
    return (cached?.version === 'v4' && cached.poolId) ? cached.poolId : null;
  }

  async getBlockNumber(): Promise<number> {
    return this.fallback.call(p => p.getBlockNumber());
  }
}

// Multi-chain exports — new parameterized readers accessible from this module
export { EvmClReader } from './readers/evmClReader';
export { EvmV4Reader } from './readers/evmV4Reader';
export { createLPReader } from './lpReaderFactory';
