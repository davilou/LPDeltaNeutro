import { HedgeState } from '../types';

export interface FillResult {
  action: 'SELL' | 'BUY-REDUCE' | 'CLOSE';
  sz: number;
  avgPx: number;
}

export interface IHedgeExchange {
  getPosition(symbol: string): Promise<HedgeState>;
  setPosition(symbol: string, size: number, notionalUsd: number): Promise<FillResult | null>;
  closePosition(symbol: string): Promise<FillResult | null>;
  getFundingRate(symbol: string): Promise<number>;
  getAccountEquity(): Promise<number>;
}
