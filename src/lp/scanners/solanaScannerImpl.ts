// src/lp/scanners/solanaScannerImpl.ts
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  buildWhirlpoolClient,
  WhirlpoolContext,
  PDAUtil,
  PriceMath,
  PoolUtil,
  IGNORE_CACHE,
} from '@orca-so/whirlpools-sdk';
import { AnchorProvider } from '@coral-xyz/anchor';
import {
  PositionInfoLayout,
  PoolInfoLayout,
  SqrtPriceMath,
  LiquidityMath,
} from '@raydium-io/raydium-sdk-v2';
import DLMM from '@meteora-ag/dlmm';
import type { DiscoveredPosition } from '../../types';
import type { IWalletScanner, DexId, PositionId } from '../types';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'BUSD', 'DAI']);

// Raydium CLMM program ID (mainnet)
const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');

export class SolanaScannerImpl implements IWalletScanner {
  private readonly dex: DexId;
  private readonly connection: Connection;

  constructor(dex: DexId) {
    this.dex = dex;
    this.connection = new Connection(config.solanaHttpRpcUrl, 'confirmed');
  }

  async scanWallet(address: string): Promise<DiscoveredPosition[]> {
    const walletPK = new PublicKey(address);
    if (this.dex === 'orca')    return this.scanOrca(walletPK);
    if (this.dex === 'raydium') return this.scanRaydium(walletPK);
    if (this.dex === 'meteora') return this.scanMeteora(walletPK);
    return [];
  }

  async lookupById(_id: PositionId): Promise<DiscoveredPosition | null> {
    logger.warn(`[SolanaScannerImpl] lookupById not supported for Solana (use scanWallet). id=${_id}`);
    return null;
  }

  // ---------------------------------------------------------------------------
  // Orca Whirlpool scan
  // ---------------------------------------------------------------------------
  private async scanOrca(walletPK: PublicKey): Promise<DiscoveredPosition[]> {
    const dummyKp = Keypair.generate();
    const dummyWallet = {
      publicKey: dummyKp.publicKey,
      signTransaction: async <T>(tx: T): Promise<T> => tx,
      signAllTransactions: async <T>(txs: T[]): Promise<T[]> => txs,
    };
    const provider = new AnchorProvider(this.connection, dummyWallet as any, { commitment: 'confirmed' });
    const ctx = WhirlpoolContext.withProvider(provider);
    const client = buildWhirlpoolClient(ctx);

    const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(walletPK, {
      programId: TOKEN_PROGRAM_ID,
    });
    const nftMints = tokenAccounts.value
      .filter(a => {
        const info = a.account.data.parsed.info.tokenAmount;
        return info.uiAmount === 1 && info.decimals === 0;
      })
      .map(a => new PublicKey(a.account.data.parsed.info.mint as string));

    logger.info(`[SolanaScannerImpl][orca] ${walletPK.toBase58()} — ${nftMints.length} NFTs to check`);

    const positions: DiscoveredPosition[] = [];
    for (const mint of nftMints) {
      try {
        const positionPDA = PDAUtil.getPosition(ctx.program.programId, mint);
        const positionData = await ctx.fetcher.getPosition(positionPDA.publicKey, IGNORE_CACHE);
        if (!positionData) continue;

        const pool = await client.getPool(positionData.whirlpool, IGNORE_CACHE);
        const poolData = pool.getData();
        const [mintInfoA, mintInfoB] = await Promise.all([
          ctx.fetcher.getMintInfo(poolData.tokenMintA, IGNORE_CACHE),
          ctx.fetcher.getMintInfo(poolData.tokenMintB, IGNORE_CACHE),
        ]);
        const decimalsA = mintInfoA?.decimals ?? 6;
        const decimalsB = mintInfoB?.decimals ?? 6;

        const amounts = PoolUtil.getTokenAmountsFromLiquidity(
          positionData.liquidity,
          poolData.sqrtPrice,
          PriceMath.tickIndexToSqrtPriceX64(positionData.tickLowerIndex),
          PriceMath.tickIndexToSqrtPriceX64(positionData.tickUpperIndex),
          false,
        );

        const tickCurrent = poolData.tickCurrentIndex;
        const decimalAdj  = decimalsA - decimalsB;
        const price = Math.pow(1.0001, tickCurrent) * Math.pow(10, decimalAdj);
        const t0Amount = Number(amounts.tokenA.toString()) / Math.pow(10, decimalsA);
        const t1Amount = Number(amounts.tokenB.toString()) / Math.pow(10, decimalsB);
        const rangeStatus = this.calcRangeStatus(tickCurrent, positionData.tickLowerIndex, positionData.tickUpperIndex);
        const estimatedUsd = this.estimateUsd(t0Amount, t1Amount, price, 'TOKEN_A', 'TOKEN_B');

        positions.push({
          tokenId: positionPDA.publicKey.toBase58(),
          protocolVersion: 'v3',
          token0Address: poolData.tokenMintA.toBase58(),
          token0Symbol: 'TOKEN_A',
          token0Decimals: decimalsA,
          token1Address: poolData.tokenMintB.toBase58(),
          token1Symbol: 'TOKEN_B',
          token1Decimals: decimalsB,
          fee: poolData.feeRate,
          tickLower: positionData.tickLowerIndex,
          tickUpper: positionData.tickUpperIndex,
          tickCurrent,
          liquidity: positionData.liquidity.toString(),
          poolAddress: positionData.whirlpool.toBase58(),
          rangeStatus,
          token0AmountFormatted: t0Amount,
          token1AmountFormatted: t1Amount,
          price,
          estimatedUsd,
          chain: 'solana',
          dex: 'orca',
        });
      } catch {
        // Not an Orca position or unreadable — skip silently
      }
    }

    logger.info(`[SolanaScannerImpl][orca] found ${positions.length} active positions`);
    return positions;
  }

  // ---------------------------------------------------------------------------
  // Raydium CLMM scan
  // ---------------------------------------------------------------------------
  private async scanRaydium(walletPK: PublicKey): Promise<DiscoveredPosition[]> {
    const accounts = await this.connection.getProgramAccounts(RAYDIUM_CLMM_PROGRAM_ID, {
      filters: [{ dataSize: PositionInfoLayout.span }],
    });

    const positions: DiscoveredPosition[] = [];
    for (const { pubkey, account } of accounts) {
      try {
        const posData = PositionInfoLayout.decode(account.data);

        // Skip empty/zero accounts
        if (posData.nftMint.toBase58() === '11111111111111111111111111111111') continue;

        // Skip zero-liquidity positions
        if (posData.liquidity.isZero()) continue;

        // Verify wallet owns the NFT mint token account
        const tokenAccounts = await this.connection.getTokenAccountsByOwner(walletPK, {
          mint: posData.nftMint,
        });
        if (tokenAccounts.value.length === 0) continue;

        const poolAccount = await this.connection.getAccountInfo(posData.poolId);
        if (!poolAccount) continue;
        const poolData = PoolInfoLayout.decode(poolAccount.data);

        const sqrtLower = SqrtPriceMath.getSqrtPriceX64FromTick(posData.tickLower);
        const sqrtUpper = SqrtPriceMath.getSqrtPriceX64FromTick(posData.tickUpper);
        const { amountA, amountB } = LiquidityMath.getAmountsFromLiquidity(
          poolData.sqrtPriceX64,
          sqrtLower,
          sqrtUpper,
          posData.liquidity,
          false,
        );

        const decimalsA = poolData.mintDecimalsA;
        const decimalsB = poolData.mintDecimalsB;
        const tickCurrent = poolData.tickCurrent;
        const decimalAdj = decimalsA - decimalsB;
        const price = Math.pow(1.0001, tickCurrent) * Math.pow(10, decimalAdj);
        const t0Amount = Number(amountA.toString()) / Math.pow(10, decimalsA);
        const t1Amount = Number(amountB.toString()) / Math.pow(10, decimalsB);
        const rangeStatus = this.calcRangeStatus(tickCurrent, posData.tickLower, posData.tickUpper);
        const estimatedUsd = this.estimateUsd(t0Amount, t1Amount, price, 'TOKEN_A', 'TOKEN_B');

        positions.push({
          tokenId: pubkey.toBase58(),
          protocolVersion: 'v3',
          token0Address: poolData.mintA.toBase58(),
          token0Symbol: 'TOKEN_A',
          token0Decimals: decimalsA,
          token1Address: poolData.mintB.toBase58(),
          token1Symbol: 'TOKEN_B',
          token1Decimals: decimalsB,
          fee: 0,
          tickLower: posData.tickLower,
          tickUpper: posData.tickUpper,
          tickCurrent,
          liquidity: posData.liquidity.toString(),
          poolAddress: posData.poolId.toBase58(),
          rangeStatus,
          token0AmountFormatted: t0Amount,
          token1AmountFormatted: t1Amount,
          price,
          estimatedUsd,
          chain: 'solana',
          dex: 'raydium',
        });
      } catch (err) {
        logger.warn(`[SolanaScannerImpl][raydium] skipping account ${pubkey.toBase58()}: ${err}`);
      }
    }

    logger.info(`[SolanaScannerImpl][raydium] found ${positions.length} active positions`);
    return positions;
  }

  // ---------------------------------------------------------------------------
  // Meteora DLMM scan
  // ---------------------------------------------------------------------------
  private async scanMeteora(walletPK: PublicKey): Promise<DiscoveredPosition[]> {
    const allPairs = await DLMM.getAllLbPairPositionsByUser(this.connection, walletPK);
    const positions: DiscoveredPosition[] = [];

    for (const [pairAddr, positionInfo] of allPairs) {
      const { lbPair, tokenX, tokenY, lbPairPositionsData } = positionInfo;

      const binStep  = (lbPair as any).binStep as number;
      const activeId = (lbPair as any).activeId as number;
      const decimalsX = tokenX.mint.decimals;
      const decimalsY = tokenY.mint.decimals;
      const tokenXAddr = tokenX.publicKey.toBase58();
      const tokenYAddr = tokenY.publicKey.toBase58();

      for (const posEntry of lbPairPositionsData) {
        try {
          const posData  = posEntry.positionData;
          const lowerBin = posData.lowerBinId;
          const upperBin = posData.upperBinId;
          const priceRaw = Math.pow(1 + binStep / 10_000, activeId);
          const price    = priceRaw * Math.pow(10, decimalsX - decimalsY);
          const t0Amount = parseFloat(String(posData.totalXAmount));
          const t1Amount = parseFloat(String(posData.totalYAmount));
          const rangeStatus = this.calcRangeStatus(activeId, lowerBin, upperBin);
          const estimatedUsd = this.estimateUsd(t0Amount, t1Amount, price, 'TOKEN_X', 'TOKEN_Y');

          positions.push({
            tokenId: posEntry.publicKey.toBase58(),
            protocolVersion: 'v3',
            token0Address: tokenXAddr,
            token0Symbol: 'TOKEN_X',
            token0Decimals: decimalsX,
            token1Address: tokenYAddr,
            token1Symbol: 'TOKEN_Y',
            token1Decimals: decimalsY,
            fee: binStep,
            tickLower: lowerBin,
            tickUpper: upperBin,
            tickCurrent: activeId,
            liquidity: '0',
            poolAddress: pairAddr,
            rangeStatus,
            token0AmountFormatted: t0Amount,
            token1AmountFormatted: t1Amount,
            price,
            estimatedUsd,
            chain: 'solana',
            dex: 'meteora',
          });
        } catch (err) {
          logger.warn(`[SolanaScannerImpl][meteora] skipping position: ${err}`);
        }
      }
    }

    logger.info(`[SolanaScannerImpl][meteora] found ${positions.length} active positions`);
    return positions;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  private calcRangeStatus(current: number, lower: number, upper: number): DiscoveredPosition['rangeStatus'] {
    if (current < lower)  return 'below-range';
    if (current >= upper) return 'above-range';
    return 'in-range';
  }

  private estimateUsd(t0Amount: number, t1Amount: number, price: number, t0Symbol: string, t1Symbol: string): number {
    if (STABLE_SYMBOLS.has(t0Symbol)) return t0Amount + t1Amount * (1 / price);
    if (STABLE_SYMBOLS.has(t1Symbol)) return t0Amount * price + t1Amount;
    return 0;
  }
}
