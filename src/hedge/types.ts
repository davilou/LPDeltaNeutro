import { HedgeState } from '../types';

export interface FillResult {
  action: 'SELL' | 'BUY-REDUCE' | 'CLOSE';
  sz: number;
  avgPx: number;
}

export interface HlIsolatedPnl {
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  cumulativeFundingUsd: number;
  cumulativeFeesUsd: number;
}

export interface IHedgeExchange {
  getPosition(symbol: string): Promise<HedgeState>;
  setPosition(symbol: string, size: number, notionalUsd: number): Promise<FillResult | null>;
  closePosition(symbol: string): Promise<FillResult | null>;
  getFundingRate(symbol: string): Promise<number>;
  getAccountEquity(): Promise<number>;
  getIsolatedPnl(symbol: string, sinceTimestamp: number): Promise<HlIsolatedPnl>;
  isSymbolSupported(symbol: string): Promise<boolean>;
  /** Resolve a base symbol (e.g. "AMZN") to the full HL coin name including dex prefix if needed (e.g. "xyz:AMZN"). Returns null if not found in any dex. */
  resolveSymbol(symbol: string): Promise<string | null>;
  /** Returns current mid/mark price for a coin. Returns 0 if unavailable (e.g. mock). */
  getMarkPrice(coin: string): Promise<number>;
}
