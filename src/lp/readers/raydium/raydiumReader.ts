// src/lp/readers/raydium/raydiumReader.ts
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import {
  PoolInfoLayout,
  PositionInfoLayout,
  LiquidityMath,
  SqrtPriceMath,
} from '@raydium-io/raydium-sdk-v2';
import type { LPPosition } from '../../../types';
import type { ILPReader, PositionId } from '../../types';
import { SolanaBaseReader } from '../solanaBaseReader';
import { logger } from '../../../utils/logger';

// Raydium CLMM program ID (mainnet)
const CLMM_PROGRAM_ID = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');

export class RaydiumReader extends SolanaBaseReader implements ILPReader {
  async readPosition(id: PositionId, poolAddress: string): Promise<LPPosition> {
    const key = String(id);
    const cached = this.getCached<LPPosition>(key);
    if (cached) return cached;

    // Fetch position account — id is the personal position pubkey (NFT mint address
    // converted via getPdaPersonalPositionAddress, or the personal position PDA directly)
    const positionPubkey = new PublicKey(key);
    const positionAccountInfo = await this.connection.getAccountInfo(positionPubkey);
    if (!positionAccountInfo) {
      throw new Error(`[RaydiumReader] position account not found: ${key}`);
    }

    const posData = PositionInfoLayout.decode(positionAccountInfo.data);

    // Resolve pool: prefer explicit poolAddress arg, fall back to posData.poolId
    const poolPubkey = poolAddress
      ? new PublicKey(poolAddress)
      : posData.poolId;

    const poolAccountInfo = await this.connection.getAccountInfo(poolPubkey);
    if (!poolAccountInfo) {
      throw new Error(`[RaydiumReader] pool account not found: ${poolPubkey.toBase58()}`);
    }

    const poolData = PoolInfoLayout.decode(poolAccountInfo.data);

    // Verify that the pool program is the expected CLMM program
    if (!poolAccountInfo.owner.equals(CLMM_PROGRAM_ID)) {
      logger.warn(`[RaydiumReader] unexpected pool owner ${poolAccountInfo.owner.toBase58()} for pool ${poolPubkey.toBase58()}`);
    }

    const decimalsA = poolData.mintDecimalsA;
    const decimalsB = poolData.mintDecimalsB;
    const tickCurrent = poolData.tickCurrent;
    const tickLower = posData.tickLower;
    const tickUpper = posData.tickUpper;
    const liquidity = posData.liquidity as unknown as BN;

    // Compute current amounts from liquidity
    const sqrtPriceCurrent = poolData.sqrtPriceX64 as unknown as BN;
    const sqrtPriceLower = SqrtPriceMath.getSqrtPriceX64FromTick(tickLower);
    const sqrtPriceUpper = SqrtPriceMath.getSqrtPriceX64FromTick(tickUpper);

    const { amountA, amountB } = LiquidityMath.getAmountsFromLiquidity(
      sqrtPriceCurrent,
      sqrtPriceLower,
      sqrtPriceUpper,
      liquidity,
      false, // round down
    );

    // Price: tokenB per tokenA in human-readable units
    // sqrtPriceX64ToPrice returns a Decimal
    const priceDecimal = SqrtPriceMath.sqrtPriceX64ToPrice(sqrtPriceCurrent, decimalsA, decimalsB);
    const price = priceDecimal.toNumber();

    const rangeStatus: LPPosition['rangeStatus'] =
      tickCurrent < tickLower ? 'below-range'
      : tickCurrent >= tickUpper ? 'above-range'
      : 'in-range';

    const tokensOwedA = posData.tokenFeesOwedA as unknown as BN;
    const tokensOwedB = posData.tokenFeesOwedB as unknown as BN;

    const result: LPPosition = {
      token0: {
        address: poolData.mintA.toBase58(),
        symbol: 'TOKEN_A',
        decimals: decimalsA,
        amount: BigInt(amountA.toString()),
        amountFormatted: Number(amountA.toString()) / Math.pow(10, decimalsA),
      },
      token1: {
        address: poolData.mintB.toBase58(),
        symbol: 'TOKEN_B',
        decimals: decimalsB,
        amount: BigInt(amountB.toString()),
        amountFormatted: Number(amountB.toString()) / Math.pow(10, decimalsB),
      },
      price,
      rangeStatus,
      tickLower,
      tickUpper,
      tickCurrent,
      tokensOwed0: Number(tokensOwedA.toString()) / Math.pow(10, decimalsA),
      tokensOwed1: Number(tokensOwedB.toString()) / Math.pow(10, decimalsB),
      liquidity: BigInt(liquidity.toString()),
    };

    this.setCache(key, result);
    logger.debug(`[RaydiumReader] readPosition ${key} price=${price.toFixed(6)} status=${rangeStatus}`);
    return result;
  }
}
