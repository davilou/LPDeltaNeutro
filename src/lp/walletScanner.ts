import { ethers } from 'ethers';
import { config } from '../config';
import { DiscoveredPosition } from '../types';
import { logger } from '../utils/logger';
import { FallbackProvider } from '../utils/fallbackProvider';

const POSITION_MANAGER_V3_ADDRESS = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const FACTORY_V3_ADDRESS = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';

const POSITION_MANAGER_V4_ADDRESS = '0x7c5f5a4bbd8fd63184577525326123b519429bdc';
const POOL_MANAGER_V4_ADDRESS = '0x4985E28f84D982f4d9822008214d5d122391ce24';

const POSITION_MANAGER_V3_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
];

const POSITION_MANAGER_V4_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
];

const POOL_MANAGER_V4_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
];

const FACTORY_V3_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
];

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const POOL_V3_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

// Helper to split array into chunks
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export class WalletScanner {
  private fallback: FallbackProvider;

  constructor() {
    this.fallback = new FallbackProvider(config.httpRpcUrls);
  }

  async scanWallet(walletAddress: string): Promise<DiscoveredPosition[]> {
    return this.fallback.call(async (provider) => {
      const discovered: DiscoveredPosition[] = [];
      const tokenInfoCache = new Map<string, { symbol: string; decimals: number }>();

      // Scan V3
      const v3Positions = await this.scanV3(walletAddress, provider, tokenInfoCache);
      discovered.push(...v3Positions);

      // Scan V4
      try {
        const v4Positions = await this.scanV4(walletAddress, provider, tokenInfoCache);
        discovered.push(...v4Positions);
      } catch (err) {
        logger.warn(`[WalletScanner] V4 scan failed: ${err}`);
      }

      logger.info(`[WalletScanner] Total discovered: ${discovered.length} positions (≥$10)`);
      return discovered;
    });
  }

  private async scanV3(
    walletAddress: string,
    provider: ethers.Provider,
    tokenInfoCache: Map<string, { symbol: string; decimals: number }>
  ): Promise<DiscoveredPosition[]> {
    const pm = new ethers.Contract(POSITION_MANAGER_V3_ADDRESS, POSITION_MANAGER_V3_ABI, provider);
    const factory = new ethers.Contract(FACTORY_V3_ADDRESS, FACTORY_V3_ABI, provider);

    const balance: bigint = await pm.balanceOf(walletAddress);
    const count = Number(balance);
    if (count === 0) return [];

    logger.info(`[WalletScanner] V3: ${walletAddress} owns ${count} NFTs`);

    const tokenIds: bigint[] = [];
    // Process token index fetch in smaller chunks to avoid RPC batch/concurrency limits
    const indices = Array.from({ length: count }, (_, i) => i);
    const indexChunks = chunk(indices, 5); // Reduced from 10 to 5
    for (const batch of indexChunks) {
      const ids = await Promise.all(batch.map(i => pm.tokenOfOwnerByIndex(walletAddress, i)));
      tokenIds.push(...ids);
      // Small delay to prevent hitting rate limits
      await new Promise(r => setTimeout(r, 100));
    }

    const discovered: DiscoveredPosition[] = [];
    // Process position details in very small chunks
    const idChunks = chunk(tokenIds, 2); // Reduced from 5 to 2
    for (const batch of idChunks) {
      const posResults = await Promise.all(batch.map(id => pm.positions(id)));

      for (let i = 0; i < batch.length; i++) {
        const tokenId = Number(batch[i]);
        const pos = posResults[i];
        if (BigInt(pos.liquidity) === 0n) continue;

        const t0Addr = pos.token0.toLowerCase();
        const t1Addr = pos.token1.toLowerCase();
        const fee = Number(pos.fee);

        const t0 = await this.getTokenInfo(t0Addr, provider, tokenInfoCache);
        const t1 = await this.getTokenInfo(t1Addr, provider, tokenInfoCache);

        let poolAddr = ethers.ZeroAddress;
        try {
          poolAddr = await factory.getPool(pos.token0, pos.token1, pos.fee);
        } catch { }

        if (poolAddr === ethers.ZeroAddress) continue;

        let tickCurrent = 0;
        try {
          const pool = new ethers.Contract(poolAddr, POOL_V3_ABI, provider);
          const slot0 = await pool.slot0();
          tickCurrent = Number(slot0.tick);
        } catch {
          continue;
        }

        const liquidity = BigInt(pos.liquidity);
        const tickLower = Number(pos.tickLower);
        const tickUpper = Number(pos.tickUpper);

        const dp = this.buildDiscoveredPosition(
          tokenId,
          'v3',
          pos.token0,
          t0,
          pos.token1,
          t1,
          fee,
          tickLower,
          tickUpper,
          tickCurrent,
          liquidity,
          poolAddr
        );

        if (dp.estimatedUsd >= 10) {
          discovered.push(dp);
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return discovered;
  }

  private async scanV4(
    walletAddress: string,
    provider: ethers.Provider,
    tokenInfoCache: Map<string, { symbol: string; decimals: number }>
  ): Promise<DiscoveredPosition[]> {
    const pm = new ethers.Contract(POSITION_MANAGER_V4_ADDRESS, POSITION_MANAGER_V4_ABI, provider);
    const balance: bigint = await pm.balanceOf(walletAddress);
    const count = Number(balance);
    if (count === 0) return [];

    logger.info(`[WalletScanner] V4: ${walletAddress} owns ${count} NFTs`);

    const tokenIds: bigint[] = [];
    const indices = Array.from({ length: count }, (_, i) => i);
    const indexChunks = chunk(indices, 5); // Reduced from 10
    for (const batch of indexChunks) {
      const ids = await Promise.all(batch.map(i => pm.tokenOfOwnerByIndex(walletAddress, i)));
      tokenIds.push(...ids);
      await new Promise(r => setTimeout(r, 100));
    }

    const discovered: DiscoveredPosition[] = [];
    const idChunks = chunk(tokenIds, 2); // Reduced from 5
    for (const batch of idChunks) {
      const infoResults = await Promise.all(batch.map(id => pm.getPoolAndPositionInfo(id)));

      for (let i = 0; i < batch.length; i++) {
        const tokenId = Number(batch[i]);
        const { poolKey, info } = infoResults[i];

        const liquidity = info & ((1n << 128n) - 1n);
        if (liquidity === 0n) continue;

        const rawTickLower = Number((info >> 128n) & 0xFFFFFFn);
        const tickLower = rawTickLower > 0x7FFFFFn ? rawTickLower - 0x1000000 : rawTickLower;

        const rawTickUpper = Number((info >> 152n) & 0xFFFFFFn);
        const tickUpper = rawTickUpper > 0x7FFFFFn ? rawTickUpper - 0x1000000 : rawTickUpper;

        const t0Addr = poolKey.currency0.toLowerCase();
        const t1Addr = poolKey.currency1.toLowerCase();
        const fee = Number(poolKey.fee);

        const t0 = await this.getTokenInfo(t0Addr, provider, tokenInfoCache);
        const t1 = await this.getTokenInfo(t1Addr, provider, tokenInfoCache);

        const poolId = ethers.solidityPackedKeccak256(
          ['address', 'address', 'uint24', 'int24', 'address'],
          [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
        );

        let tickCurrent = 0;
        try {
          const poolManager = new ethers.Contract(POOL_MANAGER_V4_ADDRESS, POOL_MANAGER_V4_ABI, provider);
          const slot0 = await poolManager.getSlot0(poolId);
          tickCurrent = Number(slot0.tick);
        } catch (err) {
          logger.warn(`[WalletScanner] V4 slot0 failed for poolId ${poolId}: ${err}`);
          continue;
        }

        const dp = this.buildDiscoveredPosition(
          tokenId,
          'v4',
          poolKey.currency0,
          t0,
          poolKey.currency1,
          t1,
          fee,
          tickLower,
          tickUpper,
          tickCurrent,
          liquidity,
          POOL_MANAGER_V4_ADDRESS
        );

        if (dp.estimatedUsd >= 10) {
          discovered.push(dp);
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return discovered;
  }

  private async getTokenInfo(
    address: string,
    provider: ethers.Provider,
    cache: Map<string, { symbol: string; decimals: number }>
  ): Promise<{ symbol: string; decimals: number }> {
    const cached = cache.get(address.toLowerCase());
    if (cached) return cached;

    try {
      const erc20 = new ethers.Contract(address, ERC20_ABI, provider);
      const [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
      const info = { symbol: String(symbol), decimals: Number(decimals) };
      cache.set(address.toLowerCase(), info);
      return info;
    } catch {
      return { symbol: 'UNKNOWN', decimals: 18 };
    }
  }

  private buildDiscoveredPosition(
    tokenId: number,
    version: 'v3' | 'v4',
    t0Addr: string,
    t0: { symbol: string; decimals: number },
    t1Addr: string,
    t1: { symbol: string; decimals: number },
    fee: number,
    tickLower: number,
    tickUpper: number,
    tickCurrent: number,
    liquidity: bigint,
    poolAddress: string
  ): DiscoveredPosition {
    const [amount0, amount1] = this.computeAmountsFromTicks(
      liquidity,
      tickCurrent,
      tickLower,
      tickUpper
    );
    const t0Amount = Number(ethers.formatUnits(amount0, t0.decimals));
    const t1Amount = Number(ethers.formatUnits(amount1, t1.decimals));

    const decimalAdj = t0.decimals - t1.decimals;
    const price = Math.pow(1.0001, tickCurrent) * Math.pow(10, decimalAdj);
    const estimatedUsd = t0Amount * price + t1Amount;

    let rangeStatus: 'in-range' | 'above-range' | 'below-range';
    if (tickCurrent < tickLower) {
      rangeStatus = 'below-range';
    } else if (tickCurrent >= tickUpper) {
      rangeStatus = 'above-range';
    } else {
      rangeStatus = 'in-range';
    }

    return {
      tokenId,
      protocolVersion: version,
      token0Address: t0Addr,
      token0Symbol: t0.symbol,
      token0Decimals: t0.decimals,
      token1Address: t1Addr,
      token1Symbol: t1.symbol,
      token1Decimals: t1.decimals,
      fee,
      tickLower,
      tickUpper,
      tickCurrent,
      liquidity: liquidity.toString(),
      poolAddress,
      rangeStatus,
      token0AmountFormatted: t0Amount,
      token1AmountFormatted: t1Amount,
      price,
      estimatedUsd,
    };
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
}
