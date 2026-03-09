import { ethers } from 'ethers';
import { DiscoveredPosition } from '../../types';
import { logger } from '../../utils/logger';
import { ChainId, DexId, IWalletScanner, PositionId } from '../types';
import { getChainDexAddresses, ChainDexAddresses } from '../chainRegistry';
import { getLpProvider } from '../chainProviders';
import { getTokenCache, KNOWN_TOKENS_BY_CHAIN, seedTokenCache, TokenMeta } from '../tokenCache';
import { NonRetryableError } from '../../utils/fallbackProvider';
import { multicall3, buildCall3, decodeCall3Result } from '../../utils/multicall';

const POSITION_MANAGER_V3_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function factory() view returns (address)',
];

const FACTORY_V3_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
];

const POOL_V3_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'USDbC', 'DAI', 'USDS', 'crvUSD', 'BUSD']);

const MIN_POSITION_USD = 10;

export class EvmScanner implements IWalletScanner {
  private readonly chain: ChainId;
  private readonly dex: DexId;
  /** Cache: positionManager address → factory address resolved via pm.factory() */
  private readonly _pmFactoryCache = new Map<string, string>();

  constructor(chain: ChainId, dex: DexId) {
    this.chain = chain;
    this.dex = dex;
    const known = KNOWN_TOKENS_BY_CHAIN[chain];
    if (known) seedTokenCache(chain, known);
  }

  async scanWallet(walletAddress: string): Promise<DiscoveredPosition[]> {
    return this.scanV3(walletAddress);
  }

  async lookupById(id: PositionId): Promise<DiscoveredPosition | null> {
    return this.lookupByTokenId(Number(id));
  }

  private async lookupByTokenId(tokenId: number): Promise<DiscoveredPosition | null> {
    const addresses = getChainDexAddresses(this.chain, this.dex);
    if (!addresses.positionManagerV3) return null;

    try {
      const pos = await getLpProvider(this.chain).call(async (provider) => {
        const pm = new ethers.Contract(addresses.positionManagerV3!, POSITION_MANAGER_V3_ABI, provider);
        return pm.positions(tokenId);
      });

      if (BigInt(pos.liquidity) === 0n) return null;

      const t0Addr = pos.token0.toLowerCase();
      const t1Addr = pos.token1.toLowerCase();
      const fee = Number(pos.fee);

      const { t0, t1, poolAddr, tickCurrent } = await getLpProvider(this.chain).call(async (provider) => {
        const [t0Info, t1Info] = await Promise.all([
          this.getTokenInfo(provider, t0Addr),
          this.getTokenInfo(provider, t1Addr),
        ]);
        const resolvedAddr = await this.resolvePoolAddress(provider, addresses, pos.token0, pos.token1, fee);
        const pool = new ethers.Contract(resolvedAddr, POOL_V3_ABI, provider);
        const slot0 = await pool.slot0();
        return { t0: t0Info, t1: t1Info, poolAddr: resolvedAddr, tickCurrent: Number(slot0.tick) };
      });

      const dp = this.buildDiscoveredPosition(
        tokenId, pos.token0, t0, pos.token1, t1, fee,
        Number(pos.tickLower), Number(pos.tickUpper), tickCurrent,
        BigInt(pos.liquidity), poolAddr,
      );
      logger.info(`[EvmScanner][${this.chain}:${this.dex}] lookupById #${tokenId}: ${t0.symbol}/${t1.symbol} ~$${dp.estimatedUsd.toFixed(2)}`);
      return dp;
    } catch (err) {
      logger.info(`[EvmScanner][${this.chain}:${this.dex}] lookupById #${tokenId} failed: ${err}`);
      return null;
    }
  }

  private async scanV3(walletAddress: string): Promise<DiscoveredPosition[]> {
    const addresses = getChainDexAddresses(this.chain, this.dex);
    if (!addresses.positionManagerV3) return [];
    const fallback = getLpProvider(this.chain);

    // Round 1: balanceOf — 1 RPC call
    const balance: bigint = await fallback.call(async (p) => {
      const pm = new ethers.Contract(addresses.positionManagerV3!, POSITION_MANAGER_V3_ABI, p);
      return pm.balanceOf(walletAddress);
    });
    const count = Number(balance);
    if (count === 0) return [];

    logger.info(`[EvmScanner][${this.chain}:${this.dex}] ${walletAddress} owns ${count} NFTs`);

    // Round 2: tokenOfOwnerByIndex[0..n-1] — 1 multicall
    const tokenIds: bigint[] = await fallback.call(async (p) => {
      const pm = new ethers.Contract(addresses.positionManagerV3!, POSITION_MANAGER_V3_ABI, p);
      const calls = Array.from({ length: count }, (_, i) =>
        buildCall3(pm, 'tokenOfOwnerByIndex', [walletAddress, i]),
      );
      const results = await multicall3(p, calls);
      return results
        .map(r => decodeCall3Result<bigint>(pm, 'tokenOfOwnerByIndex', r))
        .filter((v): v is bigint => v !== null);
    });

    // Round 3: positions(tokenId) for all tokenIds — 1 multicall
    interface PosData {
      tokenId: bigint;
      token0: string;
      token1: string;
      fee: number;
      tickLower: number;
      tickUpper: number;
      liquidity: bigint;
    }
    const livePositions: PosData[] = await fallback.call(async (p) => {
      const pm = new ethers.Contract(addresses.positionManagerV3!, POSITION_MANAGER_V3_ABI, p);
      const calls = tokenIds.map(id => buildCall3(pm, 'positions', [id]));
      const results = await multicall3(p, calls);
      const out: PosData[] = [];
      for (let i = 0; i < tokenIds.length; i++) {
        const raw = decodeCall3Result<ethers.Result>(pm, 'positions', results[i]);
        if (!raw) continue;
        const liquidity = BigInt(raw.liquidity);
        if (liquidity === 0n) continue;
        out.push({
          tokenId: tokenIds[i],
          token0: String(raw.token0).toLowerCase(),
          token1: String(raw.token1).toLowerCase(),
          fee: Number(raw.fee),
          tickLower: Number(raw.tickLower),
          tickUpper: Number(raw.tickUpper),
          liquidity,
        });
      }
      return out;
    });

    if (livePositions.length === 0) return [];

    // Round 4: token ERC20 info for unknown tokens + factory.getPool for unique pools — 1 multicall
    const tokenAddrs = new Set<string>();
    for (const p of livePositions) { tokenAddrs.add(p.token0); tokenAddrs.add(p.token1); }
    const unknownTokens = [...tokenAddrs].filter(a => !getTokenCache(this.chain).has(a));

    // Unique (t0, t1, fee) pool tuples — use canonical ordering
    type PoolKey = `${string}:${string}:${number}`;
    const poolKeyMap = new Map<PoolKey, { t0: string; t1: string; fee: number }>();
    for (const p of livePositions) {
      const [tA, tB] = p.token0 < p.token1 ? [p.token0, p.token1] : [p.token1, p.token0];
      const key: PoolKey = `${tA}:${tB}:${p.fee}`;
      if (!poolKeyMap.has(key)) poolKeyMap.set(key, { t0: tA, t1: tB, fee: p.fee });
    }

    const poolAddrs = new Map<PoolKey, string>(); // key → pool address
    await fallback.call(async (p) => {
      const tokenCalls = unknownTokens.flatMap(addr => {
        const c = new ethers.Contract(addr, ERC20_ABI, p);
        return [
          buildCall3(c, 'symbol', []),
          buildCall3(c, 'decimals', []),
        ];
      });

      // Factory calls — use CREATE2 if initCodeHash available, else call factory
      // Declared inside the callback so each retry starts fresh (no index doubling on retry).
      const poolKeys = [...poolKeyMap.entries()];
      type FactoryCallInfo = { key: PoolKey; callIdx: number } | null;
      const extraCalls: ReturnType<typeof buildCall3>[] = [];
      const factoryCalls: FactoryCallInfo[] = [];

      for (const [key, { t0, t1, fee }] of poolKeys) {
        if (addresses.initCodeHashV3 && addresses.factoryV3) {
          // CREATE2 derivation — no RPC needed
          const salt = ethers.solidityPackedKeccak256(['address', 'address', 'uint24'], [t0, t1, fee]);
          poolAddrs.set(key, ethers.getCreate2Address(addresses.factoryV3, salt, addresses.initCodeHashV3));
          factoryCalls.push(null);
        } else if (addresses.factoryV3) {
          const factory = new ethers.Contract(addresses.factoryV3, FACTORY_V3_ABI, p);
          const callIdx = tokenCalls.length + extraCalls.length; // index of the call we're about to add
          extraCalls.push(buildCall3(factory, 'getPool', [t0, t1, fee]));
          factoryCalls.push({ key, callIdx });
        } else {
          factoryCalls.push(null);
        }
      }

      const allCalls = [...tokenCalls, ...extraCalls];
      const results = allCalls.length > 0 ? await multicall3(p, allCalls) : [];

      // Parse token info
      const cache = getTokenCache(this.chain);
      for (let i = 0; i < unknownTokens.length; i++) {
        const c = new ethers.Contract(unknownTokens[i], ERC20_ABI, p);
        const sym = decodeCall3Result<string>(c, 'symbol', results[i * 2]);
        const dec = decodeCall3Result<bigint>(c, 'decimals', results[i * 2 + 1]);
        cache.set(unknownTokens[i], {
          symbol: sym ?? 'UNKNOWN',
          decimals: dec !== null ? Number(dec) : 18,
        });
      }

      // Parse pool addresses from factory calls
      if (addresses.factoryV3) {
        const factory = new ethers.Contract(addresses.factoryV3, FACTORY_V3_ABI, p);
        for (const fc of factoryCalls) {
          if (!fc) continue;
          const addr = decodeCall3Result<string>(factory, 'getPool', results[fc.callIdx]);
          if (addr && addr !== ethers.ZeroAddress) {
            poolAddrs.set(fc.key, addr);
          }
        }
      }
    });

    // Get canonical pool address for a position
    const getPoolAddr = (pos: PosData): string | null => {
      const [tA, tB] = pos.token0 < pos.token1 ? [pos.token0, pos.token1] : [pos.token1, pos.token0];
      const key: PoolKey = `${tA}:${tB}:${pos.fee}`;
      return poolAddrs.get(key) ?? null;
    };

    // Filter positions where pool address was resolved
    const positionsWithPools = livePositions.filter(pos => getPoolAddr(pos) !== null);
    const skipped = livePositions.length - positionsWithPools.length;
    if (skipped > 0) {
      logger.warn(`[EvmScanner][${this.chain}:${this.dex}] ${skipped} position(s) skipped — pool address could not be resolved`);
    }
    if (positionsWithPools.length === 0) return [];

    // Round 5: slot0 for all live pools — 1 multicall
    const uniquePoolAddrs = [...new Set(positionsWithPools.map(pos => getPoolAddr(pos)!))];
    const tickByPool = new Map<string, number>();
    await fallback.call(async (p) => {
      const calls = uniquePoolAddrs.map(addr => {
        const pool = new ethers.Contract(addr, POOL_V3_ABI, p);
        return buildCall3(pool, 'slot0', []);
      });
      const results = await multicall3(p, calls);
      for (let i = 0; i < uniquePoolAddrs.length; i++) {
        const pool = new ethers.Contract(uniquePoolAddrs[i], POOL_V3_ABI, p);
        const decoded = decodeCall3Result<ethers.Result>(pool, 'slot0', results[i]);
        if (decoded) tickByPool.set(uniquePoolAddrs[i], Number(decoded.tick));
      }
    });

    // Build DiscoveredPosition list
    const cache = getTokenCache(this.chain);
    const discovered: DiscoveredPosition[] = [];
    for (const pos of positionsWithPools) {
      const poolAddr = getPoolAddr(pos)!;
      const tickCurrent = tickByPool.get(poolAddr);
      if (tickCurrent === undefined) continue;
      const t0 = cache.get(pos.token0) ?? { symbol: 'UNKNOWN', decimals: 18 };
      const t1 = cache.get(pos.token1) ?? { symbol: 'UNKNOWN', decimals: 18 };
      const dp = this.buildDiscoveredPosition(
        Number(pos.tokenId), pos.token0, t0, pos.token1, t1, pos.fee,
        pos.tickLower, pos.tickUpper, tickCurrent, pos.liquidity, poolAddr,
      );
      if (dp.estimatedUsd >= MIN_POSITION_USD || dp.estimatedUsd === 0) discovered.push(dp);
    }
    logger.info(`[EvmScanner][${this.chain}:${this.dex}] Found ${discovered.length} active positions (${count} NFTs total)`);
    return discovered;
  }

  private async resolvePoolAddress(
    provider: ethers.Provider,
    addresses: ChainDexAddresses,
    token0: string,
    token1: string,
    fee: number,
  ): Promise<string> {
    // 1. Try the configured factory address
    if (addresses.factoryV3) {
      try {
        const factory = new ethers.Contract(addresses.factoryV3, FACTORY_V3_ABI, provider);
        const addr: string = await factory.getPool(token0, token1, fee);
        if (addr !== ethers.ZeroAddress) return addr;
      } catch (err) {
        logger.debug(`[EvmScanner] factory.getPool(${token0}, ${token1}, ${fee}) failed: ${err}`);
        /* fall through */
      }
    }

    // 2. CREATE2 derivation (when initCodeHash is known)
    if (addresses.initCodeHashV3 && addresses.factoryV3) {
      const [tA, tB] = token0.toLowerCase() < token1.toLowerCase() ? [token0, token1] : [token1, token0];
      const salt = ethers.solidityPackedKeccak256(['address', 'address', 'uint24'], [tA, tB, fee]);
      return ethers.getCreate2Address(addresses.factoryV3, salt, addresses.initCodeHashV3);
    }

    // 3. Fallback: read the factory address directly from the PositionManager's immutable factory()
    //    (every Uniswap V3-compatible PM exposes this). Useful when the configured factoryV3 is
    //    wrong or missing (e.g. ProjectX on HyperEVM).
    if (addresses.positionManagerV3) {
      const pmAddr = addresses.positionManagerV3.toLowerCase();
      let resolvedFactory = this._pmFactoryCache.get(pmAddr);
      if (!resolvedFactory) {
        try {
          const pm = new ethers.Contract(addresses.positionManagerV3, POSITION_MANAGER_V3_ABI, provider);
          const f: string = await pm.factory();
          if (f && f !== ethers.ZeroAddress) {
            resolvedFactory = f;
            this._pmFactoryCache.set(pmAddr, f);
            logger.info(
              `[EvmScanner][${this.chain}:${this.dex}] PM factory resolved: ${f}` +
              ` — consider adding factoryV3: '${f}' to chainRegistry for ${this.chain}:${this.dex}`
            );
          }
        } catch (err) {
          logger.debug(`[EvmScanner] pm.factory() failed: ${err}`);
        }
      }
      if (resolvedFactory) {
        try {
          const factory = new ethers.Contract(resolvedFactory, FACTORY_V3_ABI, provider);
          const addr: string = await factory.getPool(token0, token1, fee);
          if (addr !== ethers.ZeroAddress) return addr;
          logger.debug(`[EvmScanner] pm-resolved factory.getPool returned ZeroAddress for ${token0}/${token1} fee=${fee}`);
        } catch (err) {
          logger.debug(`[EvmScanner] pm-resolved factory.getPool failed: ${err}`);
        }
      }
    }

    throw new NonRetryableError(`Cannot resolve pool address for ${token0}/${token1} fee=${fee}: no factory or initCodeHash configured`);
  }

  private async getTokenInfo(provider: ethers.Provider, address: string): Promise<TokenMeta> {
    const addr = address.toLowerCase();
    const cache = getTokenCache(this.chain);
    const cached = cache.get(addr);
    if (cached) return cached;
    try {
      const erc20 = new ethers.Contract(address, ERC20_ABI, provider);
      const [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
      const info: TokenMeta = { symbol: String(symbol), decimals: Number(decimals) };
      cache.set(addr, info);
      return info;
    } catch {
      return { symbol: 'UNKNOWN', decimals: 18 };
    }
  }

  private buildDiscoveredPosition(
    tokenId: number,
    t0Addr: string, t0: TokenMeta,
    t1Addr: string, t1: TokenMeta,
    fee: number,
    tickLower: number, tickUpper: number, tickCurrent: number,
    liquidity: bigint, poolAddress: string,
  ): DiscoveredPosition {
    const [amount0, amount1] = this.computeAmountsFromTicks(liquidity, tickCurrent, tickLower, tickUpper);
    const t0Amount = Number(ethers.formatUnits(amount0, t0.decimals));
    const t1Amount = Number(ethers.formatUnits(amount1, t1.decimals));
    const decimalAdj = t0.decimals - t1.decimals;
    const price = Math.pow(1.0001, tickCurrent) * Math.pow(10, decimalAdj);

    const t0Stable = STABLE_SYMBOLS.has(t0.symbol);
    const t1Stable = STABLE_SYMBOLS.has(t1.symbol);
    const estimatedUsd = t0Stable
      ? t0Amount + t1Amount * (1 / price)
      : t1Stable
        ? t0Amount * price + t1Amount
        : 0;

    const rangeStatus = tickCurrent < tickLower ? 'below-range'
      : tickCurrent >= tickUpper ? 'above-range'
      : 'in-range';

    const protocolVersion = (this.dex === 'uniswap-v4' || this.dex === 'pancake-v4') ? 'v4' : 'v3';

    return {
      tokenId,
      protocolVersion,
      token0Address: t0Addr,
      token0Symbol: t0.symbol,
      token0Decimals: t0.decimals,
      token1Address: t1Addr,
      token1Symbol: t1.symbol,
      token1Decimals: t1.decimals,
      fee,
      tickLower, tickUpper, tickCurrent,
      liquidity: liquidity.toString(),
      poolAddress,
      rangeStatus,
      token0AmountFormatted: t0Amount,
      token1AmountFormatted: t1Amount,
      price,
      estimatedUsd,
      chain: this.chain,
      dex: this.dex,
    };
  }

  private computeAmountsFromTicks(liquidity: bigint, tickCurrent: number, tickLower: number, tickUpper: number): [bigint, bigint] {
    const sqrtPriceCurrent = Math.sqrt(Math.pow(1.0001, tickCurrent));
    const sqrtPriceLower   = Math.sqrt(Math.pow(1.0001, tickLower));
    const sqrtPriceUpper   = Math.sqrt(Math.pow(1.0001, tickUpper));
    const liq = Number(liquidity);
    let amount0 = 0, amount1 = 0;
    if (tickCurrent < tickLower) { amount0 = liq * (1 / sqrtPriceLower - 1 / sqrtPriceUpper); }
    else if (tickCurrent >= tickUpper) { amount1 = liq * (sqrtPriceUpper - sqrtPriceLower); }
    else { amount0 = liq * (1 / sqrtPriceCurrent - 1 / sqrtPriceUpper); amount1 = liq * (sqrtPriceCurrent - sqrtPriceLower); }
    return [BigInt(Math.floor(amount0)), BigInt(Math.floor(amount1))];
  }
}
