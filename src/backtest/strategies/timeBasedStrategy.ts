import { IRebalanceStrategy, TickData, BacktestConfig } from '../types';

/**
 * Rebalance at fixed time intervals, regardless of delta mismatch.
 * Only triggers if there is actually a non-zero difference to correct.
 */
export class TimeBasedStrategy implements IRebalanceStrategy {
  constructor(private intervalSeconds: number) {}

  shouldRebalance(
    tick: TickData,
    currentHedgeSize: number,
    targetSize: number,
    lastRebalanceTimestamp: number,
    config: BacktestConfig,
  ): boolean {
    if (targetSize === 0 && currentHedgeSize === 0) return false;

    const elapsed = (tick.timestamp - lastRebalanceTimestamp) / 1000;
    if (elapsed < this.intervalSeconds) return false;

    // Only rebalance if there is a meaningful difference
    const deltaUsd = Math.abs(targetSize - currentHedgeSize) * tick.price;
    return deltaUsd >= config.minRebalanceUsd;
  }
}
