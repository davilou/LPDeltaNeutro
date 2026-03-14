import { EventEmitter } from 'events';
import { DiscoveredPosition, ActivePositionConfig, HistoricalPosition } from '../types';
import type { ChainId, DexId, PositionId } from '../lp/types';

export interface DashboardData {
  tokenId: PositionId;
  timestamp: number;
  token0Amount: number;
  token0Symbol: string;
  token1Amount: number;
  token1Symbol: string;
  price: number;
  totalPositionUsd: number;
  hedgeSize: number;
  hedgeNotionalUsd: number;
  hedgeSide: string;
  fundingRate: number;
  netDelta: number;
  rangeStatus: string;
  dailyRebalanceCount: number;
  lastRebalanceTimestamp: number;
  lastRebalancePrice: number;
  // PnL (Virtual / Isolated)
  pnlTotalUsd?: number;
  pnlTotalPercent?: number;
  unrealizedPnlUsd?: number;
  realizedPnlUsd?: number;
  lpPnlUsd?: number;
  // Account PnL (Total Balance based)
  accountPnlUsd?: number;
  accountPnlPercent?: number;
  lpFeesUsd?: number;
  cumulativeFundingUsd?: number;
  cumulativeHlFeesUsd?: number;
  initialLpUsd?: number;
  initialTotalUsd?: number;
  currentTotalUsd?: number;
  hlEquity?: number;
  fee?: number;
  priceLower?: number;
  priceUpper?: number;
  aprAllTime?: number | null;
  apr7d?: number | null;
  apr24h?: number | null;
  aprDailyFeesUsd?: number | null;
}

export interface RebalanceEvent {
  tokenId: PositionId;
  timestamp: number;
  fromSize: number;
  toSize: number;
  fromNotional: number;
  toNotional: number;
  price: number;
  // Extended fields for display
  coin?: string;
  action?: string;
  avgPx?: number;
  tradeValueUsd?: number;
  feeUsd?: number;
  triggerReason?: string;
  token0Symbol?: string;
  token1Symbol?: string;
  isEmergency?: boolean;
  fundingUsd?: number;
  realizedPnlUsd?: number;
}

export interface ActivatePositionRequest {
  tokenId: PositionId;
  protocolVersion: 'v3' | 'v4';
  poolAddress: string;
  token0Symbol: string;
  token1Symbol: string;
  fee?: number;
  tickLower?: number;
  tickUpper?: number;
  protectionType?: string;
  hedgeRatio?: number;
  cooldownSeconds?: number;
  emergencyPriceMovementThreshold?: number;
  chain?: ChainId;
  dex?: DexId;
  positionId?: PositionId;
}

export interface ActivationResult {
  success: boolean;
  tokenId: PositionId;
  error?: string;
  initialLpUsd?: number;
  initialHlUsd?: number;
}

export interface SaveCredentialsRequest {
  privateKey: string;
  walletAddress: string;
}

const MAX_HISTORY = 200;
const MAX_REBALANCES = 50;

class DashboardStore extends EventEmitter {
  private currentMap: Record<string, DashboardData> = {};
  private historyMap: Record<string, DashboardData[]> = {};
  private rebalanceEventsMap: Record<string, RebalanceEvent[]> = {};
  private startTime = Date.now();
  private discoveredPositions: DiscoveredPosition[] = [];
  private activePositions: Record<string, ActivePositionConfig> = {};
  private credentialsWallet: string | null = null;
  private positionHistory: HistoricalPosition[] = [];

  update(data: DashboardData): void {
    const id = data.tokenId;
    this.currentMap[id] = data;

    if (!this.historyMap[id]) this.historyMap[id] = [];
    this.historyMap[id].push(data);
    if (this.historyMap[id].length > MAX_HISTORY) {
      this.historyMap[id].shift();
    }

    this.emit('update', data);
  }

  addRebalanceEvent(event: RebalanceEvent): void {
    const id = event.tokenId;
    if (!this.rebalanceEventsMap[id]) this.rebalanceEventsMap[id] = [];
    this.rebalanceEventsMap[id].push(event);
    if (this.rebalanceEventsMap[id].length > MAX_REBALANCES) {
      this.rebalanceEventsMap[id].shift();
    }

    this.emit('rebalance', event);
  }

  setDiscoveredPositions(positions: DiscoveredPosition[]): void {
    this.discoveredPositions = positions;
    this.emit('positionsDiscovered', positions);
  }

  emitScanProgress(payload: { done: number; total: number; chain?: string }): void {
    this.emit('scanProgress', payload);
  }

  getDiscoveredPositions(): DiscoveredPosition[] {
    return this.discoveredPositions;
  }

  setActivePositionConfig(tokenId: PositionId, cfg: ActivePositionConfig | null): void {
    if (cfg) {
      this.activePositions[tokenId] = cfg;
    } else {
      delete this.activePositions[tokenId];
    }
  }

  getActivePositionConfig(tokenId: PositionId): ActivePositionConfig | null {
    return this.activePositions[tokenId] || null;
  }

  getAllActivePositions(): Record<string, ActivePositionConfig> {
    return this.activePositions;
  }

  getAllActiveConfigs(): ActivePositionConfig[] {
    return Object.values(this.activePositions);
  }

  requestActivation(req: ActivatePositionRequest): void {
    this.emit('activatePosition', req);
  }

  notifyActivationResult(result: ActivationResult): void {
    this.emit('activationComplete', result);
  }

  requestDeactivation(tokenId: PositionId): void {
    this.emit('deactivatePosition', tokenId);
  }

  requestConfigUpdate(tokenId: PositionId, cfg: Partial<ActivePositionConfig>): void {
    if (this.activePositions[tokenId]) {
      this.activePositions[tokenId] = { ...this.activePositions[tokenId], ...cfg };
      this.emit('configUpdated', this.activePositions[tokenId]);
    }
  }

  setCredentialsStatus(walletAddress: string | null): void {
    this.credentialsWallet = walletAddress;
    this.emit('credentialsUpdated', { walletAddress });
  }

  getCredentialsStatus(): { isSet: boolean; walletAddress: string | null } {
    return { isSet: this.credentialsWallet !== null, walletAddress: this.credentialsWallet };
  }

  requestCredentialsSave(req: SaveCredentialsRequest): void {
    this.emit('saveCredentials', req);
  }

  requestResetPnl(tokenId: PositionId, initialLpUsd: number, initialHlUsd: number): void {
    this.emit('resetPnl', { tokenId, initialLpUsd, initialHlUsd });
  }

  requestLpRefresh(tokenId: PositionId): void {
    this.emit('refreshLpData', tokenId);
  }

  setPositionHistory(h: HistoricalPosition[]): void {
    this.positionHistory = h;
  }

  addPositionToHistory(entry: HistoricalPosition): void {
    this.positionHistory.push(entry);
  }

  getPositionHistory(): HistoricalPosition[] {
    return this.positionHistory;
  }

  getCurrentData(tokenId: PositionId): DashboardData | null {
    return this.currentMap[tokenId] ?? null;
  }

  getState(): { dataMap: Record<string, DashboardData>; uptime: number; activePositions: Record<string, ActivePositionConfig>; credentials: { isSet: boolean; walletAddress: string | null }; positionHistory: HistoricalPosition[] } {
    return {
      dataMap: this.currentMap,
      uptime: Date.now() - this.startTime,
      activePositions: this.activePositions,
      credentials: this.getCredentialsStatus(),
      positionHistory: this.positionHistory,
    };
  }

  getHistory(tokenId: PositionId): DashboardData[] {
    return this.historyMap[tokenId] || [];
  }

  getRebalanceEvents(tokenId: PositionId): RebalanceEvent[] {
    return this.rebalanceEventsMap[tokenId] || [];
  }

  getAllRebalanceEvents(): RebalanceEvent[] {
    const all = Object.values(this.rebalanceEventsMap).flat();
    all.sort((a, b) => b.timestamp - a.timestamp);
    return all.slice(0, 100);
  }
}

export const dashboardStore = new DashboardStore();

// Per-user store map for multi-tenancy
const userStoreMap = new Map<string, DashboardStore>();

export function getStoreForUser(userId: string): DashboardStore {
  let store = userStoreMap.get(userId);
  if (!store) {
    store = new DashboardStore();
    userStoreMap.set(userId, store);
  }
  return store;
}
