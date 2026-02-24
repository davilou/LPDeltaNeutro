import { ethers } from 'ethers';
import { config } from '../config';
import { LPPosition, TokenInfo } from '../types';
import { logger } from '../utils/logger';
import { FallbackProvider } from '../utils/fallbackProvider';

const Q128 = 1n << 128n;

const POSITION_MANAGER_V3_ABI = [
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) returns (uint256 amount0, uint256 amount1)',
];

const POSITION_MANAGER_V4_ABI = [
  'function getPoolAndPositionInfo(uint256 tokenId) view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
  'function collect(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) returns (uint256 amount0, uint256 amount1)',
];

const POOL_MANAGER_V4_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
];

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const POOL_V3_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

const POSITION_MANAGER_V3_ADDRESS = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const POOL_MANAGER_V4_ADDRESS = '0x4985E28f84D982f4d9822008214d5d122391ce24';

export class UniswapReader {
  private fallback: FallbackProvider;

  constructor() {
    this.fallback = new FallbackProvider(config.httpRpcUrls);
  }

  async readPosition(tokenId: number, poolAddress: string, version: 'v3' | 'v4' = 'v3'): Promise<LPPosition> {
    return this.fallback.call(async (provider) => {
      logger.info(`Reading position NFT #${tokenId} (${version})`);

      if (version === 'v4') {
        return this.readV4Position(tokenId, provider);
      } else {
        return this.readV3Position(tokenId, poolAddress, provider);
      }
    });
  }

  private async readV4Position(tokenId: number, provider: ethers.Provider): Promise<LPPosition> {
    const pm = new ethers.Contract(config.positionManagerV4Address || '0x7c5f5a4bbd8fd63184577525326123b519429bdc', POSITION_MANAGER_V4_ABI, provider);
    const { poolKey, info } = await pm.getPoolAndPositionInfo(tokenId);

    const liquidity = info & ((1n << 128n) - 1n);
    const rawTickLower = Number((info >> 128n) & 0xFFFFFFn);
    const tickLower = rawTickLower > 0x7FFFFFn ? rawTickLower - 0x1000000 : rawTickLower;
    const rawTickUpper = Number((info >> 152n) & 0xFFFFFFn);
    const tickUpper = rawTickUpper > 0x7FFFFFn ? rawTickUpper - 0x1000000 : rawTickUpper;

    const [token0Info, token1Info] = await Promise.all([
      this.getTokenInfo(provider, poolKey.currency0),
      this.getTokenInfo(provider, poolKey.currency1),
    ]);

    const poolId = ethers.solidityPackedKeccak256(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
    );

    const poolManager = new ethers.Contract(POOL_MANAGER_V4_ADDRESS, POOL_MANAGER_V4_ABI, provider);
    const slot0 = await poolManager.getSlot0(poolId);
    const tickCurrent = Number(slot0.tick);

    const [amount0, amount1] = this.computeAmountsFromTicks(liquidity, tickCurrent, tickLower, tickUpper);

    const decimalAdj = token0Info.decimals - token1Info.decimals;
    const price = Math.pow(1.0001, tickCurrent) * Math.pow(10, decimalAdj);

    let rangeStatus: 'in-range' | 'above-range' | 'below-range';
    if (tickCurrent < tickLower) {
      rangeStatus = 'below-range';
    } else if (tickCurrent >= tickUpper) {
      rangeStatus = 'above-range';
    } else {
      rangeStatus = 'in-range';
    }

    let tokensOwed0 = 0;
    let tokensOwed1 = 0;
    try {
      const MAX_UINT128 = (1n << 128n) - 1n;
      const res = await pm.collect.staticCall(
        tokenId,
        ethers.ZeroAddress,
        MAX_UINT128,
        MAX_UINT128
      );
      tokensOwed0 = Number(ethers.formatUnits(res.amount0, token0Info.decimals));
      tokensOwed1 = Number(ethers.formatUnits(res.amount1, token1Info.decimals));
    } catch { }

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
    };
  }

  private async readV3Position(tokenId: number, poolAddress: string, provider: ethers.Provider): Promise<LPPosition> {
    const pm = new ethers.Contract(POSITION_MANAGER_V3_ADDRESS, POSITION_MANAGER_V3_ABI, provider);
    const poolContract = new ethers.Contract(poolAddress, POOL_V3_ABI, provider);

    const [pos, slot0] = await Promise.all([
      pm.positions(tokenId),
      poolContract.slot0()
    ]);

    const tickLower = Number(pos.tickLower);
    const tickUpper = Number(pos.tickUpper);
    const liquidity = BigInt(pos.liquidity);
    const tickCurrent = Number(slot0.tick);

    const [token0Info, token1Info] = await Promise.all([
      this.getTokenInfo(provider, pos.token0),
      this.getTokenInfo(provider, pos.token1),
    ]);

    let [amount0, amount1] = this.computeAmountsFromTicks(liquidity, tickCurrent, tickLower, tickUpper);

    if (liquidity > 0n) {
      try {
        const result = await pm.decreaseLiquidity.staticCall({
          tokenId: tokenId,
          liquidity: liquidity,
          amount0Min: 0,
          amount1Min: 0,
          deadline: Math.floor(Date.now() / 1000) + 600,
        });
        amount0 = result.amount0;
        amount1 = result.amount1;
      } catch { }
    }

    const decimalAdj = token0Info.decimals - token1Info.decimals;
    const price = Math.pow(1.0001, tickCurrent) * Math.pow(10, decimalAdj);

    let rangeStatus: 'in-range' | 'above-range' | 'below-range';
    if (tickCurrent < tickLower) {
      rangeStatus = 'below-range';
    } else if (tickCurrent >= tickUpper) {
      rangeStatus = 'above-range';
    } else {
      rangeStatus = 'in-range';
    }

    let tokensOwed0 = 0;
    let tokensOwed1 = 0;
    try {
      const MAX_UINT128 = (1n << 128n) - 1n;
      const res = await pm.collect.staticCall({
        tokenId,
        recipient: ethers.ZeroAddress,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128
      });
      tokensOwed0 = Number(ethers.formatUnits(res.amount0, token0Info.decimals));
      tokensOwed1 = Number(ethers.formatUnits(res.amount1, token1Info.decimals));
    } catch {
      tokensOwed0 = Number(ethers.formatUnits(pos.tokensOwed0, token0Info.decimals));
      tokensOwed1 = Number(ethers.formatUnits(pos.tokensOwed1, token1Info.decimals));
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
    };
  }

  private tokenInfoCache: Map<string, Omit<TokenInfo, 'amount' | 'amountFormatted'>> = new Map();

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
  async getBlockNumber(): Promise<number> {
    return this.fallback.call(p => p.getBlockNumber());
  }
}
