// src/lp/readers/meteora/meteoraReader.ts
import { PublicKey } from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';
import type { LPPosition } from '../../../types';
import type { ILPReader, PositionId } from '../../types';
import { SolanaBaseReader } from '../solanaBaseReader';
import { logger } from '../../../utils/logger';

export class MeteoraReader extends SolanaBaseReader implements ILPReader {
  async readPosition(id: PositionId, poolAddress: string): Promise<LPPosition> {
    const key = String(id);
    const cached = this.getCached<LPPosition>(key);
    if (cached) return cached;

    const dlmm = await DLMM.create(this.connection, new PublicKey(poolAddress));
    const lbPairState = dlmm.lbPair;

    const activeId = lbPairState.activeId as number;
    const binStep  = lbPairState.binStep as number;

    // Fetch position directly via SDK — avoids raw account decode
    const lbPos = await dlmm.getPosition(new PublicKey(key));
    const posData = lbPos.positionData;

    const lowerBinId = posData.lowerBinId;
    const upperBinId = posData.upperBinId;

    const decimalsX = dlmm.tokenX.mint.decimals;
    const decimalsY = dlmm.tokenY.mint.decimals;

    // Meteora bin price formula: price = (1 + binStep/10_000)^activeId adjusted for decimals
    const priceRaw = Math.pow(1 + binStep / 10_000, activeId);
    const price    = priceRaw * Math.pow(10, decimalsX - decimalsY);

    const rangeStatus: LPPosition['rangeStatus'] =
      activeId < lowerBinId ? 'below-range'
      : activeId > upperBinId ? 'above-range'
      : 'in-range';

    // totalXAmount / totalYAmount are human-readable strings from the SDK
    const totalX = parseFloat(posData.totalXAmount);
    const totalY = parseFloat(posData.totalYAmount);

    const result: LPPosition = {
      token0: {
        address:         dlmm.tokenX.publicKey.toBase58(),
        symbol:          'TOKEN_X',
        decimals:        decimalsX,
        amount:          BigInt(Math.round(totalX * Math.pow(10, decimalsX))),
        amountFormatted: totalX,
      },
      token1: {
        address:         dlmm.tokenY.publicKey.toBase58(),
        symbol:          'TOKEN_Y',
        decimals:        decimalsY,
        amount:          BigInt(Math.round(totalY * Math.pow(10, decimalsY))),
        amountFormatted: totalY,
      },
      price,
      rangeStatus,
      tickLower:   lowerBinId,
      tickUpper:   upperBinId,
      tickCurrent: activeId,
      tokensOwed0: 0,
      tokensOwed1: 0,
      liquidity:   0n,
    };

    this.setCache(key, result);
    logger.debug(`[MeteoraReader] readPosition ${key} price=${price.toFixed(6)} status=${rangeStatus}`);
    return result;
  }
}
