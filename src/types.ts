import type { ChainId, DexId, PositionId } from './lp/types';
export type { ChainId, DexId, PositionId };

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
  liquidity: bigint;
}

export interface HedgeState {
  symbol: string;
  size: number;
  notionalUsd: number;
  side: 'short' | 'none';
  avgEntryPrice?: number; // weighted average entry price from HL (entryPx)
  unrealizedPnlUsd?: number; // unrealized PnL from HL clearinghouse
}

export interface PnlState {
  initialLpUsd: number;
  initialHlUsd: number;
  initialLpFeesUsd?: number;
  initialTimestamp: number;
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
  // Isolated PnL (from HL API, filtered by coin + sinceTimestamp)
  virtualPnlUsd: number;
  virtualPnlPercent: number;
  unrealizedVirtualPnlUsd: number;
  realizedVirtualPnlUsd: number;
  lpPnlUsd: number;
}

export interface DiscoveredPosition {
  tokenId: PositionId;
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
  chain?: ChainId;
  dex?: DexId;
}

export interface ActivePositionConfig {
  tokenId: PositionId;
  protocolVersion: 'v3' | 'v4';
  poolAddress: string;
  activatedAt: number;
  hedgeSymbol: string;
  hedgeToken: 'token0' | 'token1';
  protectionType?: string; // 'delta-neutral'
  hedgeRatio?: number; // 0.8 to protect 80%
  cooldownSeconds?: number; // intervalo mínimo entre rebalances (sobrescreve config global)
  emergencyPriceMovementThreshold?: number; // % de movimento de preço para emergency (bypassa cooldown)
  // Pool metadata — populated from DiscoveredPosition at activation
  token0Symbol?: string;
  token1Symbol?: string;
  token0Address?: string;
  token1Address?: string;
  token0Decimals?: number;
  token1Decimals?: number;
  fee?: number;
  tickLower?: number;
  tickUpper?: number;
  chain?: ChainId;           // default 'base' for existing positions
  dex?: DexId;               // default 'uniswap-v3' for existing positions
  positionId?: PositionId;   // alias for tokenId; number for EVM
  activationId?: string;     // UUID gerado em cada ativação — linka rebalances e closed_position
}

export interface HistoricalPosition {
  tokenId: PositionId;
  poolAddress: string;
  protocolVersion: 'v3' | 'v4';
  token0Symbol: string;
  token1Symbol: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  hedgeSymbol: string;
  activatedAt: number;
  deactivatedAt: number;
  initialLpUsd: number;
  initialHlUsd: number;
  finalLpFeesUsd: number;
  finalCumulativeFundingUsd: number;
  finalCumulativeHlFeesUsd: number;
  finalVirtualPnlUsd: number;
  finalVirtualPnlPercent: number;
  finalUnrealizedPnlUsd: number;
  finalRealizedPnlUsd: number;
  priceLowerUsd?: number;
  priceUpperUsd?: number;
  activationId?: string;
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
  lastLiquidity?: string; // serialized bigint — detect add/remove liquidity events
}

export interface BotState {
  positions: Record<string, PositionState>;
  history?: HistoricalPosition[];
}
