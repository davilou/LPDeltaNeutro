import { IRebalanceStrategy, TickData, BacktestConfig } from '../types';

/**
 * Rebalance when the absolute USD delta exceeds a fixed band.
 */
export class BandStrategy implements IRebalanceStrategy {
  constructor(private bandUsd: number) {}

  shouldRebalance(
    tick: TickData,
    currentHedgeSize: number,
    targetSize: number,
    _lastRebalanceTimestamp: number,
    _config: BacktestConfig,
  ): boolean {
    if (targetSize === 0 && currentHedgeSize === 0) return false;

    const deltaUsd = Math.abs(targetSize - currentHedgeSize) * tick.price;
    return deltaUsd >= this.bandUsd;
  }
}
