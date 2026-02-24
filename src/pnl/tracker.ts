import { PnlState, PnlSnapshot } from '../types';
import { config } from '../config';
import { logger } from '../utils/logger';

export class PnlTracker {
  private state: PnlState | null;

  constructor(savedState?: PnlState) {
    const hasEnv = config.initialLpUsd !== undefined && config.initialHlUsd !== undefined;

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
      cumulativeFundingUsd: savedState?.cumulativeFundingUsd ?? 0,
      cumulativeHlFeesUsd: savedState?.cumulativeHlFeesUsd ?? 0,
      lastFundingTimestamp: savedState?.lastFundingTimestamp ?? Date.now(),
      virtualSize: savedState?.virtualSize ?? 0,
      avgEntryPrice: savedState?.avgEntryPrice ?? 0,
      realizedPnlUsd: savedState?.realizedPnlUsd ?? 0,
    };

    logger.info(
      `PnlTracker initialized: initial LP=$${this.state.initialLpUsd.toFixed(2)} HL=$${this.state.initialHlUsd.toFixed(2)} ` +
      `total=$${(this.state.initialLpUsd + this.state.initialHlUsd).toFixed(2)} (from .env)`
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
      cumulativeFundingUsd: 0,
      cumulativeHlFeesUsd: 0,
      lastFundingTimestamp: Date.now(),
      virtualSize: 0,
      avgEntryPrice: 0,
      realizedPnlUsd: 0,
    };
    logger.info(
      `[PnlTracker] Reinitialized: LP=$${initialLpUsd.toFixed(2)} HL=$${initialHlUsd.toFixed(2)} fees_base=$${initialLpFeesUsd.toFixed(2)} ` +
      `total=$${(initialLpUsd + initialHlUsd).toFixed(2)}`
    );
  }

  accumulateFunding(fundingRate: number, hedgeNotionalUsd: number): void {
    if (!this.state) return;

    const now = Date.now();
    const hoursSinceLast = (now - this.state.lastFundingTimestamp) / (1000 * 60 * 60);

    const fundingUsd = fundingRate * hedgeNotionalUsd * hoursSinceLast;
    this.state.cumulativeFundingUsd += fundingUsd;
    this.state.lastFundingTimestamp = now;
  }

  recordTradeFee(orderNotionalUsd: number): void {
    if (!this.state) return;

    const fee = Math.abs(orderNotionalUsd) * config.hlTakerFee;
    this.state.cumulativeHlFeesUsd += fee;

    logger.info(`[PnL] Trade fee: $${fee.toFixed(4)} (notional $${Math.abs(orderNotionalUsd).toFixed(2)})`);
  }

  /**
   * Updates virtual accounting when a trade occurs.
   * Logic: 
   * - If increasing position: weighted average price update.
   * - If decreasing position: realize PnL comparing exit price to avg entry price.
   */
  recordTrade(sizeChange: number, price: number): void {
    if (!this.state) return;
    const s = this.state;

    const currentSize = s.virtualSize || 0;
    const avgPrice = s.avgEntryPrice || 0;
    const newSize = currentSize + sizeChange;

    // Determine if we are increasing or decreasing/closing
    // We assume short positions here (bot always shorts)
    const isIncrease = (currentSize >= 0 && sizeChange > 0);
    const isDecrease = (currentSize > 0 && sizeChange < 0);

    if (isIncrease) {
      // Ponderated average: (S1*P1 + S2*P2) / (S1+S2)
      s.avgEntryPrice = (currentSize * avgPrice + sizeChange * price) / newSize;
    } else if (isDecrease) {
      // Realize PnL on the closed portion
      // Since it's a short: Profit = (EntryPrice - ExitPrice) * ClosedSize
      const closedSize = Math.min(currentSize, Math.abs(sizeChange));
      const pnlOnClose = (avgPrice - price) * closedSize;

      s.realizedPnlUsd = (s.realizedPnlUsd || 0) + pnlOnClose;

      // If closing more than current size (shouldn't happen with our bot logic), 
      // the remaining size starts at the new price
      if (newSize < 0) {
        s.avgEntryPrice = price;
      }
    } else if (currentSize === 0) {
      s.avgEntryPrice = price;
    }

    s.virtualSize = Math.max(0, newSize);

    logger.info(
      `[Virtual Accounting] size: ${currentSize.toFixed(4)} -> ${(s.virtualSize || 0).toFixed(4)} | ` +
      `avgPrice: ${avgPrice.toFixed(6)} -> ${(s.avgEntryPrice || 0).toFixed(6)} | ` +
      `realized: $${(s.realizedPnlUsd || 0).toFixed(4)}`
    );
  }

  compute(currentLpUsd: number, currentHlEquity: number, lpFeesUsd: number, currentMarketPrice: number): PnlSnapshot {
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
        virtualSize: 0,
        avgEntryPrice: 0,
      };
    }

    // 1. Account-wide PnL (Legacy)
    const initialTotal = this.state.initialLpUsd + this.state.initialHlUsd;
    const currentTotal = currentLpUsd + currentHlEquity;
    const accountPnl = currentTotal - initialTotal;
    const accountPnlPercent = initialTotal > 0 ? (accountPnl / initialTotal) * 100 : 0;

    // 2. Virtual Accounting PnL (Isolated)
    const netLpFees = Math.max(0, lpFeesUsd - (this.state.initialLpFeesUsd || 0));

    // Unrealized PnL: (EntryPrice - MarketPrice) * Size (for Short)
    const virtualSize = this.state.virtualSize || 0;
    const avgPrice = this.state.avgEntryPrice || 0;
    const unrealizedVirtualPnl = (avgPrice - currentMarketPrice) * virtualSize;
    const realizedVirtualPnl = this.state.realizedPnlUsd || 0;

    // LP Component PnL (from initial LP value)
    const lpPnl = currentLpUsd - this.state.initialLpUsd;

    // Total Virtual PnL = LP PnL + Hedge PnL (Realized + Unrealized) + Funding - HL Fees
    const virtualPnl = lpPnl + realizedVirtualPnl + unrealizedVirtualPnl + this.state.cumulativeFundingUsd - this.state.cumulativeHlFeesUsd;
    const virtualPnlPercent = this.state.initialLpUsd > 0 ? (virtualPnl / this.state.initialLpUsd) * 100 : 0;

    // Update state for persistence
    this.state.virtualPnlUsd = virtualPnl;

    return {
      initialTotalUsd: initialTotal,
      currentTotalUsd: currentTotal,
      lpFeesUsd: netLpFees,
      cumulativeFundingUsd: this.state.cumulativeFundingUsd,
      cumulativeHlFeesUsd: this.state.cumulativeHlFeesUsd,
      accountPnlUsd: accountPnl,
      accountPnlPercent,
      virtualPnlUsd: virtualPnl,
      virtualPnlPercent,
      unrealizedVirtualPnlUsd: unrealizedVirtualPnl,
      realizedVirtualPnlUsd: realizedVirtualPnl,
      virtualSize,
      avgEntryPrice: avgPrice
    };
  }

  getVirtualState(): { size: number; avgPrice: number } {
    return {
      size: this.state?.virtualSize ?? 0,
      avgPrice: this.state?.avgEntryPrice ?? 0,
    };
  }

  reinitializeVirtualPrice(price: number): void {
    if (this.state) {
      this.state.avgEntryPrice = price;
    }
  }

  getStateForPersist(): PnlState | undefined {
    return this.state ?? undefined;
  }
}
