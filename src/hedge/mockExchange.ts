import { HedgeState } from '../types';
import { FillResult, IHedgeExchange } from './types';
import { logger } from '../utils/logger';

export class MockExchange implements IHedgeExchange {
  private positions: Map<string, HedgeState> = new Map();
  private mockAvgEntryPrices: Map<string, number> = new Map();
  private mockFundingRate: number;

  constructor(mockFundingRate: number = 0.01) {
    this.mockFundingRate = mockFundingRate;
    logger.info(`MockExchange initialized (funding=${(mockFundingRate * 100).toFixed(2)}%)`);
  }

  async getAccountEquity(): Promise<number> {
    let total = 100; // base mock equity
    for (const pos of this.positions.values()) {
      total += pos.notionalUsd;
    }
    logger.info(`[MOCK] Account equity: $${total.toFixed(2)}`);
    return total;
  }

  async getPosition(symbol: string): Promise<HedgeState> {
    const pos = this.positions.get(symbol);
    if (!pos) {
      return { symbol, size: 0, notionalUsd: 0, side: 'none' };
    }
    return { ...pos, avgEntryPrice: this.mockAvgEntryPrices.get(symbol) };
  }

  async setPosition(symbol: string, size: number, notionalUsd: number): Promise<FillResult | null> {
    const current = await this.getPosition(symbol);
    const delta = size - current.size;
    const action: FillResult['action'] = delta > 0 ? 'SELL' : 'BUY-REDUCE';
    const fillPx = size > 0 ? notionalUsd / size : 0;

    // Update weighted average entry price
    if (delta > 0 && current.size > 0 && current.avgEntryPrice) {
      const newAvg = (current.size * current.avgEntryPrice + delta * fillPx) / size;
      this.mockAvgEntryPrices.set(symbol, newAvg);
    } else if (delta > 0) {
      this.mockAvgEntryPrices.set(symbol, fillPx);
    }
    // On reduce, avgEntryPrice stays the same

    const state: HedgeState = {
      symbol,
      size,
      notionalUsd,
      side: size > 0 ? 'short' : 'none',
    };
    this.positions.set(symbol, state);
    logger.info(
      `[MOCK] Set position: ${symbol} size=${size.toFixed(4)} notional=$${notionalUsd.toFixed(2)} side=${state.side}`
    );
    return { action, sz: Math.abs(delta), avgPx: fillPx };
  }

  async closePosition(symbol: string): Promise<FillResult | null> {
    const current = await this.getPosition(symbol);
    const avgPx = current.size > 0 ? current.notionalUsd / current.size : 0;
    this.positions.delete(symbol);
    this.mockAvgEntryPrices.delete(symbol);
    logger.info(`[MOCK] Closed position: ${symbol}`);
    return { action: 'CLOSE', sz: current.size, avgPx };
  }

  async getFundingRate(symbol: string): Promise<number> {
    logger.info(`[MOCK] Funding rate for ${symbol}: ${(this.mockFundingRate * 100).toFixed(2)}%`);
    return this.mockFundingRate;
  }

  setMockFundingRate(rate: number): void {
    this.mockFundingRate = rate;
    logger.info(`[MOCK] Funding rate updated to ${(rate * 100).toFixed(2)}%`);
  }
}
