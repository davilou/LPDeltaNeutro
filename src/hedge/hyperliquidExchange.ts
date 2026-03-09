import { ethers } from 'ethers';
import { Hyperliquid } from 'hyperliquid';
import { HedgeState } from '../types';
import { FillResult, HlIsolatedPnl, IHedgeExchange } from './types';
import { logger } from '../utils/logger';

export class HyperliquidExchange implements IHedgeExchange {
  private sdk: Hyperliquid;
  public readonly walletAddress: string;
  private szDecimalsCache: Map<string, number> = new Map();

  constructor(privateKey: string, walletAddress: string) {
    if (!privateKey || !walletAddress) {
      throw new Error(
        'HyperliquidExchange requires HL_PRIVATE_KEY and HL_WALLET_ADDRESS when DRY_RUN=false'
      );
    }

    // Detect agent-wallet setup: if the private key derives to a different address
    // than walletAddress, walletAddress is the master/vault account and must be passed
    // as vaultAddress so orders are routed to it (signed by the agent key).
    const signerAddress = ethers.computeAddress(privateKey);
    const isAgentSetup = signerAddress.toLowerCase() !== walletAddress.toLowerCase();

    this.walletAddress = walletAddress;
    this.sdk = new Hyperliquid({
      privateKey,
      walletAddress,
      enableWs: false,
    });

    if (isAgentSetup) {
      logger.info(`HyperliquidExchange (agent setup): signer=${signerAddress} master=${walletAddress}`);
    } else {
      logger.info(`HyperliquidExchange initialized for wallet ${walletAddress}`);
    }
  }

  /** Strip "-PERP" suffix: "VIRTUAL-PERP" → "VIRTUAL" */
  private baseCoin(symbol: string): string {
    return symbol ? symbol.replace(/-PERP$/, '') : '';
  }

  /** Get szDecimals for an asset (cached after first lookup) */
  private async getSzDecimals(symbol: string): Promise<number> {
    const coin = this.baseCoin(symbol);
    const cached = this.szDecimalsCache.get(coin);
    if (cached !== undefined) return cached;

    await this.sdk.ensureInitialized();
    const [meta] = await this.sdk.info.perpetuals.getMetaAndAssetCtxs(true);
    for (const asset of meta.universe) {
      this.szDecimalsCache.set(asset.name, asset.szDecimals);
    }

    const decimals = this.szDecimalsCache.get(coin);
    if (decimals === undefined) {
      throw new Error(`Unknown asset: ${coin} — not found in Hyperliquid meta`);
    }
    return decimals;
  }

  /** Round size to the asset's szDecimals */
  private roundSize(size: number, szDecimals: number): number {
    const factor = Math.pow(10, szDecimals);
    return Math.round(size * factor) / factor;
  }

  async getFundingRate(symbol: string): Promise<number> {
    const coin = this.baseCoin(symbol);

    await this.sdk.ensureInitialized();
    const [meta, contexts] = await this.sdk.info.perpetuals.getMetaAndAssetCtxs(true);

    const idx = meta.universe.findIndex((a) => a.name === coin);
    if (idx === -1) {
      throw new Error(`Asset ${coin} not found in Hyperliquid universe`);
    }

    const rate = parseFloat(contexts[idx].funding);
    logger.info(`[HL] Funding rate for ${coin}: ${(rate * 100).toFixed(4)}% (hourly)`);
    return rate;
  }

  async getAccountEquity(): Promise<number> {
    await this.sdk.ensureInitialized();

    // Use spot USDC balance as HL equity baseline (consistent with initialHlUsd calibration).
    // marginSummary.accountValue includes unrealized perp PnL, which would misalign with
    // the spot-based initialHlUsd and double-count perp PnL already tracked by virtualPnl.
    const spotState = await this.sdk.info.spot.getSpotClearinghouseState(this.walletAddress, true);
    let equity = 0;
    for (const bal of spotState.balances) {
      if (bal.coin === 'USDC') {
        equity = parseFloat(bal.total);
        break;
      }
    }

    logger.info(`[HL] Account equity (spot USDC): $${equity.toFixed(2)}`);
    return equity;
  }

  async getPosition(symbol: string): Promise<HedgeState> {
    const coin = this.baseCoin(symbol);

    await this.sdk.ensureInitialized();
    const state = await this.sdk.info.perpetuals.getClearinghouseState(this.walletAddress, true);

    const assetPos = state.assetPositions.find((ap) => ap.position.coin === coin);

    if (!assetPos) {
      return { symbol, size: 0, notionalUsd: 0, side: 'none' };
    }

    const pos = assetPos.position as any;
    const szi = parseFloat(pos.szi);
    const positionValue = parseFloat(pos.positionValue);
    const entryPx = pos.entryPx ? parseFloat(pos.entryPx) : undefined;
    const unrealizedPnl = pos.unrealizedPnl !== undefined ? parseFloat(pos.unrealizedPnl) : undefined;

    const hedgeState: HedgeState = {
      symbol,
      size: Math.abs(szi),
      notionalUsd: Math.abs(positionValue),
      side: szi < 0 ? 'short' : 'none',
      avgEntryPrice: entryPx && entryPx > 0 ? entryPx : undefined,
      unrealizedPnlUsd: unrealizedPnl,
    };

    logger.info(
      `[HL] Position: ${coin} size=${hedgeState.size} notional=$${hedgeState.notionalUsd.toFixed(2)} side=${hedgeState.side} entryPx=${entryPx?.toFixed(6) ?? 'n/a'} unrealizedPnl=$${unrealizedPnl?.toFixed(4) ?? 'n/a'}`
    );
    return hedgeState;
  }

  async setPosition(symbol: string, targetSize: number, _notionalUsd: number): Promise<FillResult | null> {
    const current = await this.getPosition(symbol);
    const delta = targetSize - current.size;
    const epsilon = 1e-6;

    if (Math.abs(delta) < epsilon) {
      logger.info(`[HL] Position already at target size ${targetSize} — no-op`);
      return null;
    }

    const szDecimals = await this.getSzDecimals(symbol);
    await this.sdk.ensureInitialized();

    if (delta > 0) {
      // Need more short: sell (open/increase)
      const sz = this.roundSize(delta, szDecimals);
      logger.info(`[HL] Opening/increasing short: sell ${sz} ${symbol}`);

      const result = await this.sdk.custom.marketOpen(symbol, false, sz);
      return this.logOrderResult('SELL', symbol, sz, result);
    } else {
      // Need less short: buy (reduce)
      const sz = this.roundSize(Math.abs(delta), szDecimals);
      logger.info(`[HL] Reducing short: buy ${sz} ${symbol}`);

      const result = await this.sdk.custom.marketClose(symbol, sz);
      return this.logOrderResult('BUY-REDUCE', symbol, sz, result);
    }
  }

  async closePosition(symbol: string): Promise<FillResult | null> {
    const current = await this.getPosition(symbol);
    if (current.size <= 0) {
      logger.info(`[HL] No position to close for ${symbol}`);
      return null;
    }

    logger.info(`[HL] Closing full position: ${current.size} ${symbol}`);

    await this.sdk.ensureInitialized();
    const result = await this.sdk.custom.marketClose(symbol);
    return this.logOrderResult('CLOSE', symbol, current.size, result);
  }

  async getIsolatedPnl(symbol: string, sinceTimestamp: number): Promise<HlIsolatedPnl> {
    const coin = this.baseCoin(symbol);
    try {
      await this.sdk.ensureInitialized();

      const fills = await (this.sdk.info as any).getUserFillsByTime(this.walletAddress, sinceTimestamp);
      const allFills: any[] = Array.isArray(fills) ? fills : [];
      // HL fills return coin as "ETH-PERP" — normalise both sides with baseCoin()
      const coinFills: any[] = allFills.filter((f: any) => this.baseCoin(f.coin) === coin);
      logger.info(`[HL] getIsolatedPnl ${coin}: totalFills=${allFills.length} coinFills=${coinFills.length}`);
      const realizedPnlUsd = coinFills.reduce((sum, f) => sum + parseFloat(f.closedPnl ?? '0'), 0);
      const cumulativeFeesUsd = coinFills.reduce((sum, f) => sum + parseFloat(f.fee ?? '0'), 0);

      const funding = await (this.sdk.info.perpetuals as any).getUserFunding(this.walletAddress, sinceTimestamp);
      // Normalise funding coin field as well
      const coinFunding: any[] = Array.isArray(funding) ? funding.filter((f: any) => this.baseCoin(f.coin) === coin) : [];
      const cumulativeFundingUsd = coinFunding.reduce((sum, f) => sum + parseFloat(f.usdc ?? '0'), 0);

      logger.info(
        `[HL] IsolatedPnl ${coin}: realized=$${realizedPnlUsd.toFixed(2)} fees=$${cumulativeFeesUsd.toFixed(4)} funding=$${cumulativeFundingUsd.toFixed(4)}`
      );

      return { unrealizedPnlUsd: 0, realizedPnlUsd, cumulativeFundingUsd, cumulativeFeesUsd };
    } catch (err) {
      logger.warn(`[HL] getIsolatedPnl failed for ${coin}: ${err}. Returning zeros.`);
      return { unrealizedPnlUsd: 0, realizedPnlUsd: 0, cumulativeFundingUsd: 0, cumulativeFeesUsd: 0 };
    }
  }

  private logOrderResult(action: FillResult['action'], symbol: string, sz: number, result: any): FillResult {
    const statuses = result?.response?.data?.statuses;
    if (statuses && statuses.length > 0) {
      const status = statuses[0];
      if (status.filled) {
        const avgPx = parseFloat(status.filled.avgPx);
        const totalSz = parseFloat(status.filled.totalSz);
        logger.info(`[HL] ${action} ${symbol} filled: sz=${totalSz} avgPx=${avgPx}`);
        return { action, sz: totalSz, avgPx };
      }
      if (status.error) {
        throw new Error(`[HL] ${action} ${symbol} rejected by exchange: ${JSON.stringify(status.error)}`);
      }
      if (status.resting) {
        throw new Error(`[HL] ${action} ${symbol} order resting (not filled immediately): oid=${status.resting.oid}`);
      }
      throw new Error(`[HL] ${action} ${symbol} unexpected order status: ${JSON.stringify(status)}`);
    }
    throw new Error(`[HL] ${action} ${symbol} sz=${sz} no fill status in response: ${JSON.stringify(result)}`);
  }
}
