import { config } from '../config';
import { LPPosition } from '../types';
import { logger } from '../utils/logger';

export interface HedgeTarget {
  size: number;
  notionalUsd: number;
  hedgeRatio: number;
}

export function calculateHedge(
  position: LPPosition,
  fundingRate: number
): HedgeTarget {
  const hedgeToken = config.hedgeToken;
  const tokenInfo = hedgeToken === 'token0' ? position.token0 : position.token1;
  const exposure = tokenInfo.amountFormatted;

  // Compute price of hedge token in USD (quote currency)
  // If hedging token0, notional = exposure * price (price is token0 in token1 terms)
  // If hedging token1, notional = exposure (token1 is already quote)
  let priceInQuote: number;
  if (hedgeToken === 'token0') {
    priceInQuote = position.price;
  } else {
    priceInQuote = 1 / position.price;
  }

  const notional = exposure * priceInQuote;

  // Determine hedge ratio based on range status and funding
  let hedgeRatio: number;

  if (hedgeToken === 'token0') {
    if (position.rangeStatus === 'above-range') {
      // token0 is 0% of LP (all token1) → no hedge needed
      hedgeRatio = 0;
    } else if (position.rangeStatus === 'below-range') {
      // token0 is 100% of LP → full hedge
      hedgeRatio = 1.0;
    } else {
      hedgeRatio = computeInRangeRatio(fundingRate);
    }
  } else {
    // hedging token1
    if (position.rangeStatus === 'below-range') {
      // token1 is 0% of LP (all token0) → no hedge needed
      hedgeRatio = 0;
    } else if (position.rangeStatus === 'above-range') {
      // token1 is 100% of LP → full hedge
      hedgeRatio = 1.0;
    } else {
      hedgeRatio = computeInRangeRatio(fundingRate);
    }
  }

  // Apply floor
  if (hedgeRatio > 0) {
    hedgeRatio = Math.max(hedgeRatio, config.hedgeFloor);
  }

  const targetSize = exposure * hedgeRatio;
  const targetNotional = notional * hedgeRatio;

  logger.info(
    `Hedge calc: exposure=${exposure.toFixed(4)} ${tokenInfo.symbol}, ` +
    `funding=${(fundingRate * 100).toFixed(2)}%, ratio=${hedgeRatio.toFixed(2)}, ` +
    `targetSize=${targetSize.toFixed(4)}, notional=$${targetNotional.toFixed(2)}`
  );

  return {
    size: targetSize,
    notionalUsd: targetNotional,
    hedgeRatio,
  };
}

function computeInRangeRatio(fundingRate: number): number {
  if (fundingRate >= 0) {
    return 1.0;
  } else if (fundingRate >= -0.20) {
    return 0.98;
  } else {
    return 0.90;
  }
}
