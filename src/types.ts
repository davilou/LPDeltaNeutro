export interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
  amount: bigint;
  amountFormatted: number;
}

export interface LPPosition {
  token0: TokenInfo;
  token1: TokenInfo;
  price: number;
  rangeStatus: 'in-range' | 'above-range' | 'below-range';
  tickLower: number;
  tickUpper: number;
  tickCurrent: number;
  tokensOwed0: number;
  tokensOwed1: number;
}

export interface HedgeState {
  symbol: string;
  size: number;
  notionalUsd: number;
  side: 'short' | 'none';
}

export interface PnlState {
  initialLpUsd: number;
  initialHlUsd: number;
  initialLpFeesUsd?: number;
  initialTimestamp: number;
  cumulativeFundingUsd: number;
  cumulativeHlFeesUsd: number;
  lastFundingTimestamp: number;
  // Virtual accounting for multi-position tracking on single HL account
  virtualSize?: number;
  avgEntryPrice?: number;
  realizedPnlUsd?: number;
  virtualPnlUsd?: number;
}

export interface PnlSnapshot {
  initialTotalUsd: number;
  currentTotalUsd: number;
  lpFeesUsd: number;
  cumulativeFundingUsd: number;
  cumulativeHlFeesUsd: number;
  // Account-wide PnL (Legacy/Comparison)
  accountPnlUsd: number;
  accountPnlPercent: number;
  // Virtual PnL (isolated to this NFT)
  virtualPnlUsd: number;
  virtualPnlPercent: number;
  unrealizedVirtualPnlUsd: number;
  realizedVirtualPnlUsd: number;
  virtualSize: number;
  avgEntryPrice: number;
}

export interface DiscoveredPosition {
  tokenId: number;
  protocolVersion: 'v3' | 'v4';
  token0Address: string;
  token0Symbol: string;
  token0Decimals: number;
  token1Address: string;
  token1Symbol: string;
  token1Decimals: number;
  fee: number;
  tickLower: number;
  tickUpper: number;
  tickCurrent: number;
  liquidity: string;
  poolAddress: string;
  rangeStatus: 'in-range' | 'above-range' | 'below-range';
  token0AmountFormatted: number;
  token1AmountFormatted: number;
  price: number;
  estimatedUsd: number;
}

export interface ActivePositionConfig {
  tokenId: number;
  protocolVersion: 'v3' | 'v4';
  poolAddress: string;
  activatedAt: number;
  hedgeSymbol: string;
  hedgeToken: 'token0' | 'token1';
  protectionType?: string; // 'delta-neutral'
  hedgeRatio?: number; // 0.8 to protect 80%
  emergencyPriceMovementThreshold?: number; // % de movimento de preço para emergency (bypassa cooldown)
}

export interface PositionState {
  lastHedge: HedgeState;
  lastPrice: number;
  lastRebalancePrice: number; // preço no momento do último rebalance (referência para price movement trigger)
  lastRebalanceTimestamp: number;
  dailyRebalanceCount: number;
  dailyResetDate: string;
  pnl?: PnlState;
  config: ActivePositionConfig;
  rebalances?: any[]; // Store history in state
}

export interface BotState {
  positions: Record<number, PositionState>;
}
