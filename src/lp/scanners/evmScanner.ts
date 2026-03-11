import { ethers } from 'ethers';
import { DiscoveredPosition } from '../../types';
import { logger } from '../../utils/logger';
import { ChainId, DexId, IWalletScanner, PositionId } from '../types';
import { getChainDexAddresses, ChainDexAddresses } from '../chainRegistry';
import { getLpProvider } from '../chainProviders';
import { getTokenCache, KNOWN_TOKENS_BY_CHAIN, seedTokenCache, TokenMeta } from '../tokenCache';
import { NonRetryableError } from '../../utils/fallbackProvider';
import { multicall3, buildCall3, decodeCall3Result } from '../../utils/multicall';
import { getZapperComplexPositions, isZapperSupportedChain, ZapperComplexPosition } from '../zapperClient';
import { fetchTokenUsd } from '../../utils/priceApi';

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

const POSITION_MANAGER_V4_ABI = [
  'function getPoolAndPositionInfo(uint256 tokenId) view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bytes32 info)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

const STATE_VIEW_V4_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
];

const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'USDbC', 'DAI', 'USDS', 'crvUSD', 'BUSD', 'FRAX', 'LUSD', 'PYUSD', 'USDE', 'TUSD', 'FDUSD']);

const MIN_POSITION_USD = 10;

// Approximate block at which Uniswap V4 contracts were deployed per chain.
// Used as fromBlock in ModifyLiquidity event scans to avoid scanning from genesis.
const V4_DEPLOY_BLOCKS: Partial<Record<ChainId, number>> = {
  'base': 23_000_000,
  'eth': 21_500_000,
  'bsc': 45_000_000,
  'arbitrum': 290_000_000,
  'polygon': 65_000_000,
  'avalanche': 54_000_000,
  'hyperliquid-l1': 0,
};

/** Parse NFT tokenId from Zapper label. Handles "Token ID: 123" and "#123" formats. */
function parseTokenIdFromLabel(label: string): number {
  const m1 = label.match(/Token ID:\s*(\d+)/i);
  if (m1) return Number(m1[1]);
  const m2 = label.match(/#(\d+)/);
  if (m2) return Number(m2[1]);
  return 0;
}

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
    if (!isZapperSupportedChain(this.chain)) {
      logger.warn(`[EvmScanner][${this.chain}:${this.dex}] Chain not supported by Zapper — scan unavailable`);
      return [];
    }

    const zPositions = await getZapperComplexPositions(walletAddress);
    if (!zPositions || zPositions.length === 0) {
      logger.info(`[EvmScanner][${this.chain}:${this.dex}] Zapper returned no positions for ${walletAddress}`);
      return [];
    }

    const relevant = zPositions.filter(p => p.chainId === this.chain && p.dexId === this.dex);
    if (relevant.length === 0) {
      const onChain = zPositions.filter(p => p.chainId === this.chain);
      if (onChain.length > 0) {
        logger.warn(`[EvmScanner][${this.chain}:${this.dex}] ${onChain.length} Zapper position(s) on chain but dexId mismatch — got: [${[...new Set(onChain.map(p => p.dexId))].join(', ')}]`);
      }
      return [];
    }

    if (this.dex === 'uniswap-v4' || this.dex === 'pancake-v4') {
      return this.scanV4Hybrid(walletAddress, relevant);
    }
    return this.scanV3Hybrid(walletAddress, relevant);
  }

  private async scanV3Hybrid(walletAddress: string, zPositions: ZapperComplexPosition[]): Promise<DiscoveredPosition[]> {
    const tag = `[EvmScanner][${this.chain}:${this.dex}]`;
    const addresses = getChainDexAddresses(this.chain, this.dex);
    if (!addresses.positionManagerV3) {
      logger.warn(`${tag} No positionManagerV3 configured — skipping`);
      return [];
    }

    const posDataList = zPositions.map(p => {
      return { tokenId: parseTokenIdFromLabel(p.name), zPos: p };
    }).filter(p => p.tokenId > 0);

    if (posDataList.length === 0) {
      logger.warn(`${tag} No tokenIds parseable from Zapper position names: [${zPositions.map(p => p.name).join(' | ')}]`);
      return [];
    }

    // Seed token cache from Zapper metadata (avoids ERC20 RPC calls for known tokens)
    const tokenCache = getTokenCache(this.chain);
    for (const zp of zPositions) {
      for (const t of zp.tokens) {
        if (t.address) tokenCache.set(t.address.toLowerCase(), { symbol: t.symbol, decimals: t.decimals });
      }
    }

    const fallback = getLpProvider(this.chain);
    const pmAddr = addresses.positionManagerV3;

    // Round 1: positions() for all tokenIds — 1 multicall
    interface PosData {
      tokenId: number;
      token0: string;
      token1: string;
      fee: number;
      tickLower: number;
      tickUpper: number;
      liquidity: bigint;
    }

    logger.info(`${tag} [Round 1] pm.positions() via multicall on PM=${pmAddr} for ${posDataList.length} tokenId(s): [${posDataList.map(p => p.tokenId).join(', ')}]`);
    const livePositions: PosData[] = await fallback.call(async (provider) => {
      const pm = new ethers.Contract(pmAddr, POSITION_MANAGER_V3_ABI, provider);
      const calls = posDataList.map(p => buildCall3(pm, 'positions', [p.tokenId]));
      const results = await multicall3(provider, calls);
      const out: PosData[] = [];
      for (let i = 0; i < posDataList.length; i++) {
        const raw = decodeCall3Result<ethers.Result>(pm, 'positions', results[i]);
        if (!raw) {
          logger.warn(`${tag} positions(${posDataList[i].tokenId}) multicall failed (success=${results[i].success}, returnData=${results[i].returnData.slice(0, 20)}...)`);
          continue;
        }
        const liquidity = BigInt(raw.liquidity);
        if (liquidity === 0n) {
          logger.warn(`${tag} positions(${posDataList[i].tokenId}) liquidity=0 — closed or burned`);
          continue;
        }
        logger.info(`${tag}   #${posDataList[i].tokenId}: token0=${String(raw.token0).slice(0,10)}… token1=${String(raw.token1).slice(0,10)}… fee=${raw.fee} ticks=[${raw.tickLower},${raw.tickUpper}] liq=${liquidity}`);
        out.push({
          tokenId: posDataList[i].tokenId,
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

    if (livePositions.length === 0) {
      logger.warn(`${tag} No positions with liquidity > 0 — nothing to scan`);
      return [];
    }
    logger.info(`${tag} ${livePositions.length} position(s) with liquidity`);

    // Safety net: fetch metadata for any token Zapper didn't cover
    const tokenAddrs = new Set<string>();
    for (const p of livePositions) { tokenAddrs.add(p.token0); tokenAddrs.add(p.token1); }
    const unknownTokens = [...tokenAddrs].filter(a => !tokenCache.has(a));
    if (unknownTokens.length > 0) {
      logger.info(`${tag} [Round 2] ERC20 metadata for ${unknownTokens.length} unknown token(s)`);
      await fallback.call(async (provider) => {
        const calls = unknownTokens.flatMap(addr => {
          const c = new ethers.Contract(addr, ERC20_ABI, provider);
          return [buildCall3(c, 'symbol', []), buildCall3(c, 'decimals', [])];
        });
        const results = await multicall3(provider, calls);
        for (let i = 0; i < unknownTokens.length; i++) {
          const c = new ethers.Contract(unknownTokens[i], ERC20_ABI, provider);
          const sym = decodeCall3Result<string>(c, 'symbol', results[i * 2]);
          const dec = decodeCall3Result<bigint>(c, 'decimals', results[i * 2 + 1]);
          tokenCache.set(unknownTokens[i], { symbol: sym ?? 'UNKNOWN', decimals: dec !== null ? Number(dec) : 18 });
        }
      });
    } else {
      logger.info(`${tag} All tokens already in cache — skipping ERC20 metadata fetch`);
    }

    // Resolve pool addresses via factory.getPool (primary) or CREATE2 (fallback)
    // NOTE: Zapper returns the PositionManager address, NOT the pool address, so we always resolve on-chain
    type PoolKey = `${string}:${string}:${number}`;
    const poolKeyMap = new Map<PoolKey, { t0: string; t1: string; fee: number }>();
    for (const p of livePositions) {
      const [tA, tB] = p.token0 < p.token1 ? [p.token0, p.token1] : [p.token1, p.token0];
      const key: PoolKey = `${tA}:${tB}:${p.fee}`;
      if (!poolKeyMap.has(key)) poolKeyMap.set(key, { t0: tA, t1: tB, fee: p.fee });
    }

    const poolAddrs = new Map<PoolKey, string>();
    const poolKeys = [...poolKeyMap.entries()];

    if (!addresses.factoryV3) {
      logger.warn(`${tag} No factoryV3 configured — cannot resolve pool addresses`);
    } else {
      logger.info(`${tag} [Pool Resolution] factory.getPool() multicall for ${poolKeys.length} pool(s) (factory=${addresses.factoryV3})`);
      await fallback.call(async (provider) => {
        const factory = new ethers.Contract(addresses.factoryV3!, FACTORY_V3_ABI, provider);
        const calls = poolKeys.map(([, { t0, t1, fee }]) => buildCall3(factory, 'getPool', [t0, t1, fee]));
        const results = await multicall3(provider, calls);
        for (let i = 0; i < poolKeys.length; i++) {
          const addr = decodeCall3Result<string>(factory, 'getPool', results[i]);
          const { t0, t1, fee } = poolKeys[i][1];
          if (addr && addr !== ethers.ZeroAddress) {
            poolAddrs.set(poolKeys[i][0], addr.toLowerCase());
            logger.info(`${tag}   factory.getPool(${t0.slice(0,10)}…/${t1.slice(0,10)}… fee=${fee}) → ${addr}`);
          } else {
            logger.warn(`${tag}   factory.getPool(${t0.slice(0,10)}…/${t1.slice(0,10)}… fee=${fee}) returned ZeroAddress`);
          }
        }
      });
    }

    const getPoolAddr = (p: PosData): string | null => {
      const [tA, tB] = p.token0 < p.token1 ? [p.token0, p.token1] : [p.token1, p.token0];
      return poolAddrs.get(`${tA}:${tB}:${p.fee}`) ?? null;
    };

    const posWithPools = livePositions.filter(p => getPoolAddr(p) !== null);
    if (posWithPools.length === 0) {
      logger.warn(`${tag} Pool address not resolved for any position`);
      return [];
    }

    // slot0 for unique pools — 1 multicall
    const uniquePoolAddrs = [...new Set(posWithPools.map(p => getPoolAddr(p)!))];
    logger.info(`${tag} [Round 3] slot0() for ${uniquePoolAddrs.length} unique pool(s): [${uniquePoolAddrs.join(', ')}]`);
    const tickByPool = new Map<string, number>();
    await fallback.call(async (provider) => {
      const calls = uniquePoolAddrs.map(addr => {
        const pool = new ethers.Contract(addr, POOL_V3_ABI, provider);
        return buildCall3(pool, 'slot0', []);
      });
      const results = await multicall3(provider, calls);
      for (let i = 0; i < uniquePoolAddrs.length; i++) {
        const r = results[i];
        if (!r.success) {
          logger.warn(`${tag}   slot0(${uniquePoolAddrs[i]}) REVERTED`);
          continue;
        }
        if (!r.returnData || r.returnData === '0x') {
          logger.warn(`${tag}   slot0(${uniquePoolAddrs[i]}) returned empty data (no contract at address?)`);
          continue;
        }
        // Try standard 7-field slot0 first, then 6-field variant
        try {
          const pool = new ethers.Contract(uniquePoolAddrs[i], POOL_V3_ABI, provider);
          const decoded = pool.interface.decodeFunctionResult('slot0', r.returnData);
          tickByPool.set(uniquePoolAddrs[i], Number(decoded.tick));
          logger.info(`${tag}   slot0(${uniquePoolAddrs[i]}): tick=${decoded.tick} sqrtPrice=${decoded.sqrtPriceX96}`);
        } catch (err7) {
          // Some pools return fewer fields — try raw ABI decode
          try {
            const abiCoder = ethers.AbiCoder.defaultAbiCoder();
            const decoded = abiCoder.decode(['uint160', 'int24'], r.returnData);
            const tick = Number(decoded[1]);
            tickByPool.set(uniquePoolAddrs[i], tick);
            logger.info(`${tag}   slot0(${uniquePoolAddrs[i]}): tick=${tick} (decoded with minimal ABI)`);
          } catch (err2) {
            const dataLen = (r.returnData.length - 2) / 2; // hex string → bytes
            logger.warn(`${tag}   slot0(${uniquePoolAddrs[i]}) DECODE FAILED: returnData=${dataLen} bytes, data=${r.returnData.slice(0, 66)}… err=${err7}`);
          }
        }
      }
    });

    // Fetch USD prices for unique volatile tokens via DexScreener
    const volatileAddrs = new Set<string>();
    for (const p of posWithPools) {
      if (!STABLE_SYMBOLS.has(tokenCache.get(p.token0)?.symbol ?? '')) volatileAddrs.add(p.token0);
      if (!STABLE_SYMBOLS.has(tokenCache.get(p.token1)?.symbol ?? '')) volatileAddrs.add(p.token1);
    }
    if (volatileAddrs.size > 0) {
      logger.info(`${tag} [Prices] Fetching USD prices for ${volatileAddrs.size} volatile token(s)`);
    }
    const tokenPricesUsd = await this.fetchVolatilePrices([...volatileAddrs]);

    // Build DiscoveredPosition list
    const discovered: DiscoveredPosition[] = [];
    for (const pos of posWithPools) {
      const poolAddr = getPoolAddr(pos)!;
      const tickCurrent = tickByPool.get(poolAddr);
      if (tickCurrent === undefined) {
        logger.warn(`${tag} #${pos.tokenId}: slot0 unavailable for pool ${poolAddr} — skipping`);
        continue;
      }
      const t0 = tokenCache.get(pos.token0) ?? { symbol: 'UNKNOWN', decimals: 18 };
      const t1 = tokenCache.get(pos.token1) ?? { symbol: 'UNKNOWN', decimals: 18 };
      const dp = this.buildDiscoveredPosition(
        pos.tokenId, pos.token0, t0, pos.token1, t1, pos.fee,
        pos.tickLower, pos.tickUpper, tickCurrent, pos.liquidity, poolAddr,
        tokenPricesUsd.get(pos.token0), tokenPricesUsd.get(pos.token1),
      );
      logger.info(`${tag}   #${pos.tokenId}: ${t0.symbol}/${t1.symbol} pool=${poolAddr} tick=${tickCurrent} est=$${dp.estimatedUsd.toFixed(2)} range=${dp.rangeStatus}`);
      if (dp.estimatedUsd >= MIN_POSITION_USD || dp.estimatedUsd === 0) discovered.push(dp);
    }

    logger.info(`${tag} scanV3Hybrid: ${discovered.length} active positions`);
    return discovered;
  }

  private async scanV4Hybrid(walletAddress: string, zPositions: ZapperComplexPosition[]): Promise<DiscoveredPosition[]> {
    const addresses = getChainDexAddresses(this.chain, this.dex);
    if (!addresses.positionManagerV4 || !addresses.stateViewV4) return [];

    const posDataList = zPositions.map(p => {
      return { tokenId: parseTokenIdFromLabel(p.name), zPos: p };
    }).filter(p => p.tokenId > 0);

    if (posDataList.length === 0) {
      logger.warn(`[EvmScanner][${this.chain}:${this.dex}] No tokenIds parseable from Zapper position names: [${zPositions.map(p => p.name).join(' | ')}]`);
      return [];
    }

    // Seed token cache from Zapper metadata (avoids ERC20 RPC calls for known tokens)
    const tokenCache = getTokenCache(this.chain);
    for (const zp of zPositions) {
      for (const t of zp.tokens) {
        if (t.address) tokenCache.set(t.address.toLowerCase(), { symbol: t.symbol, decimals: t.decimals });
      }
    }

    const fallback = getLpProvider(this.chain);
    const pmAddr = addresses.positionManagerV4;
    const svAddr = addresses.stateViewV4;

    // Round 1: [getPositionLiquidity + getPoolAndPositionInfo] for all tokenIds — 1 multicall
    interface V4PosData {
      tokenId: number;
      poolId: string;
      tickLower: number;
      tickUpper: number;
      liquidity: bigint;
      currency0: string;
      currency1: string;
      fee: number;
    }

    const ownedPositions: V4PosData[] = await fallback.call(async (provider) => {
      const pm = new ethers.Contract(pmAddr, POSITION_MANAGER_V4_ABI, provider);
      const calls = posDataList.flatMap(({ tokenId }) => [
        buildCall3(pm, 'getPositionLiquidity', [tokenId]),
        buildCall3(pm, 'getPoolAndPositionInfo', [tokenId]),
      ]);
      const results = await multicall3(provider, calls);
      const out: V4PosData[] = [];

      for (let i = 0; i < posDataList.length; i++) {
        const liqResult = results[i * 2];
        const infoResult = results[i * 2 + 1];
        if (!liqResult.success || !infoResult.success) continue;

        const liqDecoded = pm.interface.decodeFunctionResult('getPositionLiquidity', liqResult.returnData);
        const liquidity = BigInt(liqDecoded[0]);
        if (liquidity === 0n) continue;

        const decoded = pm.interface.decodeFunctionResult('getPoolAndPositionInfo', infoResult.returnData);
        const poolKey = decoded[0];
        const infoBig = BigInt(decoded[1] as string);

        // bits 0-7 = hasSubscriber flag; tickLower >> 8, tickUpper >> 32
        const rawTickLower = Number((infoBig >> 8n) & 0xFFFFFFn);
        const tickLower = rawTickLower > 0x7FFFFFn ? rawTickLower - 0x1000000 : rawTickLower;
        const rawTickUpper = Number((infoBig >> 32n) & 0xFFFFFFn);
        const tickUpper = rawTickUpper > 0x7FFFFFn ? rawTickUpper - 0x1000000 : rawTickUpper;

        const poolId = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ['address', 'address', 'uint24', 'int24', 'address'],
            [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
          )
        );

        out.push({
          tokenId: posDataList[i].tokenId,
          poolId,
          tickLower, tickUpper,
          liquidity,
          currency0: String(poolKey.currency0).toLowerCase(),
          currency1: String(poolKey.currency1).toLowerCase(),
          fee: Number(poolKey.fee),
        });
      }
      return out;
    });

    if (ownedPositions.length === 0) return [];

    // Safety net: fetch metadata for any token Zapper didn't cover
    const tokenAddrs = new Set<string>();
    for (const pos of ownedPositions) { tokenAddrs.add(pos.currency0); tokenAddrs.add(pos.currency1); }
    const unknownTokens = [...tokenAddrs].filter(a => !tokenCache.has(a));
    const uniquePoolIds = [...new Set(ownedPositions.map(p => p.poolId))];
    const tickByPool = new Map<string, number>();

    // Round 2: unknown token info + slot0 for unique pools — 1 multicall
    await fallback.call(async (provider) => {
      const sv = new ethers.Contract(svAddr, STATE_VIEW_V4_ABI, provider);
      const tokenCalls = unknownTokens.flatMap(addr => {
        const c = new ethers.Contract(addr, ERC20_ABI, provider);
        return [buildCall3(c, 'symbol', []), buildCall3(c, 'decimals', [])];
      });
      const slotCalls = uniquePoolIds.map(poolId => buildCall3(sv, 'getSlot0', [poolId]));
      const results = await multicall3(provider, [...tokenCalls, ...slotCalls]);

      for (let i = 0; i < unknownTokens.length; i++) {
        const c = new ethers.Contract(unknownTokens[i], ERC20_ABI, provider);
        const sym = decodeCall3Result<string>(c, 'symbol', results[i * 2]);
        const dec = decodeCall3Result<bigint>(c, 'decimals', results[i * 2 + 1]);
        tokenCache.set(unknownTokens[i], { symbol: sym ?? 'UNKNOWN', decimals: dec !== null ? Number(dec) : 18 });
      }
      for (let i = 0; i < uniquePoolIds.length; i++) {
        const r = results[tokenCalls.length + i];
        if (!r.success) continue;
        const decoded = sv.interface.decodeFunctionResult('getSlot0', r.returnData);
        tickByPool.set(uniquePoolIds[i], Number(decoded.tick));
      }
    });

    // Fetch USD prices for unique volatile tokens via DexScreener
    const volatileAddrs = new Set<string>();
    for (const pos of ownedPositions) {
      if (!STABLE_SYMBOLS.has(tokenCache.get(pos.currency0)?.symbol ?? '')) volatileAddrs.add(pos.currency0);
      if (!STABLE_SYMBOLS.has(tokenCache.get(pos.currency1)?.symbol ?? '')) volatileAddrs.add(pos.currency1);
    }
    const tokenPricesUsd = await this.fetchVolatilePrices([...volatileAddrs]);

    // Build DiscoveredPosition list
    const discovered: DiscoveredPosition[] = [];
    for (const pos of ownedPositions) {
      const tickCurrent = tickByPool.get(pos.poolId);
      if (tickCurrent === undefined) continue;
      const t0 = tokenCache.get(pos.currency0) ?? { symbol: 'UNKNOWN', decimals: 18 };
      const t1 = tokenCache.get(pos.currency1) ?? { symbol: 'UNKNOWN', decimals: 18 };
      const dp = this.buildDiscoveredPosition(
        pos.tokenId, pos.currency0, t0, pos.currency1, t1, pos.fee,
        pos.tickLower, pos.tickUpper, tickCurrent, pos.liquidity, pos.poolId,
        tokenPricesUsd.get(pos.currency0), tokenPricesUsd.get(pos.currency1),
      );
      if (dp.estimatedUsd >= MIN_POSITION_USD || dp.estimatedUsd === 0) discovered.push(dp);
    }

    logger.info(`[EvmScanner][${this.chain}:${this.dex}] scanV4Hybrid: ${discovered.length} active positions`);
    return discovered;
  }

  private async fetchVolatilePrices(addresses: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (addresses.length === 0) return result;
    const prices = await Promise.all(addresses.map(addr => fetchTokenUsd(addr, this.chain)));
    for (let i = 0; i < addresses.length; i++) {
      if (prices[i] !== null) result.set(addresses[i], prices[i]!);
    }
    return result;
  }

  async lookupById(id: PositionId): Promise<DiscoveredPosition | null> {
    if (this.dex === 'uniswap-v4' || this.dex === 'pancake-v4') {
      return this.lookupByTokenIdV4(Number(id));
    }
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

  private async lookupByTokenIdV4(tokenId: number): Promise<DiscoveredPosition | null> {
    const addresses = getChainDexAddresses(this.chain, this.dex);
    if (!addresses.positionManagerV4 || !addresses.stateViewV4) return null;
    const fallback = getLpProvider(this.chain);

    try {
      return await fallback.call(async (p) => {
        const pm = new ethers.Contract(addresses.positionManagerV4!, POSITION_MANAGER_V4_ABI, p);
        const sv = new ethers.Contract(addresses.stateViewV4!, STATE_VIEW_V4_ABI, p);

        const liquidity: bigint = BigInt(await pm.getPositionLiquidity(tokenId));
        if (liquidity === 0n) return null;

        const { poolKey, info } = await pm.getPoolAndPositionInfo(tokenId);
        const infoBig = BigInt(info as string);
        const rawTickLower = Number((infoBig >> 8n) & 0xFFFFFFn);
        const tickLower = rawTickLower > 0x7FFFFFn ? rawTickLower - 0x1000000 : rawTickLower;
        const rawTickUpper = Number((infoBig >> 32n) & 0xFFFFFFn);
        const tickUpper = rawTickUpper > 0x7FFFFFn ? rawTickUpper - 0x1000000 : rawTickUpper;

        const poolId = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ['address', 'address', 'uint24', 'int24', 'address'],
            [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
          )
        );

        const [t0Info, t1Info, slot0] = await Promise.all([
          this.getTokenInfo(p, poolKey.currency0),
          this.getTokenInfo(p, poolKey.currency1),
          sv.getSlot0(poolId),
        ]);

        const tickCurrent = Number(slot0.tick);
        const dp = this.buildDiscoveredPosition(
          tokenId,
          String(poolKey.currency0).toLowerCase(), t0Info,
          String(poolKey.currency1).toLowerCase(), t1Info,
          Number(poolKey.fee),
          tickLower, tickUpper, tickCurrent,
          liquidity, poolId,
        );
        logger.info(`[EvmScanner][${this.chain}:${this.dex}] lookupByIdV4 #${tokenId}: ${t0Info.symbol}/${t1Info.symbol}`);
        return dp;
      });
    } catch (err) {
      logger.info(`[EvmScanner][${this.chain}:${this.dex}] lookupByIdV4 #${tokenId} failed: ${err}`);
      return null;
    }
  }

  private async scanV4(walletAddress: string): Promise<DiscoveredPosition[]> {
    const addresses = getChainDexAddresses(this.chain, this.dex);
    if (!addresses.positionManagerV4 || !addresses.stateViewV4) return [];
    if (!addresses.poolManagerV4) {
      logger.warn(`[EvmScanner][${this.chain}:${this.dex}] poolManagerV4 not configured — V4 scan skipped. Add poolManagerV4 to chainRegistry.`);
      return [];
    }

    const fallback = getLpProvider(this.chain);
    const pmAddr = addresses.positionManagerV4;
    const svAddr = addresses.stateViewV4;
    const poolMgrAddr = addresses.poolManagerV4;

    // Round 1: PoolManager.ModifyLiquidity events where sender = positionManagerV4
    // Signature: ModifyLiquidity(bytes32 indexed id, address indexed sender,
    //                            int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)
    // - sender (topic[2]) = positionManagerV4 for all NFT-managed positions
    // - salt = bytes32(tokenId) — encodes which NFT was modified
    // - liquidityDelta: positive on mint/increase, negative on decrease/burn
    // Summing liquidityDelta per tokenId gives current liquidity — far fewer events than Transfer.
    const LOG_CHUNK_SIZE = 9_000;
    const LOG_CONCURRENCY = 10;
    const modifyTopic = ethers.id('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)');
    const paddedPm = ethers.zeroPadValue(pmAddr.toLowerCase(), 32);

    const currentBlock = await fallback.call(async (p) => p.getBlockNumber());
    const deployBlock = V4_DEPLOY_BLOCKS[this.chain] ?? 0;

    const chunks: Array<{ from: number; to: number }> = [];
    for (let from = deployBlock; from <= currentBlock; from += LOG_CHUNK_SIZE) {
      chunks.push({ from, to: Math.min(from + LOG_CHUNK_SIZE - 1, currentBlock) });
    }

    // Per-tokenId accumulated data from events
    interface EventData { poolId: string; tickLower: number; tickUpper: number; liquidity: bigint; }
    const tokenMap = new Map<number, EventData>();

    const mlIface = new ethers.Interface([
      'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
    ]);

    for (let i = 0; i < chunks.length; i += LOG_CONCURRENCY) {
      const batch = chunks.slice(i, i + LOG_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(({ from, to }) =>
          fallback.call(async (p) =>
            p.getLogs({
              address: poolMgrAddr,
              topics: [modifyTopic, null, paddedPm],
              fromBlock: from,
              toBlock: to,
            })
          ).catch(err => {
            logger.warn(`[EvmScanner][${this.chain}:${this.dex}] ModifyLiquidity chunk ${from}-${to} failed: ${err}`);
            return [];
          })
        )
      );
      for (const logs of batchResults) {
        for (const log of logs) {
          try {
            const parsed = mlIface.parseLog({ topics: log.topics as string[], data: log.data });
            if (!parsed) continue;
            const tokenId = Number(BigInt(parsed.args.salt as string));
            const poolId = log.topics[1] as string;
            const liquidityDelta = parsed.args.liquidityDelta as bigint;
            const tickLower = Number(parsed.args.tickLower);
            const tickUpper = Number(parsed.args.tickUpper);
            const existing = tokenMap.get(tokenId);
            if (existing) {
              existing.liquidity = existing.liquidity + liquidityDelta;
            } else {
              tokenMap.set(tokenId, { poolId, tickLower, tickUpper, liquidity: liquidityDelta });
            }
          } catch { /* skip unparseable log */ }
        }
      }
    }

    // Filter to tokenIds with positive net liquidity
    const liveTokenIds = [...tokenMap.entries()]
      .filter(([, d]) => d.liquidity > 0n)
      .map(([id]) => id);

    if (liveTokenIds.length === 0) return [];
    logger.info(`[EvmScanner][${this.chain}:${this.dex}] Found ${liveTokenIds.length} live V4 positions from events`);

    // Round 2: ownerOf + getPoolAndPositionInfo for all live tokenIds — 1 multicall
    interface V4PosData {
      tokenId: number;
      poolId: string;
      tickLower: number;
      tickUpper: number;
      liquidity: bigint;
      currency0: string;
      currency1: string;
      fee: number;
    }

    const ownedPositions: V4PosData[] = await fallback.call(async (p) => {
      const pm = new ethers.Contract(pmAddr, POSITION_MANAGER_V4_ABI, p);
      const calls = liveTokenIds.flatMap(id => [
        buildCall3(pm, 'ownerOf', [id]),
        buildCall3(pm, 'getPoolAndPositionInfo', [id]),
      ]);
      const results = await multicall3(p, calls);
      const out: V4PosData[] = [];

      for (let i = 0; i < liveTokenIds.length; i++) {
        const ownerResult = results[i * 2];
        const infoResult = results[i * 2 + 1];

        const owner = decodeCall3Result<string>(pm, 'ownerOf', ownerResult);
        if (!owner || owner.toLowerCase() !== walletAddress.toLowerCase()) continue;

        if (!infoResult.success) continue;
        const decoded = pm.interface.decodeFunctionResult('getPoolAndPositionInfo', infoResult.returnData);
        const poolKey = decoded[0];

        const tokenId = liveTokenIds[i];
        const data = tokenMap.get(tokenId)!;
        out.push({
          tokenId,
          poolId: data.poolId,
          tickLower: data.tickLower,
          tickUpper: data.tickUpper,
          liquidity: data.liquidity,
          currency0: String(poolKey.currency0).toLowerCase(),
          currency1: String(poolKey.currency1).toLowerCase(),
          fee: Number(poolKey.fee),
        });
      }
      return out;
    });

    if (ownedPositions.length === 0) return [];

    // Round 3: token info for unknown tokens + slot0 for unique pools — 1 multicall
    const tokenAddrs = new Set<string>();
    for (const pos of ownedPositions) { tokenAddrs.add(pos.currency0); tokenAddrs.add(pos.currency1); }
    const unknownTokens = [...tokenAddrs].filter(a => !getTokenCache(this.chain).has(a));
    const uniquePoolIds = [...new Set(ownedPositions.map(p => p.poolId))];

    const tickByPool = new Map<string, number>();
    await fallback.call(async (p) => {
      const sv = new ethers.Contract(svAddr, STATE_VIEW_V4_ABI, p);
      const tokenCalls = unknownTokens.flatMap(addr => {
        const c = new ethers.Contract(addr, ERC20_ABI, p);
        return [buildCall3(c, 'symbol', []), buildCall3(c, 'decimals', [])];
      });
      const slotCalls = uniquePoolIds.map(poolId => buildCall3(sv, 'getSlot0', [poolId]));
      const allCalls = [...tokenCalls, ...slotCalls];
      const results = await multicall3(p, allCalls);

      const cache = getTokenCache(this.chain);
      for (let i = 0; i < unknownTokens.length; i++) {
        const c = new ethers.Contract(unknownTokens[i], ERC20_ABI, p);
        const sym = decodeCall3Result<string>(c, 'symbol', results[i * 2]);
        const dec = decodeCall3Result<bigint>(c, 'decimals', results[i * 2 + 1]);
        cache.set(unknownTokens[i], { symbol: sym ?? 'UNKNOWN', decimals: dec !== null ? Number(dec) : 18 });
      }
      for (let i = 0; i < uniquePoolIds.length; i++) {
        const r = results[tokenCalls.length + i];
        if (!r.success) continue;
        const decoded = sv.interface.decodeFunctionResult('getSlot0', r.returnData);
        tickByPool.set(uniquePoolIds[i], Number(decoded.tick));
      }
    });

    // Build DiscoveredPosition list
    const tokenCache = getTokenCache(this.chain);
    const discovered: DiscoveredPosition[] = [];
    for (const pos of ownedPositions) {
      const tickCurrent = tickByPool.get(pos.poolId);
      if (tickCurrent === undefined) continue;
      const t0 = tokenCache.get(pos.currency0) ?? { symbol: 'UNKNOWN', decimals: 18 };
      const t1 = tokenCache.get(pos.currency1) ?? { symbol: 'UNKNOWN', decimals: 18 };
      const dp = this.buildDiscoveredPosition(
        pos.tokenId, pos.currency0, t0, pos.currency1, t1, pos.fee,
        pos.tickLower, pos.tickUpper, tickCurrent, pos.liquidity, pos.poolId,
      );
      if (dp.estimatedUsd >= MIN_POSITION_USD || dp.estimatedUsd === 0) discovered.push(dp);
    }
    logger.info(`[EvmScanner][${this.chain}:${this.dex}] Found ${discovered.length} active V4 positions`);
    return discovered;
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

      // Factory calls — resolve pool addresses via factory.getPool()
      // Declared inside the callback so each retry starts fresh (no index doubling on retry).
      const poolKeys = [...poolKeyMap.entries()];
      type FactoryCallInfo = { key: PoolKey; callIdx: number } | null;
      const extraCalls: ReturnType<typeof buildCall3>[] = [];
      const factoryCalls: FactoryCallInfo[] = [];

      for (const [key, { t0, t1, fee }] of poolKeys) {
        if (addresses.factoryV3) {
          const factory = new ethers.Contract(addresses.factoryV3, FACTORY_V3_ABI, p);
          const callIdx = tokenCalls.length + extraCalls.length;
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

    // 2. Fallback: read the factory address directly from the PositionManager's immutable factory()
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

    throw new NonRetryableError(`Cannot resolve pool address for ${token0}/${token1} fee=${fee}: no factory configured`);
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
    t0PriceUsd?: number, t1PriceUsd?: number
  ): DiscoveredPosition {
    const [amount0, amount1] = this.computeAmountsFromTicks(liquidity, tickCurrent, tickLower, tickUpper);
    const t0Amount = Number(ethers.formatUnits(amount0, t0.decimals));
    const t1Amount = Number(ethers.formatUnits(amount1, t1.decimals));
    const decimalAdj = t0.decimals - t1.decimals;
    const price = Math.pow(1.0001, tickCurrent) * Math.pow(10, decimalAdj);

    const t0Stable = STABLE_SYMBOLS.has(t0.symbol);
    const t1Stable = STABLE_SYMBOLS.has(t1.symbol);

    // Calculate estimatedUsd
    let estimatedUsd = 0;
    if (t0Stable) {
      estimatedUsd = t0Amount + t1Amount * (1 / price);
    } else if (t1Stable) {
      estimatedUsd = t0Amount * price + t1Amount;
    } else if (t0PriceUsd !== undefined && t1PriceUsd !== undefined) {
      estimatedUsd = t0Amount * t0PriceUsd + t1Amount * t1PriceUsd;
    }

    // Determine the USD price of token1 (used as quote for volatile pairs)
    let token1PriceUsd: number | undefined;
    if (t1Stable) {
      token1PriceUsd = 1.0;
    } else if (t0Stable && price > 0) {
      token1PriceUsd = 1 / price; // token1 price in terms of stable token0
    } else if (t1PriceUsd !== undefined && t1PriceUsd > 0) {
      token1PriceUsd = t1PriceUsd; // from Zapper
    } else if (estimatedUsd > 0 && t0Amount * price + t1Amount > 0) {
      // derive from total estimatedUsd if Zapper didn't provide individual token prices
      token1PriceUsd = estimatedUsd / (t0Amount * price + t1Amount);
    }

    // Calculate USD-equivalent range prices
    let priceLowerUsd: number | undefined;
    let priceUpperUsd: number | undefined;

    if (t0Stable) {
      // price is token1/token0. Since token0 is stable, price = 1/usdPrice
      const rawLower = Math.pow(1.0001, tickLower) * Math.pow(10, decimalAdj);
      const rawUpper = Math.pow(1.0001, tickUpper) * Math.pow(10, decimalAdj);
      priceLowerUsd = rawUpper > 0 ? 1 / rawUpper : 0; // inverted so High tick = Low USD price
      priceUpperUsd = rawLower > 0 ? 1 / rawLower : 0;
    } else if (token1PriceUsd !== undefined) {
      // Base case: token1 is quote (or derived as quote). Tick price = token1/token0
      const rawLower = Math.pow(1.0001, tickLower) * Math.pow(10, decimalAdj);
      const rawUpper = Math.pow(1.0001, tickUpper) * Math.pow(10, decimalAdj);
      priceLowerUsd = rawLower * token1PriceUsd;
      priceUpperUsd = rawUpper * token1PriceUsd;
    }

    const p0Usd = token1PriceUsd !== undefined ? price * token1PriceUsd : undefined;

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
      priceUsd: p0Usd, // We can add this if needed, but the main ones are the bounds
      token0PriceUsd: p0Usd,
      estimatedUsd,
      priceLowerUsd,
      priceUpperUsd,
      token1PriceUsd,
      chain: this.chain,
      dex: this.dex,
    };
  }

  private computeAmountsFromTicks(liquidity: bigint, tickCurrent: number, tickLower: number, tickUpper: number): [bigint, bigint] {
    const sqrtPriceCurrent = Math.sqrt(Math.pow(1.0001, tickCurrent));
    const sqrtPriceLower = Math.sqrt(Math.pow(1.0001, tickLower));
    const sqrtPriceUpper = Math.sqrt(Math.pow(1.0001, tickUpper));
    const liq = Number(liquidity);
    let amount0 = 0, amount1 = 0;
    if (tickCurrent < tickLower) { amount0 = liq * (1 / sqrtPriceLower - 1 / sqrtPriceUpper); }
    else if (tickCurrent >= tickUpper) { amount1 = liq * (sqrtPriceUpper - sqrtPriceLower); }
    else { amount0 = liq * (1 / sqrtPriceCurrent - 1 / sqrtPriceUpper); amount1 = liq * (sqrtPriceCurrent - sqrtPriceLower); }
    return [BigInt(Math.floor(amount0)), BigInt(Math.floor(amount1))];
  }
}
