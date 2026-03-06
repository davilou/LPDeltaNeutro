import { ethers } from 'ethers';
import { config } from '../config';
import { DiscoveredPosition } from '../types';
import { logger } from '../utils/logger';
import { FallbackProvider } from '../utils/fallbackProvider';

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
const FACTORY_V3_ADDRESS = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';

const POSITION_MANAGER_V4_ADDRESS = '0x7c5f5a4bbd8fd63184577525326123b519429bdc';
const STATE_VIEW_V4_ADDRESS = '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71';
// Approximate block at V4 PositionManager deployment on Base (~Jan 22, 2025)
const V4_PM_DEPLOY_BLOCK = 24_000_000;

const POSITION_MANAGER_V3_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
];

const POSITION_MANAGER_V4_ABI = [
  // PositionInfo is encoded as bytes32 to avoid ethers.js v6 signed-uint overflow on high bits
  'function getPoolAndPositionInfo(uint256 tokenId) view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bytes32 info)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)',
];

const STATE_VIEW_V4_ABI = [
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
    const tokenInfoCache = new Map<string, { symbol: string; decimals: number }>();

    // Try V3 first
    try {
      const pos = await this.fallback.call(async (provider) => {
        const pm = new ethers.Contract(POSITION_MANAGER_V3_ADDRESS, POSITION_MANAGER_V3_ABI, provider);
        return pm.positions(tokenId);
      });

      if (BigInt(pos.liquidity) > 0n) {
        const t0Addr = pos.token0.toLowerCase();
        const t1Addr = pos.token1.toLowerCase();
        const fee = Number(pos.fee);

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
        logger.info(`[WalletScanner] lookupByTokenId #${tokenId} (V3): ${t0.symbol}/${t1.symbol} ~$${dp.estimatedUsd.toFixed(2)}`);
        return dp;
      }
    } catch (err) {
      logger.info(`[WalletScanner] V3 lookup failed for #${tokenId}: ${err}. Trying V4...`);
    }

    // Try V4
    return this.lookupV4ByTokenId(tokenId, tokenInfoCache);
  }

  private async lookupV4ByTokenId(
    tokenId: number,
    tokenInfoCache: Map<string, { symbol: string; decimals: number }>
  ): Promise<DiscoveredPosition | null> {
    let poolKey: any;
    let info: string;
    try {
      ({ poolKey, info } = await this.fallback.call(async (provider) => {
        const pm = new ethers.Contract(POSITION_MANAGER_V4_ADDRESS, POSITION_MANAGER_V4_ABI, provider);
        return pm.getPoolAndPositionInfo(tokenId);
      }));
    } catch (err) {
      logger.info(`[WalletScanner] V4 lookup failed for #${tokenId}: ${err}`);
      return null;
    }

    // PositionInfo (bytes32) bit layout:
    // bits 0-7:   flags, bits 8-31: tickLower, bits 32-55: tickUpper, bits 56-255: partial poolId
    const infoBig = BigInt(info);
    const rawTickLower = Number((infoBig >> 8n) & 0xFFFFFFn);
    const tickLower = rawTickLower > 0x7FFFFFn ? rawTickLower - 0x1000000 : rawTickLower;
    const rawTickUpper = Number((infoBig >> 32n) & 0xFFFFFFn);
    const tickUpper = rawTickUpper > 0x7FFFFFn ? rawTickUpper - 0x1000000 : rawTickUpper;

    // Liquidity is not stored in PositionInfo — requires a separate call
    let liquidity: bigint;
    try {
      liquidity = await this.fallback.call(async (p) => {
        const pm = new ethers.Contract(POSITION_MANAGER_V4_ADDRESS, POSITION_MANAGER_V4_ABI, p);
        return BigInt(await pm.getPositionLiquidity(tokenId));
      });
    } catch (err) {
      logger.info(`[WalletScanner] V4 lookup #${tokenId}: getPositionLiquidity failed: ${err}`);
      return null;
    }
    if (liquidity === 0n) {
      logger.info(`[WalletScanner] lookupV4ByTokenId #${tokenId}: liquidity=0`);
      return null;
    }

    const t0Addr = poolKey.currency0.toLowerCase();
    const t1Addr = poolKey.currency1.toLowerCase();
    const fee = Number(poolKey.fee);

    const poolId = ethers.solidityPackedKeccak256(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
    );

    const { t0, t1, tickCurrent } = await this.fallback.call(async (provider) => {
      const [t0Info, t1Info] = await Promise.all([
        this.getTokenInfo(t0Addr, provider, tokenInfoCache),
        this.getTokenInfo(t1Addr, provider, tokenInfoCache),
      ]);
      const stateView = new ethers.Contract(STATE_VIEW_V4_ADDRESS, STATE_VIEW_V4_ABI, provider);
      const slot0 = await stateView.getSlot0(poolId);
      return { t0: t0Info, t1: t1Info, tickCurrent: Number(slot0.tick) };
    });

    const dp = this.buildDiscoveredPosition(
      tokenId, 'v4',
      poolKey.currency0, t0,
      poolKey.currency1, t1,
      fee, tickLower, tickUpper, tickCurrent,
      liquidity, poolId
    );
    logger.info(`[WalletScanner] lookupByTokenId #${tokenId} (V4): ${t0.symbol}/${t1.symbol} ~$${dp.estimatedUsd.toFixed(2)}`);
    return dp;
  }

  async scanWallet(walletAddress: string): Promise<DiscoveredPosition[]> {
    const tokenInfoCache = new Map<string, { symbol: string; decimals: number }>();
    const discovered: DiscoveredPosition[] = [];

    // Scan V3
    const v3Positions = await this.scanV3(walletAddress, tokenInfoCache);
    discovered.push(...v3Positions);

    // Scan V4 (uses its own fallback internally — V4 PM has no ERC721Enumerable)
    try {
      const v4Positions = await this.scanV4(walletAddress, tokenInfoCache);
      discovered.push(...v4Positions);
    } catch (err) {
      logger.warn(`[WalletScanner] V4 scan failed: ${err}`);
    }

    logger.info(`[WalletScanner] Total discovered: ${discovered.length} positions (≥$10)`);
    return discovered;
  }

  private async scanV3(
    walletAddress: string,
    tokenInfoCache: Map<string, { symbol: string; decimals: number }>
  ): Promise<DiscoveredPosition[]> {
    const balance: bigint = await this.fallback.call(async (p) => {
      const pm = new ethers.Contract(POSITION_MANAGER_V3_ADDRESS, POSITION_MANAGER_V3_ABI, p);
      return pm.balanceOf(walletAddress);
    });
    const count = Number(balance);
    if (count === 0) return [];

    logger.info(`[WalletScanner] V3: ${walletAddress} owns ${count} NFTs`);

    // Enumerate tokenIds — each index uses its own fallback.call so transient RPC
    // failures don't silently drop NFTs from the list.
    const tokenIds: bigint[] = [];
    const indices = Array.from({ length: count }, (_, i) => i);
    const indexChunks = chunk(indices, 5);
    for (const batch of indexChunks) {
      const results = await Promise.allSettled(
        batch.map(i =>
          this.fallback.call(async (p) => {
            const pm = new ethers.Contract(POSITION_MANAGER_V3_ADDRESS, POSITION_MANAGER_V3_ABI, p);
            return pm.tokenOfOwnerByIndex(walletAddress, i);
          })
        )
      );
      for (const r of results) {
        if (r.status === 'fulfilled') tokenIds.push(r.value as bigint);
        else logger.warn(`[WalletScanner] tokenOfOwnerByIndex failed (index skipped): ${r.reason}`);
      }
      await new Promise(r => setTimeout(r, 100));
    }

    const discovered: DiscoveredPosition[] = [];
    const idChunks = chunk(tokenIds, 2);
    for (const batch of idChunks) {
      const posResults = await Promise.allSettled(
        batch.map(id =>
          this.fallback.call(async (p) => {
            const pm = new ethers.Contract(POSITION_MANAGER_V3_ADDRESS, POSITION_MANAGER_V3_ABI, p);
            return pm.positions(id);
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

        let t0: { symbol: string; decimals: number };
        let t1: { symbol: string; decimals: number };
        let poolAddr: string;
        let tickCurrent: number;

        try {
          ({ t0, t1, poolAddr, tickCurrent } = await this.fallback.call(async (provider) => {
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
                const [tA, tB] = pos.token0.toLowerCase() < pos.token1.toLowerCase()
                  ? [pos.token0, pos.token1] : [pos.token1, pos.token0];
                const salt = ethers.solidityPackedKeccak256(['address', 'address', 'uint24'], [tA, tB, fee]);
                addr = ethers.getCreate2Address(FACTORY_V3_ADDRESS, salt, V3_POOL_INIT_CODE_HASH);
              } catch { }
            }

            if (addr === ethers.ZeroAddress) {
              throw new Error(`pool not found for ${t0Info.symbol}/${t1Info.symbol} fee=${fee}`);
            }

            const pool = new ethers.Contract(addr, POOL_V3_ABI, provider);
            const slot0 = await pool.slot0();
            return { t0: t0Info, t1: t1Info, poolAddr: addr, tickCurrent: Number(slot0.tick) };
          }));
        } catch (err) {
          logger.info(`[WalletScanner] NFT #${tokenId}: skipped (pool/slot0 failed: ${err})`);
          continue;
        }

        const dp = this.buildDiscoveredPosition(
          tokenId, 'v3',
          pos.token0, t0,
          pos.token1, t1,
          fee,
          Number(pos.tickLower), Number(pos.tickUpper), tickCurrent,
          BigInt(pos.liquidity), poolAddr
        );

        // estimatedUsd=0 means non-stable pair (USD unknown) → include always
        if (dp.estimatedUsd >= 10 || dp.estimatedUsd === 0) {
          logger.info(`[WalletScanner] NFT #${tokenId}: found (${t0.symbol}/${t1.symbol} ~$${dp.estimatedUsd > 0 ? dp.estimatedUsd.toFixed(2) : '?'})`);
          discovered.push(dp);
        } else {
          logger.info(`[WalletScanner] NFT #${tokenId}: skipped (estimatedUsd=$${dp.estimatedUsd.toFixed(2)} < $10, ${t0.symbol}/${t1.symbol})`);
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return discovered;
  }

  // V4 PositionManager does not implement ERC721Enumerable — enumerate via Transfer events.
  private async scanV4(
    walletAddress: string,
    tokenInfoCache: Map<string, { symbol: string; decimals: number }>
  ): Promise<DiscoveredPosition[]> {
    const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
    const walletTopic = ethers.zeroPadValue(walletAddress, 32);

    // Fetch ERC721 Transfer logs to/from this wallet since V4 PM deployment
    const [inLogs, outLogs] = await this.fallback.call(async (provider) => {
      return Promise.all([
        provider.getLogs({
          address: POSITION_MANAGER_V4_ADDRESS,
          topics: [TRANSFER_TOPIC, null, walletTopic],
          fromBlock: V4_PM_DEPLOY_BLOCK,
          toBlock: 'latest',
        }),
        provider.getLogs({
          address: POSITION_MANAGER_V4_ADDRESS,
          topics: [TRANSFER_TOPIC, walletTopic, null],
          fromBlock: V4_PM_DEPLOY_BLOCK,
          toBlock: 'latest',
        }),
      ]);
    });

    // Compute current holdings: received tokenIds minus sent tokenIds
    const received = new Set(inLogs.map(l => l.topics[3]));
    const sent = new Set(outLogs.map(l => l.topics[3]));
    const currentTokenIds = [...received]
      .filter(id => !sent.has(id))
      .map(hex => BigInt(hex));

    if (currentTokenIds.length === 0) return [];
    logger.info(`[WalletScanner] V4: ${walletAddress} has ${currentTokenIds.length} current V4 NFTs`);

    const discovered: DiscoveredPosition[] = [];
    const idChunks = chunk(currentTokenIds, 2);
    for (const batch of idChunks) {
      const infoResults = await Promise.allSettled(
        batch.map(id =>
          this.fallback.call(async (p) => {
            const pm = new ethers.Contract(POSITION_MANAGER_V4_ADDRESS, POSITION_MANAGER_V4_ABI, p);
            return pm.getPoolAndPositionInfo(id);
          })
        )
      );

      for (let i = 0; i < batch.length; i++) {
        const tokenId = Number(batch[i]);
        const r = infoResults[i];
        if (r.status === 'rejected') {
          logger.warn(`[WalletScanner] V4 NFT #${tokenId}: getPoolAndPositionInfo failed: ${r.reason}`);
          continue;
        }
        const { poolKey, info } = r.value;

        // PositionInfo (bytes32) bit layout:
        // bits 0-7:   flags (bit 0 = hasSubscriber)
        // bits 8-31:  tickLower (int24)
        // bits 32-55: tickUpper (int24)
        // bits 56-255: partial poolId (bytes25)
        const infoBig = BigInt(info as string);
        const rawTickLower = Number((infoBig >> 8n) & 0xFFFFFFn);
        const tickLower = rawTickLower > 0x7FFFFFn ? rawTickLower - 0x1000000 : rawTickLower;
        const rawTickUpper = Number((infoBig >> 32n) & 0xFFFFFFn);
        const tickUpper = rawTickUpper > 0x7FFFFFn ? rawTickUpper - 0x1000000 : rawTickUpper;

        // Liquidity is not stored in PositionInfo — requires a separate call
        let liquidity: bigint;
        try {
          liquidity = await this.fallback.call(async (p) => {
            const pm = new ethers.Contract(POSITION_MANAGER_V4_ADDRESS, POSITION_MANAGER_V4_ABI, p);
            return BigInt(await pm.getPositionLiquidity(tokenId));
          });
        } catch (err) {
          logger.warn(`[WalletScanner] V4 NFT #${tokenId}: getPositionLiquidity failed: ${err}`);
          continue;
        }
        if (liquidity === 0n) continue;

        const t0Addr = poolKey.currency0.toLowerCase();
        const t1Addr = poolKey.currency1.toLowerCase();
        const fee = Number(poolKey.fee);

        // PoolId = keccak256(abi.encode(PoolKey)) — abi.encode pads each field to 32 bytes
        const poolId = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ['address', 'address', 'uint24', 'int24', 'address'],
            [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
          )
        );

        let t0: { symbol: string; decimals: number };
        let t1: { symbol: string; decimals: number };
        let tickCurrent: number;
        try {
          ({ t0, t1, tickCurrent } = await this.fallback.call(async (provider) => {
            const [t0Info, t1Info] = await Promise.all([
              this.getTokenInfo(t0Addr, provider, tokenInfoCache),
              this.getTokenInfo(t1Addr, provider, tokenInfoCache),
            ]);
            const stateView = new ethers.Contract(STATE_VIEW_V4_ADDRESS, STATE_VIEW_V4_ABI, provider);
            const slot0 = await stateView.getSlot0(poolId);
            return { t0: t0Info, t1: t1Info, tickCurrent: Number(slot0.tick) };
          }));
        } catch (err) {
          logger.warn(`[WalletScanner] V4 NFT #${tokenId}: slot0/token info failed: ${err}`);
          continue;
        }

        const dp = this.buildDiscoveredPosition(
          tokenId, 'v4',
          poolKey.currency0, t0,
          poolKey.currency1, t1,
          fee, tickLower, tickUpper, tickCurrent,
          liquidity, poolId
        );

        if (dp.estimatedUsd >= 10 || dp.estimatedUsd === 0) {
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
      const known = KNOWN_TOKENS[address.toLowerCase()];
      if (known) return known;
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
    const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'USDbC', 'DAI', 'USDS', 'crvUSD']);
    // USD estimate: only accurate when one side is a stablecoin.
    // For non-stable pairs (e.g. VIRTUAL/SDC), the formula gives value in token1 units — not USD.
    // We mark those as estimatedUsd=0 so they always pass the filter and appear in the scanner.
    const t0Stable = STABLE_SYMBOLS.has(t0.symbol);
    const t1Stable = STABLE_SYMBOLS.has(t1.symbol);
    const estimatedUsd = t0Stable
      ? t0Amount + t1Amount * (1 / price)
      : t1Stable
        ? t0Amount * price + t1Amount
        : 0; // non-stable pair: USD unknown, show regardless

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

// Multi-chain exports
export { EvmScanner } from './scanners/evmScanner';
export { createWalletScanner } from './walletScannerFactory';
