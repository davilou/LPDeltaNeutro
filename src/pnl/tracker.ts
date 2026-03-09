import { PnlState, PnlSnapshot } from '../types';
import { HlIsolatedPnl } from '../hedge/types';
import { config } from '../config';
import { logger } from '../utils/logger';

export class PnlTracker {
  private state: PnlState | null;

  constructor(savedState?: PnlState) {
    // Priority: 1. savedState (existing position), 2. config (new position default)
    const initialLpUsd = savedState?.initialLpUsd ?? config.initialLpUsd;
    const initialHlUsd = savedState?.initialHlUsd ?? config.initialHlUsd;

    if (initialLpUsd === undefined || initialHlUsd === undefined) {
      this.state = null;
      logger.warn('PnlTracker partially disabled: initial balances not available');
      return;
    }

    this.state = {
      initialLpUsd,
      initialHlUsd,
      initialLpFeesUsd: savedState?.initialLpFeesUsd ?? 0,
      initialTimestamp: savedState?.initialTimestamp ?? Date.now(),
    };

    logger.info(
      `PnlTracker initialized: initial LP=$${this.state.initialLpUsd.toFixed(2)} HL=$${this.state.initialHlUsd.toFixed(2)} ` +
      `total=$${(this.state.initialLpUsd + this.state.initialHlUsd).toFixed(2)}`
    );
  }

  get isInitialized(): boolean {
    return this.state !== null;
  }

  reinitialize(initialLpUsd: number, initialHlUsd: number, initialLpFeesUsd: number = 0): void {
    this.state = {
      initialLpUsd,
      initialHlUsd,
      initialLpFeesUsd,
      initialTimestamp: Date.now(),
    };
    logger.info(
      `[PnlTracker] Reinitialized: LP=$${initialLpUsd.toFixed(2)} HL=$${initialHlUsd.toFixed(2)} fees_base=$${initialLpFeesUsd.toFixed(2)} ` +
      `total=$${(initialLpUsd + initialHlUsd).toFixed(2)}`
    );
  }

  compute(currentLpUsd: number, currentHlEquity: number, lpFeesUsd: number, hlPnl: HlIsolatedPnl): PnlSnapshot {
    if (!this.state) {
      return {
        initialTotalUsd: 0,
        currentTotalUsd: 0,
        lpFeesUsd: 0,
        cumulativeFundingUsd: 0,
        cumulativeHlFeesUsd: 0,
        accountPnlUsd: 0,
        accountPnlPercent: 0,
        virtualPnlUsd: 0,
        virtualPnlPercent: 0,
        unrealizedVirtualPnlUsd: 0,
        realizedVirtualPnlUsd: 0,
        lpPnlUsd: 0,
      };
    }

    // Account-wide PnL
    const initialTotal = this.state.initialLpUsd + this.state.initialHlUsd;
    const currentTotal = currentLpUsd + currentHlEquity;
    const accountPnl = currentTotal - initialTotal;
    const accountPnlPercent = initialTotal > 0 ? (accountPnl / initialTotal) * 100 : 0;

    // Isolated PnL (from HL API)
    const netLpFees = Math.max(0, lpFeesUsd - (this.state.initialLpFeesUsd || 0));
    const lpPnl = currentLpUsd - this.state.initialLpUsd;
    const virtualPnl = lpPnl + hlPnl.realizedPnlUsd + hlPnl.unrealizedPnlUsd + hlPnl.cumulativeFundingUsd - hlPnl.cumulativeFeesUsd;
    const virtualPnlPercent = this.state.initialLpUsd > 0 ? (virtualPnl / this.state.initialLpUsd) * 100 : 0;

    return {
      initialTotalUsd: initialTotal,
      currentTotalUsd: currentTotal,
      lpFeesUsd: netLpFees,
      cumulativeFundingUsd: hlPnl.cumulativeFundingUsd,
      cumulativeHlFeesUsd: hlPnl.cumulativeFeesUsd,
      accountPnlUsd: accountPnl,
      accountPnlPercent,
      virtualPnlUsd: virtualPnl,
      virtualPnlPercent,
      unrealizedVirtualPnlUsd: hlPnl.unrealizedPnlUsd,
      realizedVirtualPnlUsd: hlPnl.realizedPnlUsd,
      lpPnlUsd: lpPnl,
    };
  }

  /**
   * Adjusts the P&L baseline when the user adds or removes liquidity.
   * deltaLpUsd = currentLpUsd(newLiquidity) - currentLpUsd(oldLiquidity) at the same price.
   * Negative = withdrawal (reduce baseline so P&L doesn't show artificial loss).
   * Positive = deposit   (increase baseline so P&L doesn't show artificial gain).
   */
  adjustBaseline(deltaLpUsd: number): void {
    if (!this.state) return;
    this.state.initialLpUsd += deltaLpUsd;
  }

  getStateForPersist(): PnlState | undefined {
    return this.state ?? undefined;
  }
}
