import { IRebalanceStrategy, TickData, BacktestConfig } from '../types';

/**
 * Hybrid: só rebalanceia se o intervalo mínimo de tempo passou
 * E o mismatch de delta superar o threshold configurado.
 * Modela o comportamento observado: bot parado overnight + threshold de delta.
 */
export class HybridStrategy implements IRebalanceStrategy {
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

    const reference = targetSize > 0 ? targetSize : currentHedgeSize;
    const mismatch = Math.abs(targetSize - currentHedgeSize) / reference;
    if (mismatch <= config.deltaMismatchThreshold) return false;

    const deltaUsd = Math.abs(targetSize - currentHedgeSize) * tick.price;
    return deltaUsd >= config.minRebalanceUsd;
  }
}
