import { IRebalanceStrategy, TickData, BacktestConfig } from '../types';

/**
 * Replica of the live bot's checkNeedsRebalance logic:
 * triggers when relative delta mismatch exceeds threshold AND
 * the USD value meets the minimum.
 */
export class ThresholdStrategy implements IRebalanceStrategy {
  shouldRebalance(
    tick: TickData,
    currentHedgeSize: number,
    targetSize: number,
    _lastRebalanceTimestamp: number,
    config: BacktestConfig,
  ): boolean {
    if (targetSize === 0 && currentHedgeSize === 0) return false;

    const reference = targetSize > 0 ? targetSize : currentHedgeSize;
    const mismatch = Math.abs(targetSize - currentHedgeSize) / reference;

    if (mismatch > config.deltaMismatchThreshold) {
      const deltaUsd = Math.abs(targetSize - currentHedgeSize) * tick.price;
      return deltaUsd >= config.minRebalanceUsd;
    }

    return false;
  }
}
