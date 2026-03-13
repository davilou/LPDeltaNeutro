// src/lp/scanners/solanaScannerImpl.ts
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
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
  ClmmConfigLayout,
  SqrtPriceMath,
  LiquidityMath,
} from '@raydium-io/raydium-sdk-v2';
import DLMM from '@meteora-ag/dlmm';
import type { DiscoveredPosition } from '../../types';
import type { IWalletScanner, DexId, PositionId } from '../types';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { SolanaBaseReader } from '../readers/solanaBaseReader';

const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'BUSD', 'DAI']);

// Raydium CLMM program (mainnet). Seed for PersonalPosition PDA: ["position", nftMint]
const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');

// Meteora DLMM program (mainnet)
const METEORA_DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

/**
 * Concrete subclass of SolanaBaseReader used only for symbol resolution in the scanner.
 * readPosition is not needed here — the scanner only discovers positions, doesn't read them.
 */
class SolanaSymbolResolver extends SolanaBaseReader {
  // Public accessor so SolanaScannerImpl can call resolveTokenSymbol
  async resolve(mint: PublicKey): Promise<string> {
    return this.resolveTokenSymbol(mint);
  }
}

export class SolanaScannerImpl implements IWalletScanner {
  private readonly dex: DexId;
  private readonly connection: Connection;
  private readonly symbolResolver: SolanaSymbolResolver;

  constructor(dex: DexId) {
    this.dex = dex;
    this.connection = new Connection(config.lpFreeSolRpcUrl ?? config.solanaHttpRpcUrl, 'confirmed');
    this.symbolResolver = new SolanaSymbolResolver();
  }

  async scanWallet(address: string): Promise<DiscoveredPosition[]> {
    const walletPK = new PublicKey(address);
    if (this.dex === 'orca')    return this.scanOrca(walletPK);
    if (this.dex === 'raydium') return this.scanRaydium(walletPK);
    if (this.dex === 'meteora') return this.scanMeteora(walletPK);
    return [];
  }

  async lookupById(id: PositionId): Promise<DiscoveredPosition | null> {
    const pubkeyStr = String(id);
    logger.info(`[SolanaScannerImpl][${this.dex}] lookupById: ${pubkeyStr}`);

    try {
      if (this.dex === 'orca')    return await this.lookupOrca(pubkeyStr);
      if (this.dex === 'raydium') return await this.lookupRaydium(pubkeyStr);
      if (this.dex === 'meteora') return await this.lookupMeteora(pubkeyStr);
      logger.warn(`[SolanaScannerImpl] lookupById not supported for dex=${this.dex}`);
      return null;
    } catch (err) {
      logger.error(`[SolanaScannerImpl][${this.dex}] lookupById failed for ${pubkeyStr}: ${err}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Orca — lookup by position PDA pubkey
  // ---------------------------------------------------------------------------
  private async lookupOrca(positionKey: string): Promise<DiscoveredPosition | null> {
    const positionPubkey = new PublicKey(positionKey);

    const dummyKp = Keypair.generate();
    const dummyWallet = {
      publicKey: dummyKp.publicKey,
      signTransaction: async <T>(tx: T): Promise<T> => tx,
      signAllTransactions: async <T>(txs: T[]): Promise<T[]> => txs,
    };
    const provider = new AnchorProvider(this.connection, dummyWallet as any, { commitment: 'confirmed' });
    const ctx = WhirlpoolContext.withProvider(provider);
    const client = buildWhirlpoolClient(ctx);

    // Try 1: input is the position PDA directly
    let resolvedPubkey = positionPubkey;
    let position;
    try {
      position = await client.getPosition(positionPubkey, IGNORE_CACHE);
    } catch {
      // Try 2: input is the NFT mint → derive position PDA
      const derivedPDA = PDAUtil.getPosition(ctx.program.programId, positionPubkey);
      logger.info(`[SolanaScannerImpl][orca] input ${positionKey} not a position PDA, trying as NFT mint → PDA ${derivedPDA.publicKey.toBase58()}`);
      resolvedPubkey = derivedPDA.publicKey;
      position = await client.getPosition(resolvedPubkey, IGNORE_CACHE);
    }

    const posData = position.getData();

    if (posData.liquidity.isZero()) {
      logger.info(`[SolanaScannerImpl][orca] position ${resolvedPubkey.toBase58()} has zero liquidity`);
      return null;
    }

    const pool = await client.getPool(posData.whirlpool, IGNORE_CACHE);
    const poolData = pool.getData();
    const [mintInfoA, mintInfoB] = await Promise.all([
      ctx.fetcher.getMintInfo(poolData.tokenMintA, IGNORE_CACHE),
      ctx.fetcher.getMintInfo(poolData.tokenMintB, IGNORE_CACHE),
    ]);
    const decimalsA = mintInfoA?.decimals ?? 6;
    const decimalsB = mintInfoB?.decimals ?? 6;

    const [symA, symB] = await Promise.all([
      this.symbolResolver.resolve(poolData.tokenMintA),
      this.symbolResolver.resolve(poolData.tokenMintB),
    ]);

    const amounts = PoolUtil.getTokenAmountsFromLiquidity(
      posData.liquidity,
      poolData.sqrtPrice,
      PriceMath.tickIndexToSqrtPriceX64(posData.tickLowerIndex),
      PriceMath.tickIndexToSqrtPriceX64(posData.tickUpperIndex),
      false,
    );

    const tickCurrent = poolData.tickCurrentIndex;
    const decimalAdj  = decimalsA - decimalsB;
    const price = Math.pow(1.0001, tickCurrent) * Math.pow(10, decimalAdj);
    const t0Amount = Number(amounts.tokenA.toString()) / Math.pow(10, decimalsA);
    const t1Amount = Number(amounts.tokenB.toString()) / Math.pow(10, decimalsB);
    const rangeStatus = this.calcRangeStatus(tickCurrent, posData.tickLowerIndex, posData.tickUpperIndex);
    const estimatedUsd = this.estimateUsd(t0Amount, t1Amount, price, symA, symB);

    logger.info(`[SolanaScannerImpl][orca] lookupById found: ${symA}/${symB} PDA=${resolvedPubkey.toBase58()} status=${rangeStatus} usd=${estimatedUsd.toFixed(2)}`);

    return {
      tokenId: resolvedPubkey.toBase58(),
      protocolVersion: 'v3',
      token0Address: poolData.tokenMintA.toBase58(),
      token0Symbol: symA,
      token0Decimals: decimalsA,
      token1Address: poolData.tokenMintB.toBase58(),
      token1Symbol: symB,
      token1Decimals: decimalsB,
      fee: poolData.feeRate,
      tickLower: posData.tickLowerIndex,
      tickUpper: posData.tickUpperIndex,
      tickCurrent,
      liquidity: posData.liquidity.toString(),
      poolAddress: posData.whirlpool.toBase58(),
      rangeStatus,
      token0AmountFormatted: t0Amount,
      token1AmountFormatted: t1Amount,
      price,
      estimatedUsd,
      chain: 'solana',
      dex: 'orca',
    };
  }

  // ---------------------------------------------------------------------------
  // Raydium — lookup by PersonalPosition PDA pubkey
  // ---------------------------------------------------------------------------
  private async lookupRaydium(positionKey: string): Promise<DiscoveredPosition | null> {
    const inputPubkey = new PublicKey(positionKey);

    // Try 1: input is the PersonalPosition PDA directly
    let positionPubkey = inputPubkey;
    let accountInfo = await this.connection.getAccountInfo(positionPubkey);

    // If account exists but is not owned by Raydium CLMM, it's likely the NFT mint
    const isRaydiumOwned = accountInfo && accountInfo.owner.equals(RAYDIUM_CLMM_PROGRAM_ID);

    if (!accountInfo || !isRaydiumOwned) {
      // Try 2: input is the NFT mint → derive PersonalPosition PDA
      const [derivedPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('position'), inputPubkey.toBuffer()],
        RAYDIUM_CLMM_PROGRAM_ID,
      );
      logger.info(`[SolanaScannerImpl][raydium] input ${positionKey} not a position PDA, trying as NFT mint → PDA ${derivedPDA.toBase58()}`);
      positionPubkey = derivedPDA;
      accountInfo = await this.connection.getAccountInfo(positionPubkey);

      if (!accountInfo) {
        logger.info(`[SolanaScannerImpl][raydium] position not found for input ${positionKey} (neither as PDA nor NFT mint)`);
        return null;
      }
    }

    const posData = PositionInfoLayout.decode(accountInfo.data);
    if (posData.liquidity.isZero()) {
      logger.info(`[SolanaScannerImpl][raydium] position ${positionPubkey.toBase58()} has zero liquidity`);
      return null;
    }

    const poolAccount = await this.connection.getAccountInfo(posData.poolId);
    if (!poolAccount) {
      logger.warn(`[SolanaScannerImpl][raydium] pool account not found for position ${positionPubkey.toBase58()}`);
      return null;
    }
    const poolData = PoolInfoLayout.decode(poolAccount.data);

    // Read fee rate from AmmConfig account
    let fee = 0;
    try {
      const configAccount = await this.connection.getAccountInfo(poolData.ammConfig);
      if (configAccount) {
        const configData = ClmmConfigLayout.decode(configAccount.data);
        fee = configData.tradeFeeRate as number;
      }
    } catch { /* fee stays 0 */ }

    const [symA, symB] = await Promise.all([
      this.symbolResolver.resolve(poolData.mintA),
      this.symbolResolver.resolve(poolData.mintB),
    ]);

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
    const estimatedUsd = this.estimateUsd(t0Amount, t1Amount, price, symA, symB);

    logger.info(`[SolanaScannerImpl][raydium] lookupById found: ${symA}/${symB} PDA=${positionPubkey.toBase58()} status=${rangeStatus} usd=${estimatedUsd.toFixed(2)}`);

    return {
      tokenId: positionPubkey.toBase58(),
      protocolVersion: 'v3',
      token0Address: poolData.mintA.toBase58(),
      token0Symbol: symA,
      token0Decimals: decimalsA,
      token1Address: poolData.mintB.toBase58(),
      token1Symbol: symB,
      token1Decimals: decimalsB,
      fee,
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
    };
  }

  // ---------------------------------------------------------------------------
  // Meteora — lookup by position pubkey (extract lbPair from raw account data)
  // ---------------------------------------------------------------------------
  private async lookupMeteora(positionKey: string): Promise<DiscoveredPosition | null> {
    const positionPubkey = new PublicKey(positionKey);

    // Read raw account to extract lbPair pubkey (offset 8 after 8-byte Anchor discriminator)
    const rawAccount = await this.connection.getAccountInfo(positionPubkey);
    if (!rawAccount) {
      logger.info(`[SolanaScannerImpl][meteora] position account not found: ${positionKey}`);
      return null;
    }

    // Validate owner is Meteora DLMM program
    if (!rawAccount.owner.equals(METEORA_DLMM_PROGRAM_ID)) {
      logger.warn(`[SolanaScannerImpl][meteora] account ${positionKey} owner=${rawAccount.owner.toBase58()} is not Meteora DLMM — not a valid position`);
      return null;
    }

    const lbPairPubkey = new PublicKey(rawAccount.data.subarray(8, 40));
    logger.debug(`[SolanaScannerImpl][meteora] position ${positionKey} → lbPair=${lbPairPubkey.toBase58()}`);

    const dlmm = await DLMM.create(this.connection, lbPairPubkey);
    const lbPairState = dlmm.lbPair;
    const activeId = lbPairState.activeId as number;
    const binStep  = lbPairState.binStep as number;
    const decimalsX = dlmm.tokenX.mint.decimals;
    const decimalsY = dlmm.tokenY.mint.decimals;

    const lbPos = await dlmm.getPosition(positionPubkey);
    const posData = lbPos.positionData;

    const lowerBinId = posData.lowerBinId;
    const upperBinId = posData.upperBinId;
    const t0Amount = parseFloat(String(posData.totalXAmount));
    const t1Amount = parseFloat(String(posData.totalYAmount));

    // Zero liquidity check: if both amounts are zero, position is closed
    if (t0Amount === 0 && t1Amount === 0) {
      logger.info(`[SolanaScannerImpl][meteora] position ${positionKey} has zero amounts`);
      return null;
    }

    const [symX, symY] = await Promise.all([
      this.symbolResolver.resolve(dlmm.tokenX.publicKey),
      this.symbolResolver.resolve(dlmm.tokenY.publicKey),
    ]);

    const priceRaw = Math.pow(1 + binStep / 10_000, activeId);
    const price    = priceRaw * Math.pow(10, decimalsX - decimalsY);
    const rangeStatus = this.calcRangeStatus(activeId, lowerBinId, upperBinId);
    const estimatedUsd = this.estimateUsd(t0Amount, t1Amount, price, symX, symY);

    logger.info(`[SolanaScannerImpl][meteora] lookupById found: ${symX}/${symY} status=${rangeStatus} usd=${estimatedUsd.toFixed(2)}`);

    return {
      tokenId: positionKey,
      protocolVersion: 'v3',
      token0Address: dlmm.tokenX.publicKey.toBase58(),
      token0Symbol: symX,
      token0Decimals: decimalsX,
      token1Address: dlmm.tokenY.publicKey.toBase58(),
      token1Symbol: symY,
      token1Decimals: decimalsY,
      fee: binStep,
      tickLower: lowerBinId,
      tickUpper: upperBinId,
      tickCurrent: activeId,
      liquidity: '0',
      poolAddress: lbPairPubkey.toBase58(),
      rangeStatus,
      token0AmountFormatted: t0Amount,
      token1AmountFormatted: t1Amount,
      price,
      estimatedUsd,
      chain: 'solana',
      dex: 'meteora',
    };
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

    const [ta1, ta2] = await Promise.all([
      this.connection.getParsedTokenAccountsByOwner(walletPK, { programId: TOKEN_PROGRAM_ID }),
      this.connection.getParsedTokenAccountsByOwner(walletPK, { programId: TOKEN_2022_PROGRAM_ID }),
    ]);
    const nftMints = [...ta1.value, ...ta2.value]
      .filter(a => {
        const ta = a.account.data.parsed.info.tokenAmount;
        return (ta.amount === '1' || ta.uiAmount === 1) && ta.decimals === 0;
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

        const [symA, symB] = await Promise.all([
          this.symbolResolver.resolve(poolData.tokenMintA),
          this.symbolResolver.resolve(poolData.tokenMintB),
        ]);

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
        const estimatedUsd = this.estimateUsd(t0Amount, t1Amount, price, symA, symB);

        positions.push({
          tokenId: positionPDA.publicKey.toBase58(),
          protocolVersion: 'v3',
          token0Address: poolData.tokenMintA.toBase58(),
          token0Symbol: symA,
          token0Decimals: decimalsA,
          token1Address: poolData.tokenMintB.toBase58(),
          token1Symbol: symB,
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
    // Get wallet NFTs from both SPL token programs (Raydium CLMM uses Token-2022 for position NFTs)
    const [ta1, ta2] = await Promise.all([
      this.connection.getParsedTokenAccountsByOwner(walletPK, { programId: TOKEN_PROGRAM_ID }),
      this.connection.getParsedTokenAccountsByOwner(walletPK, { programId: TOKEN_2022_PROGRAM_ID }),
    ]);
    const nftMints = [...ta1.value, ...ta2.value]
      .filter(a => {
        const ta = a.account.data.parsed.info.tokenAmount;
        return (ta.amount === '1' || ta.uiAmount === 1) && ta.decimals === 0;
      })
      .map(a => new PublicKey(a.account.data.parsed.info.mint as string));

    logger.info(`[SolanaScannerImpl][raydium] ${walletPK.toBase58()} — ${nftMints.length} NFTs to check`);

    const positions: DiscoveredPosition[] = [];
    for (const nftMint of nftMints) {
      try {
        // PersonalPosition PDA: seeds=["position", nftMint], program=Raydium CLMM
        const [positionPDA] = PublicKey.findProgramAddressSync(
          [Buffer.from('position'), nftMint.toBuffer()],
          RAYDIUM_CLMM_PROGRAM_ID,
        );
        const accountInfo = await this.connection.getAccountInfo(positionPDA);
        if (!accountInfo) continue;

        const posData = PositionInfoLayout.decode(accountInfo.data);
        if (posData.liquidity.isZero()) continue;

        const poolAccount = await this.connection.getAccountInfo(posData.poolId);
        if (!poolAccount) continue;
        const poolData = PoolInfoLayout.decode(poolAccount.data);

        // Read fee rate from AmmConfig account
        let fee = 0;
        try {
          const configAccount = await this.connection.getAccountInfo(poolData.ammConfig);
          if (configAccount) {
            const configData = ClmmConfigLayout.decode(configAccount.data);
            fee = configData.tradeFeeRate as number;
          }
        } catch { /* fee stays 0 */ }

        const [symA, symB] = await Promise.all([
          this.symbolResolver.resolve(poolData.mintA),
          this.symbolResolver.resolve(poolData.mintB),
        ]);

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
        const estimatedUsd = this.estimateUsd(t0Amount, t1Amount, price, symA, symB);

        positions.push({
          tokenId: positionPDA.toBase58(),
          protocolVersion: 'v3',
          token0Address: poolData.mintA.toBase58(),
          token0Symbol: symA,
          token0Decimals: decimalsA,
          token1Address: poolData.mintB.toBase58(),
          token1Symbol: symB,
          token1Decimals: decimalsB,
          fee,
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
        logger.warn(`[SolanaScannerImpl][raydium] skipping account ${nftMint.toBase58()}: ${err}`);
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

      const [symX, symY] = await Promise.all([
        this.symbolResolver.resolve(tokenX.publicKey),
        this.symbolResolver.resolve(tokenY.publicKey),
      ]);

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
          const estimatedUsd = this.estimateUsd(t0Amount, t1Amount, price, symX, symY);

          positions.push({
            tokenId: posEntry.publicKey.toBase58(),
            protocolVersion: 'v3',
            token0Address: tokenX.publicKey.toBase58(),
            token0Symbol: symX,
            token0Decimals: decimalsX,
            token1Address: tokenY.publicKey.toBase58(),
            token1Symbol: symY,
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
