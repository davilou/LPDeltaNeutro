import { ethers } from 'ethers';
import { DiscoveredPosition } from '../../types';
import { logger } from '../../utils/logger';
import { ChainId, DexId, IWalletScanner, PositionId } from '../types';
import { getChainDexAddresses, ChainDexAddresses } from '../chainRegistry';
import { getChainProvider } from '../chainProviders';
import { getTokenCache, KNOWN_TOKENS_BY_CHAIN, seedTokenCache, TokenMeta } from '../tokenCache';
import { NonRetryableError } from '../../utils/fallbackProvider';

const POSITION_MANAGER_V3_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
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

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

export class EvmScanner implements IWalletScanner {
  private readonly chain: ChainId;
  private readonly dex: DexId;

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
      const pos = await getChainProvider(this.chain).call(async (provider) => {
        const pm = new ethers.Contract(addresses.positionManagerV3!, POSITION_MANAGER_V3_ABI, provider);
        return pm.positions(tokenId);
      });

      if (BigInt(pos.liquidity) === 0n) return null;

      const t0Addr = pos.token0.toLowerCase();
      const t1Addr = pos.token1.toLowerCase();
      const fee = Number(pos.fee);

      const { t0, t1, poolAddr, tickCurrent } = await getChainProvider(this.chain).call(async (provider) => {
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
    const fallback = getChainProvider(this.chain);

    const balance: bigint = await fallback.call(async (p) => {
      const pm = new ethers.Contract(addresses.positionManagerV3!, POSITION_MANAGER_V3_ABI, p);
      return pm.balanceOf(walletAddress);
    });
    const count = Number(balance);
    if (count === 0) return [];

    logger.info(`[EvmScanner][${this.chain}:${this.dex}] ${walletAddress} owns ${count} NFTs`);

    const tokenIds: bigint[] = [];
    const indexChunks = chunk(Array.from({ length: count }, (_, i) => i), 5);
    for (const batch of indexChunks) {
      const results = await Promise.allSettled(
        batch.map(i => fallback.call(async (p) => {
          const pm = new ethers.Contract(addresses.positionManagerV3!, POSITION_MANAGER_V3_ABI, p);
          return pm.tokenOfOwnerByIndex(walletAddress, i);
        }))
      );
      for (const r of results) {
        if (r.status === 'fulfilled') tokenIds.push(r.value as bigint);
        else logger.warn(`[EvmScanner] tokenOfOwnerByIndex failed: ${r.reason}`);
      }
      await new Promise(r => setTimeout(r, 100));
    }

    const discovered: DiscoveredPosition[] = [];
    for (const batch of chunk(tokenIds, 2)) {
      const posResults = await Promise.allSettled(
        batch.map(id => fallback.call(async (p) => {
          const pm = new ethers.Contract(addresses.positionManagerV3!, POSITION_MANAGER_V3_ABI, p);
          return pm.positions(id);
        }))
      );

      for (let i = 0; i < batch.length; i++) {
        const tokenId = Number(batch[i]);
        const r = posResults[i];
        if (r.status === 'rejected') { logger.warn(`[EvmScanner] NFT #${tokenId}: positions() failed`); continue; }
        const pos = r.value;
        if (BigInt(pos.liquidity) === 0n) continue;

        const t0Addr = pos.token0.toLowerCase();
        const t1Addr = pos.token1.toLowerCase();
        const fee = Number(pos.fee);

        try {
          const { t0, t1, poolAddr, tickCurrent } = await fallback.call(async (provider) => {
            const [t0Info, t1Info] = await Promise.all([
              this.getTokenInfo(provider, t0Addr),
              this.getTokenInfo(provider, t1Addr),
            ]);
            const addr = await this.resolvePoolAddress(provider, addresses, pos.token0, pos.token1, fee);
            const pool = new ethers.Contract(addr, POOL_V3_ABI, provider);
            const slot0 = await pool.slot0();
            return { t0: t0Info, t1: t1Info, poolAddr: addr, tickCurrent: Number(slot0.tick) };
          });

          const dp = this.buildDiscoveredPosition(
            tokenId, pos.token0, t0, pos.token1, t1, fee,
            Number(pos.tickLower), Number(pos.tickUpper), tickCurrent,
            BigInt(pos.liquidity), poolAddr,
          );
          if (dp.estimatedUsd >= 10 || dp.estimatedUsd === 0) discovered.push(dp);
        } catch (err) {
          logger.info(`[EvmScanner] NFT #${tokenId}: skipped (${err})`);
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }

    return discovered;
  }

  private async resolvePoolAddress(
    provider: ethers.Provider,
    addresses: ChainDexAddresses,
    token0: string,
    token1: string,
    fee: number,
  ): Promise<string> {
    if (addresses.factoryV3) {
      try {
        const factory = new ethers.Contract(addresses.factoryV3, FACTORY_V3_ABI, provider);
        const addr: string = await factory.getPool(token0, token1, fee);
        if (addr !== ethers.ZeroAddress) return addr;
      } catch (err) {
        logger.debug(`[EvmScanner] factory.getPool(${token0}, ${token1}, ${fee}) failed: ${err}`);
        /* fall through to CREATE2 */
      }
    }

    if (addresses.initCodeHashV3 && addresses.factoryV3) {
      const [tA, tB] = token0.toLowerCase() < token1.toLowerCase() ? [token0, token1] : [token1, token0];
      const salt = ethers.solidityPackedKeccak256(['address', 'address', 'uint24'], [tA, tB, fee]);
      return ethers.getCreate2Address(addresses.factoryV3, salt, addresses.initCodeHashV3);
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
