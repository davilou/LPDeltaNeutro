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

  async lookupByTokenId(tokenId: number): Promise<DiscoveredPosition | null> {
    // Each RPC call that can fail transiently must propagate out of fallback.call
    // so the FallbackProvider can rotate to the next RPC and retry.
    // Only swallow errors that are deterministic (e.g. factory returning ZeroAddress).

    const tokenInfoCache = new Map<string, { symbol: string; decimals: number }>();

    // positions() — let transient errors propagate for FallbackProvider retry
    const pos = await this.fallback.call(async (provider) => {
      const pm = new ethers.Contract(POSITION_MANAGER_V3_ADDRESS, POSITION_MANAGER_V3_ABI, provider);
      return pm.positions(tokenId);
    });

    if (BigInt(pos.liquidity) === 0n) {
      logger.info(`[WalletScanner] lookupByTokenId #${tokenId}: liquidity=0`);
      return null;
    }

    const t0Addr = pos.token0.toLowerCase();
    const t1Addr = pos.token1.toLowerCase();
    const fee = Number(pos.fee);

    // Token info + pool address + slot0 — all through fallback for retry
    const { t0, t1, poolAddr, tickCurrent } = await this.fallback.call(async (provider) => {
      const factory = new ethers.Contract(FACTORY_V3_ADDRESS, FACTORY_V3_ABI, provider);

      const [t0Info, t1Info] = await Promise.all([
        this.getTokenInfo(t0Addr, provider, tokenInfoCache),
        this.getTokenInfo(t1Addr, provider, tokenInfoCache),
      ]);

      let addr = ethers.ZeroAddress;
      let factoryFailed = false;
      try {
        addr = await factory.getPool(pos.token0, pos.token1, pos.fee);
      } catch {
        factoryFailed = true;
      }

      if (factoryFailed) {
        try {
          const V3_POOL_INIT_CODE_HASH = '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54';
          const [tA, tB] = t0Addr < t1Addr ? [pos.token0, pos.token1] : [pos.token1, pos.token0];
          const salt = ethers.solidityPackedKeccak256(['address', 'address', 'uint24'], [tA, tB, fee]);
          addr = ethers.getCreate2Address(FACTORY_V3_ADDRESS, salt, V3_POOL_INIT_CODE_HASH);
        } catch { }
      }

      if (addr === ethers.ZeroAddress) {
        throw new Error(`pool not found for ${t0Info.symbol}/${t1Info.symbol} fee=${fee}`);
      }

      // slot0 — let it propagate for FallbackProvider retry
      const pool = new ethers.Contract(addr, POOL_V3_ABI, provider);
      const slot0 = await pool.slot0();

      return { t0: t0Info, t1: t1Info, poolAddr: addr, tickCurrent: Number(slot0.tick) };
    });

    const dp = this.buildDiscoveredPosition(
      tokenId, 'v3',
      pos.token0, t0,
      pos.token1, t1,
      fee,
      Number(pos.tickLower), Number(pos.tickUpper), tickCurrent,
      BigInt(pos.liquidity), poolAddr
    );

    logger.info(`[WalletScanner] lookupByTokenId #${tokenId}: found ${t0.symbol}/${t1.symbol} ~$${dp.estimatedUsd.toFixed(2)}`);
    return dp;
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
    // Process token index fetch in smaller chunks to avoid RPC batch/concurrency limits.
    // Some indices may revert if NFTs are staked in external gauges — skip them individually.
    const indices = Array.from({ length: count }, (_, i) => i);
    const indexChunks = chunk(indices, 5);
    for (const batch of indexChunks) {
      const results = await Promise.allSettled(batch.map(i => pm.tokenOfOwnerByIndex(walletAddress, i)));
      for (const r of results) {
        if (r.status === 'fulfilled') tokenIds.push(r.value as bigint);
      }
      await new Promise(r => setTimeout(r, 100));
    }

    const discovered: DiscoveredPosition[] = [];
    // Process position details one at a time — each through its own fallback.call so
    // the FallbackProvider can rotate RPCs on transient CALL_EXCEPTION (data=null) errors.
    // Promise.allSettled inside a single provider would swallow errors before rotation.
    const idChunks = chunk(tokenIds, 2);
    for (const batch of idChunks) {
      const posResults = await Promise.allSettled(
        batch.map(id =>
          this.fallback.call(async (p) => {
            const pmFresh = new ethers.Contract(POSITION_MANAGER_V3_ADDRESS, POSITION_MANAGER_V3_ABI, p);
            return pmFresh.positions(id);
          })
        )
      );

      for (let i = 0; i < batch.length; i++) {
        const tokenId = Number(batch[i]);
        const r = posResults[i];
        if (r.status === 'rejected') {
          logger.warn(`[WalletScanner] NFT #${tokenId}: skipped (positions() call failed: ${r.reason})`);
          continue;
        }
        const pos = r.value;
        if (BigInt(pos.liquidity) === 0n) {
          logger.info(`[WalletScanner] NFT #${tokenId}: skipped (liquidity=0)`);
          continue;
        }

        const t0Addr = pos.token0.toLowerCase();
        const t1Addr = pos.token1.toLowerCase();
        const fee = Number(pos.fee);

        const t0 = await this.getTokenInfo(t0Addr, provider, tokenInfoCache);
        const t1 = await this.getTokenInfo(t1Addr, provider, tokenInfoCache);

        let poolAddr = ethers.ZeroAddress;
        let factoryCallFailed = false;
        try {
          poolAddr = await factory.getPool(pos.token0, pos.token1, pos.fee);
        } catch (err) {
          factoryCallFailed = true;
          logger.warn(`[WalletScanner] NFT #${tokenId}: factory.getPool() failed (${err}), falling back to CREATE2`);
        }

        // Fallback: compute pool address via CREATE2 when factory call fails due to RPC error.
        // Only used for transient failures — if factory returns ZeroAddress, the pool genuinely doesn't exist there.
        // This is purely a local computation and does not require any RPC call.
        if (factoryCallFailed) {
          try {
            const V3_POOL_INIT_CODE_HASH = '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54';
            const [tA, tB] = pos.token0.toLowerCase() < pos.token1.toLowerCase()
              ? [pos.token0, pos.token1] : [pos.token1, pos.token0];
            const salt = ethers.solidityPackedKeccak256(['address', 'address', 'uint24'], [tA, tB, fee]);
            poolAddr = ethers.getCreate2Address(FACTORY_V3_ADDRESS, salt, V3_POOL_INIT_CODE_HASH);
          } catch (err) {
            logger.warn(`[WalletScanner] NFT #${tokenId}: CREATE2 fallback failed (${err})`);
          }
        }

        if (poolAddr === ethers.ZeroAddress) {
          logger.info(`[WalletScanner] NFT #${tokenId}: skipped (pool not found for ${t0.symbol}/${t1.symbol} fee=${fee})`);
          continue;
        }

        let tickCurrent = 0;
        try {
          const pool = new ethers.Contract(poolAddr, POOL_V3_ABI, provider);
          const slot0 = await pool.slot0();
          tickCurrent = Number(slot0.tick);
        } catch (err) {
          logger.info(`[WalletScanner] NFT #${tokenId}: skipped (slot0 failed for pool ${poolAddr}: ${err})`);
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
        } else {
          logger.info(`[WalletScanner] NFT #${tokenId}: skipped (estimatedUsd=$${dp.estimatedUsd.toFixed(2)} < $10, ${t0.symbol}/${t1.symbol})`);
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
    const indexChunks = chunk(indices, 5);
    for (const batch of indexChunks) {
      const results = await Promise.allSettled(batch.map(i => pm.tokenOfOwnerByIndex(walletAddress, i)));
      for (const r of results) {
        if (r.status === 'fulfilled') tokenIds.push(r.value as bigint);
      }
      await new Promise(r => setTimeout(r, 100));
    }

    const discovered: DiscoveredPosition[] = [];
    const idChunks = chunk(tokenIds, 2);
    for (const batch of idChunks) {
      const infoResults = await Promise.allSettled(
        batch.map(id =>
          this.fallback.call(async (p) => {
            const pmFresh = new ethers.Contract(POSITION_MANAGER_V4_ADDRESS, POSITION_MANAGER_V4_ABI, p);
            return pmFresh.getPoolAndPositionInfo(id);
          })
        )
      );

      for (let i = 0; i < batch.length; i++) {
        const tokenId = Number(batch[i]);
        const r = infoResults[i];
        if (r.status === 'rejected') continue;
        const { poolKey, info } = r.value;

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
