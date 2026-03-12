// src/lp/readers/raydium/raydiumReader.ts
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import {
  PoolInfoLayout,
  PositionInfoLayout,
  TickArrayLayout,
  LiquidityMath,
  SqrtPriceMath,
  PositionUtils,
  TickUtils,
  TICK_ARRAY_SIZE,
} from '@raydium-io/raydium-sdk-v2';
import type { LPPosition } from '../../../types';
import type { ILPReader, PositionId } from '../../types';
import { SolanaBaseReader } from '../solanaBaseReader';
import { logger } from '../../../utils/logger';

// Raydium CLMM program ID (mainnet)
const CLMM_PROGRAM_ID = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');

/** Derive the PDA for a tick array using the SDK's own method. */
function getTickArrayPda(poolId: PublicKey, tickIndex: number, tickSpacing: number): PublicKey {
  return TickUtils.getTickArrayAddressByTick(CLMM_PROGRAM_ID, poolId, tickIndex, tickSpacing);
}

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
    const tickSpacing = poolData.tickSpacing;

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
    const priceDecimal = SqrtPriceMath.sqrtPriceX64ToPrice(sqrtPriceCurrent, decimalsA, decimalsB);
    const price = priceDecimal.toNumber();

    const rangeStatus: LPPosition['rangeStatus'] =
      tickCurrent < tickLower ? 'below-range'
      : tickCurrent >= tickUpper ? 'above-range'
      : 'in-range';

    // Resolve token symbols (Metaplex → DexScreener → fallback)
    const [symbolA, symbolB] = await Promise.all([
      this.resolveTokenSymbol(poolData.mintA),
      this.resolveTokenSymbol(poolData.mintB),
    ]);
    logger.debug(`[RaydiumReader] ${symbolA}/${symbolB} position ${key}`);

    // Compute uncollected fees via tick array data + PositionUtils.GetPositionFeesV2
    let feesA = Number((posData.tokenFeesOwedA as unknown as BN).toString()) / Math.pow(10, decimalsA);
    let feesB = Number((posData.tokenFeesOwedB as unknown as BN).toString()) / Math.pow(10, decimalsB);

    try {
      const lowerTickArrayPda = getTickArrayPda(poolPubkey, tickLower, tickSpacing);
      const upperTickArrayPda = getTickArrayPda(poolPubkey, tickUpper, tickSpacing);

      const [lowerTickArrayInfo, upperTickArrayInfo] = await Promise.all([
        this.connection.getAccountInfo(lowerTickArrayPda),
        this.connection.getAccountInfo(upperTickArrayPda),
      ]);

      if (lowerTickArrayInfo && upperTickArrayInfo) {
        const lowerTickArray = TickArrayLayout.decode(lowerTickArrayInfo.data);
        const upperTickArray = TickArrayLayout.decode(upperTickArrayInfo.data);

        // Extract the specific tick from the array
        const lowerOffset = TickUtils.getTickOffsetInArray(tickLower, tickSpacing);
        const upperOffset = TickUtils.getTickOffsetInArray(tickUpper, tickSpacing);
        const tickLowerState = lowerTickArray.ticks[lowerOffset];
        const tickUpperState = upperTickArray.ticks[upperOffset];

        if (tickLowerState && tickUpperState) {
          const fees = PositionUtils.GetPositionFeesV2(
            {
              tickCurrent: poolData.tickCurrent,
              feeGrowthGlobalX64A: poolData.feeGrowthGlobalX64A as unknown as BN,
              feeGrowthGlobalX64B: poolData.feeGrowthGlobalX64B as unknown as BN,
            },
            posData,
            tickLowerState,
            tickUpperState,
          );

          feesA = Number(fees.tokenFeeAmountA.toString()) / Math.pow(10, decimalsA);
          feesB = Number(fees.tokenFeeAmountB.toString()) / Math.pow(10, decimalsB);
          logger.debug(`[RaydiumReader] Fees (with uncollected): A=${feesA.toFixed(6)} B=${feesB.toFixed(6)}`);
        } else {
          logger.warn(`[RaydiumReader] Tick offset out of bounds — using checkpointed fees only`);
        }
      } else {
        logger.warn(`[RaydiumReader] Could not fetch tick arrays for fee calculation — using checkpointed fees only`);
      }
    } catch (err) {
      logger.warn(`[RaydiumReader] Fee calculation error, using checkpointed fees: ${err}`);
    }

    const result: LPPosition = {
      token0: {
        address: poolData.mintA.toBase58(),
        symbol: symbolA,
        decimals: decimalsA,
        amount: BigInt(amountA.toString()),
        amountFormatted: Number(amountA.toString()) / Math.pow(10, decimalsA),
      },
      token1: {
        address: poolData.mintB.toBase58(),
        symbol: symbolB,
        decimals: decimalsB,
        amount: BigInt(amountB.toString()),
        amountFormatted: Number(amountB.toString()) / Math.pow(10, decimalsB),
      },
      price,
      rangeStatus,
      tickLower,
      tickUpper,
      tickCurrent,
      tokensOwed0: feesA,
      tokensOwed1: feesB,
      liquidity: BigInt(liquidity.toString()),
    };

    this.setCache(key, result);
    logger.debug(`[RaydiumReader] readPosition ${key} price=${price.toFixed(6)} status=${rangeStatus}`);
    return result;
  }
}
