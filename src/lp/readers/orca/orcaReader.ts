// src/lp/readers/orca/orcaReader.ts
import { PublicKey, Keypair } from '@solana/web3.js';
import {
  buildWhirlpoolClient,
  IGNORE_CACHE,
  PoolUtil,
  PriceMath,
  WhirlpoolContext,
} from '@orca-so/whirlpools-sdk';
import { AnchorProvider } from '@coral-xyz/anchor';
import type { LPPosition } from '../../../types';
import type { ILPReader, PositionId } from '../../types';
import { SolanaBaseReader } from '../solanaBaseReader';
import { logger } from '../../../utils/logger';

export class OrcaReader extends SolanaBaseReader implements ILPReader {
  async readPosition(id: PositionId, _poolAddress: string): Promise<LPPosition> {
    const key = String(id);
    const cached = this.getCached<LPPosition>(key);
    if (cached) return cached;

    const positionPubkey = new PublicKey(key);

    // Dummy read-only wallet — no signing needed for data reads
    const dummyKp = Keypair.generate();
    const dummyWallet = {
      publicKey: dummyKp.publicKey,
      signTransaction: async <T>(tx: T): Promise<T> => tx,
      signAllTransactions: async <T>(txs: T[]): Promise<T[]> => txs,
    };

    const provider = new AnchorProvider(this.connection, dummyWallet as any, { commitment: 'confirmed' });
    const ctx = WhirlpoolContext.withProvider(provider);
    const client = buildWhirlpoolClient(ctx);

    const position = await client.getPosition(positionPubkey, IGNORE_CACHE);
    const posData = position.getData();
    const pool = await client.getPool(posData.whirlpool, IGNORE_CACHE);
    const poolData = pool.getData();

    const [mintInfoA, mintInfoB] = await Promise.all([
      ctx.fetcher.getMintInfo(poolData.tokenMintA, IGNORE_CACHE),
      ctx.fetcher.getMintInfo(poolData.tokenMintB, IGNORE_CACHE),
    ]);
    const decimalsA = mintInfoA?.decimals ?? 6;
    const decimalsB = mintInfoB?.decimals ?? 6;

    const amounts = PoolUtil.getTokenAmountsFromLiquidity(
      posData.liquidity,
      poolData.sqrtPrice,
      PriceMath.tickIndexToSqrtPriceX64(posData.tickLowerIndex),
      PriceMath.tickIndexToSqrtPriceX64(posData.tickUpperIndex),
      false,
    );

    const tickCurrent = poolData.tickCurrentIndex;
    const tickLower = posData.tickLowerIndex;
    const tickUpper = posData.tickUpperIndex;
    // Whirlpool price: 1.0001^tick * 10^(decimalsA - decimalsB) gives tokenB-per-tokenA in native units
    const decimalAdj = decimalsA - decimalsB;
    const price = Math.pow(1.0001, tickCurrent) * Math.pow(10, decimalAdj);

    const rangeStatus: LPPosition['rangeStatus'] =
      tickCurrent < tickLower ? 'below-range'
      : tickCurrent >= tickUpper ? 'above-range'
      : 'in-range';

    const result: LPPosition = {
      token0: {
        address: poolData.tokenMintA.toBase58(),
        symbol: 'TOKEN_A',
        decimals: decimalsA,
        amount: BigInt(amounts.tokenA.toString()),
        amountFormatted: Number(amounts.tokenA.toString()) / Math.pow(10, decimalsA),
      },
      token1: {
        address: poolData.tokenMintB.toBase58(),
        symbol: 'TOKEN_B',
        decimals: decimalsB,
        amount: BigInt(amounts.tokenB.toString()),
        amountFormatted: Number(amounts.tokenB.toString()) / Math.pow(10, decimalsB),
      },
      price,
      rangeStatus,
      tickLower,
      tickUpper,
      tickCurrent,
      tokensOwed0: Number(posData.feeOwedA.toString()) / Math.pow(10, decimalsA),
      tokensOwed1: Number(posData.feeOwedB.toString()) / Math.pow(10, decimalsB),
      liquidity: BigInt(posData.liquidity.toString()),
    };

    this.setCache(key, result);
    logger.debug(`[OrcaReader] readPosition ${key} price=${price.toFixed(6)} status=${rangeStatus}`);
    return result;
  }
}
