import { config } from '../config';
import { ActivePositionConfig, BotState, HedgeState, LPPosition, PositionState } from '../types';
import { FillResult, IHedgeExchange } from '../hedge/types';
import { calculateHedge, HedgeTarget } from '../hedge/hedgeCalculator';
import { insertRebalance } from '../db/supabase';
import { runAllSafetyChecks, checkMinNotional, checkMaxNotional, checkDuplicate, checkDailyLimit, checkHourlyLimit } from '../utils/safety';
import { logger, logCycle } from '../utils/logger';
import { dashboardStore } from '../dashboard/store';
import { PnlTracker } from '../pnl/tracker';
import fs from 'fs';
import path from 'path';

const STATE_FILE = path.resolve(__dirname, '..', '..', 'state.json');

export class Rebalancer {
  private state: BotState;
  private exchange: IHedgeExchange;
  private lastRangeStatusMap: Record<number, string> = {};
  private pnlTrackers: Record<number, PnlTracker> = {};

  constructor(exchange: IHedgeExchange) {
    this.exchange = exchange;
    this.state = this.loadState();

    // Restore PnlTrackers for all persisted positions
    for (const [tokenIdStr, posState] of Object.entries(this.state.positions)) {
      const tokenId = Number(tokenIdStr);
      this.pnlTrackers[tokenId] = new PnlTracker(posState.pnl);
    }
  }

  public get fullState(): BotState {
    return this.state;
  }

  private loadState(): BotState {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        const loaded = JSON.parse(raw);
        logger.info(`State loaded from ${STATE_FILE}`);

        // Migrate old single-position format to new multi-position format
        if (loaded.positions) {
          // Ensure protocolVersion exists for all positions
          for (const tokenId in loaded.positions) {
            if (!loaded.positions[tokenId].config.protocolVersion) {
              loaded.positions[tokenId].config.protocolVersion = 'v3';
            }
          }
          return loaded as BotState;
        }

        // Old format: flat BotState with single activePosition
        logger.info('Migrating old state format to multi-position format');
        const newState: BotState = { positions: {} };
        if (loaded.activePosition) {
          const tokenId = loaded.activePosition.tokenId;
          newState.positions[tokenId] = {
            lastHedge: loaded.lastHedge || { symbol: loaded.activePosition?.hedgeSymbol ?? '', size: 0, notionalUsd: 0, side: 'none' },
            lastPrice: loaded.lastPrice || 0,
            lastRebalancePrice: loaded.lastRebalancePrice || 0,
            lastRebalanceTimestamp: loaded.lastRebalanceTimestamp || 0,
            dailyRebalanceCount: loaded.dailyRebalanceCount || 0,
            dailyResetDate: loaded.dailyResetDate || new Date().toISOString().split('T')[0],
            hourlyRebalanceCount: loaded.hourlyRebalanceCount || 0,
            hourlyResetTimestamp: loaded.hourlyResetTimestamp || Date.now(),
            pnl: loaded.pnl,
            config: {
              ...loaded.activePosition,
              protocolVersion: loaded.activePosition.protocolVersion || 'v3'
            },
          };
        }
        return newState;
      }
    } catch (err) {
      logger.warn(`Failed to load state: ${err}`);
    }

    return { positions: {} };
  }

  getPnlTracker(tokenId: number): PnlTracker {
    if (!this.pnlTrackers[tokenId]) {
      this.pnlTrackers[tokenId] = new PnlTracker();
    }
    return this.pnlTrackers[tokenId];
  }

  setExchange(exchange: IHedgeExchange): void {
    this.exchange = exchange;
    logger.info('[Rebalancer] Exchange swapped to live HyperliquidExchange');
  }

  activatePosition(cfg: ActivePositionConfig): void {
    const tokenId = cfg.tokenId;
    const hedgeSymbol = cfg.hedgeSymbol;

    this.state.positions[tokenId] = {
      lastHedge: { symbol: hedgeSymbol, size: 0, notionalUsd: 0, side: 'none' },
      lastPrice: 0,
      lastRebalancePrice: 0,
      lastRebalanceTimestamp: 0,
      dailyRebalanceCount: 0,
      dailyResetDate: new Date().toISOString().split('T')[0],
      hourlyRebalanceCount: 0,
      hourlyResetTimestamp: Date.now(),
      config: cfg,
    };

    if (!this.pnlTrackers[tokenId]) {
      this.pnlTrackers[tokenId] = new PnlTracker();
    }

    this.saveState();
    logger.info(`[Rebalancer] Position NFT #${tokenId} activated with hedgeSymbol=${hedgeSymbol}, hedgeRatio=${cfg.hedgeRatio ?? 1.0}`);
  }

  updateConfig(tokenId: number, cfg: ActivePositionConfig): void {
    if (this.state.positions[tokenId]) {
      this.state.positions[tokenId].config = cfg;
      this.saveState();
      logger.info(`[Rebalancer] Configuration updated for NFT #${tokenId}`);
    }
  }

  deactivatePosition(tokenId: number): void {
    if (this.state.positions[tokenId]) {
      delete this.state.positions[tokenId];
      delete this.pnlTrackers[tokenId];
      this.saveState();
      logger.info(`[Rebalancer] Position NFT #${tokenId} deactivated and state cleared`);
    }
  }

  getRestoredPositions(): ActivePositionConfig[] {
    return Object.values(this.state.positions).map(ps => ps.config);
  }

  saveState(): void {
    try {
      // Persist PnL state for all positions
      for (const [tokenIdStr, posState] of Object.entries(this.state.positions)) {
        const tokenId = Number(tokenIdStr);
        if (this.pnlTrackers[tokenId]) {
          posState.pnl = this.pnlTrackers[tokenId].getStateForPersist();
        }
      }
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
      logger.info(`State saved to ${STATE_FILE}`);
    } catch (err) {
      logger.error(`Failed to save state: ${err}`);
    }
  }

  async cycle(tokenId: number, position: LPPosition): Promise<void> {
    const ps = this.state.positions[tokenId];
    if (!ps) {
      logger.warn(`[Rebalancer] No state for tokenId ${tokenId} — skipping cycle`);
      return;
    }

    const cfg = ps.config;
    const hedgeSymbol = cfg.hedgeSymbol;
    const hedgeToken = cfg.hedgeToken ?? 'token0';
    const hedgeRatio = cfg.hedgeRatio ?? 1.0;
    const cooldownSec = config.rebalanceIntervalMin * 60;
    const priceMovThreshold = cfg.priceMovementThreshold ?? config.priceMovementThreshold;
    const emergencyPriceMovThreshold = cfg.emergencyPriceMovementThreshold ?? config.emergencyPriceMovementThreshold;
    const rebalanceIntervalMin = config.rebalanceIntervalMin;

    // Reset daily counter if new day
    const today = new Date().toISOString().split('T')[0];
    if (ps.dailyResetDate !== today) {
      ps.dailyRebalanceCount = 0;
      ps.dailyResetDate = today;
      logger.info(`[NFT#${tokenId}] Daily rebalance counter reset`);
    }

    // Reset hourly counter if 1 hour has passed
    const now = Date.now();
    if (!ps.hourlyResetTimestamp || now - ps.hourlyResetTimestamp >= 3600_000) {
      ps.hourlyRebalanceCount = 0;
      ps.hourlyResetTimestamp = now;
      logger.info(`[NFT#${tokenId}] Hourly rebalance counter reset`);
    }

    // Get funding rate
    const fundingRate = await this.exchange.getFundingRate(hedgeSymbol);

    // Calculate target hedge (uses global config for hedgeToken/hedgeFloor, we override below)
    const target: HedgeTarget = calculateHedge(position, fundingRate, hedgeToken);

    // Apply per-position hedgeRatio override
    target.size *= hedgeRatio;
    target.notionalUsd *= hedgeRatio;

    // Get current hedge position for this symbol
    const currentHedge = await this.exchange.getPosition(hedgeSymbol);

    // Forced close: LP saiu do range, hedge deve ser fechado independente de triggers
    const isForcedClose = target.size <= 0 && currentHedge.size > 0;

    const lastRebalancePrice = ps.lastRebalancePrice ?? 0;

    // Check triggers — cada um retorna reason string ou null
    const emergencyReason = !isForcedClose
      ? this.checkEmergencyPriceMovement(tokenId, position.price, lastRebalancePrice, emergencyPriceMovThreshold)
      : null;
    const timeReason = !isForcedClose && !emergencyReason
      ? this.checkTimeRebalance(tokenId, ps, rebalanceIntervalMin)
      : null;
    const priceReason = !isForcedClose && !emergencyReason && !timeReason
      ? this.checkPriceMovement(tokenId, position.price, lastRebalancePrice, priceMovThreshold)
      : null;
    const forcedCloseReason = isForcedClose
      ? `forced close: LP exited range (hedge=${currentHedge.size.toFixed(4)})`
      : null;

    const triggerReason = forcedCloseReason ?? emergencyReason ?? timeReason ?? priceReason ?? null;
    const isEmergency = isForcedClose || emergencyReason !== null;
    const needsRebalance = triggerReason !== null;

    // Compute net delta and total position value
    const hedgeTokenExposure = hedgeToken === 'token0'
      ? position.token0.amountFormatted
      : position.token1.amountFormatted;
    const netDelta = (hedgeTokenExposure * hedgeRatio) - currentHedge.size;

    const token0Usd = position.token0.amountFormatted * position.price;
    const token1Usd = position.token1.amountFormatted;
    const totalPositionUsd = token0Usd + token1Usd;

    // Log cycle data
    logCycle({
      token0Amount: position.token0.amountFormatted,
      token0Symbol: position.token0.symbol,
      token1Amount: position.token1.amountFormatted,
      token1Symbol: position.token1.symbol,
      price: position.price,
      totalPositionUsd,
      hedgeNotionalUsd: target.notionalUsd,
      fundingRate,
      hedgeSize: currentHedge.size,
      netDelta,
      rangeStatus: position.rangeStatus,
      lpFees0: position.tokensOwed0,
      lpFees1: position.tokensOwed1,
    });

    // Safety check for insane prices (often from RPC decimal errors)
    if (position.price < 0.001) {
      logger.error(`[NFT#${tokenId}] ABORTING CYCLE: Insane price detected ($${position.price}). Check RPC decimals.`);
      return;
    }

    // PnL tracking
    const hlEquity = await this.exchange.getAccountEquity();
    const pnlTracker = this.getPnlTracker(tokenId);

    // Fix corrupted state from previous decimal bug if needed
    const virtualState = pnlTracker.getVirtualState();
    if (virtualState.size > 0 && virtualState.avgPrice < 0.001) {
      logger.warn(`[NFT#${tokenId}] Fixing corrupted avgEntryPrice ($${virtualState.avgPrice} -> $${position.price})`);
      pnlTracker.reinitializeVirtualPrice(position.price);
    }

    pnlTracker.accumulateFunding(fundingRate, currentHedge.notionalUsd);

    const lpFeesUsd = position.tokensOwed0 * position.price + position.tokensOwed1;
    const currentLpUsdWithFees = totalPositionUsd + lpFeesUsd;
    const pnl = pnlTracker.compute(currentLpUsdWithFees, hlEquity, lpFeesUsd, position.price);

    // Persist PnL state
    ps.pnl = pnlTracker.getStateForPersist();

    // Push data to dashboard
    dashboardStore.update({
      tokenId,
      timestamp: Date.now(),
      token0Amount: position.token0.amountFormatted,
      token0Symbol: position.token0.symbol,
      token1Amount: position.token1.amountFormatted,
      token1Symbol: position.token1.symbol,
      price: position.price,
      totalPositionUsd,
      hedgeSize: currentHedge.size,
      hedgeNotionalUsd: currentHedge.notionalUsd,
      hedgeSide: currentHedge.side,
      fundingRate,
      netDelta,
      rangeStatus: position.rangeStatus,
      dailyRebalanceCount: ps.dailyRebalanceCount,
      lastRebalanceTimestamp: ps.lastRebalanceTimestamp,
      lastRebalancePrice: ps.lastRebalancePrice ?? 0,
      pnlTotalUsd: pnl.virtualPnlUsd,
      pnlTotalPercent: pnl.virtualPnlPercent,
      accountPnlUsd: pnl.accountPnlUsd,
      accountPnlPercent: pnl.accountPnlPercent,
      unrealizedPnlUsd: pnl.unrealizedVirtualPnlUsd,
      realizedPnlUsd: pnl.realizedVirtualPnlUsd,
      lpFeesUsd: pnl.lpFeesUsd,
      cumulativeFundingUsd: pnl.cumulativeFundingUsd,
      cumulativeHlFeesUsd: pnl.cumulativeHlFeesUsd,
      initialTotalUsd: pnl.initialTotalUsd,
      currentTotalUsd: pnl.currentTotalUsd,
      hlEquity,
    });

    // Log time until next rebalance on every cycle
    this.logTimeUntilNextRebalance(tokenId, ps, rebalanceIntervalMin);

    if (!needsRebalance) {
      logger.info(`[NFT#${tokenId}] No rebalance needed`);
      this.lastRangeStatusMap[tokenId] = position.rangeStatus;
      ps.lastPrice = position.price;
      return;
    }

    const effectiveSize = target.size;
    const effectiveNotional = target.notionalUsd;

    // Run safety checks — emergency bypasses cooldown; forced close also bypasses daily/hourly limits and minNotional
    const changeUsd = Math.abs(effectiveNotional - currentHedge.notionalUsd);
    const safetyResult = isEmergency
      ? (() => {
        const baseChecks = [
          checkMaxNotional(effectiveNotional),
          checkDuplicate(effectiveSize, currentHedge.size),
        ];
        const rateLimitChecks = isForcedClose ? [] : [
          checkMinNotional(changeUsd),
          checkDailyLimit(ps.dailyRebalanceCount),
          checkHourlyLimit(ps.hourlyRebalanceCount),
        ];
        for (const r of [...baseChecks, ...rateLimitChecks]) { if (!r.allowed) return r; }
        return { allowed: true as const };
      })()
      : runAllSafetyChecks({
        changeUsd,
        totalNotionalUsd: effectiveNotional,
        targetSize: effectiveSize,
        currentSize: currentHedge.size,
        dailyCount: ps.dailyRebalanceCount,
        hourlyCount: ps.hourlyRebalanceCount,
        lastRebalanceTimestamp: ps.lastRebalanceTimestamp,
        cooldownSeconds: cooldownSec,
      });

    if (!safetyResult.allowed) {
      logger.info(`[NFT#${tokenId}] Rebalance blocked by safety: ${safetyResult.reason}`);
      this.lastRangeStatusMap[tokenId] = position.rangeStatus;
      ps.lastPrice = position.price;
      return;
    }

    // Execute rebalance
    const rebalanceLabel = isEmergency ? 'EMERGENCY REBALANCE' : 'REBALANCING';
    logger.info(
      `[NFT#${tokenId}] ${rebalanceLabel} [trigger: ${triggerReason}]: ` +
      `${currentHedge.size.toFixed(4)} → ${effectiveSize.toFixed(4)} ` +
      `($${currentHedge.notionalUsd.toFixed(2)} → $${effectiveNotional.toFixed(2)})`
    );

    // Capture virtual state before trade to compute per-trade closed PnL
    const virtualStateBefore = pnlTracker.getVirtualState();

    let fillResult: FillResult | null = null;
    if (effectiveSize <= 0) {
      fillResult = await this.exchange.closePosition(hedgeSymbol);
    } else {
      fillResult = await this.exchange.setPosition(hedgeSymbol, effectiveSize, effectiveNotional);
    }

    // Per-trade closed PnL: (avgEntry - exitPx) * closedSize for shorts (0 for opens)
    const sizeChange = effectiveSize - currentHedge.size;
    let tradePnlUsd = 0;
    if (sizeChange < 0 && virtualStateBefore.size > 0) {
      const closedSize = Math.min(virtualStateBefore.size, Math.abs(sizeChange));
      const exitPx = fillResult?.avgPx ?? position.price;
      tradePnlUsd = (virtualStateBefore.avgPrice - exitPx) * closedSize;
    }

    // Record trade for Virtual Accounting
    pnlTracker.recordTrade(effectiveSize - currentHedge.size, position.price);

    // Record trade fee for PnL
    const orderNotionalUsd = Math.abs(effectiveNotional - currentHedge.notionalUsd);
    pnlTracker.recordTradeFee(orderNotionalUsd);
    ps.pnl = pnlTracker.getStateForPersist();

    // Record rebalance event in dashboard
    const event = {
      tokenId,
      timestamp: Date.now(),
      fromSize: currentHedge.size,
      toSize: effectiveSize,
      fromNotional: currentHedge.notionalUsd,
      toNotional: effectiveNotional,
      price: position.price,
    };
    dashboardStore.addRebalanceEvent(event);

    if (!ps.rebalances) ps.rebalances = [];
    ps.rebalances.push(event);
    if (ps.rebalances.length > 50) ps.rebalances.shift();

    // Update state
    ps.lastHedge = {
      symbol: hedgeSymbol,
      size: effectiveSize,
      notionalUsd: effectiveNotional,
      side: effectiveSize > 0 ? 'short' : 'none',
    };
    ps.lastPrice = position.price;
    ps.lastRebalancePrice = position.price;
    ps.lastRebalanceTimestamp = Date.now();
    ps.dailyRebalanceCount++;
    ps.hourlyRebalanceCount++;
    this.lastRangeStatusMap[tokenId] = position.rangeStatus;

    // Persist to Supabase (fire-and-forget)
    const feeUsd = orderNotionalUsd * config.hlTakerFee;
    void insertRebalance({
      token_id: tokenId,
      timestamp: new Date().toISOString(),
      coin: hedgeSymbol,
      action: fillResult?.action ?? null,
      avg_px: fillResult?.avgPx ?? null,
      executed_sz: fillResult?.sz ?? null,
      trade_value_usd: fillResult ? fillResult.sz * fillResult.avgPx : null,
      fee_usd: feeUsd,
      trade_pnl_usd: tradePnlUsd,
      trigger_reason: triggerReason,
      is_emergency: isEmergency,
      from_size: currentHedge.size,
      to_size: effectiveSize,
      from_notional: currentHedge.notionalUsd,
      to_notional: effectiveNotional,
      token0_symbol: position.token0.symbol,
      token0_amount: position.token0.amountFormatted,
      token1_symbol: position.token1.symbol,
      token1_amount: position.token1.amountFormatted,
      range_status: position.rangeStatus,
      total_pos_usd: totalPositionUsd,
      price: position.price,
      funding_rate: fundingRate,
      net_delta: netDelta,
      hl_equity: hlEquity,
      pnl_virtual_usd: pnl.virtualPnlUsd,
      pnl_virtual_pct: pnl.virtualPnlPercent,
      pnl_realized_usd: pnl.realizedVirtualPnlUsd,
      pnl_lp_fees_usd: pnl.lpFeesUsd,
      pnl_funding_usd: pnl.cumulativeFundingUsd,
      pnl_hl_fees_usd: pnl.cumulativeHlFeesUsd,
      daily_count: ps.dailyRebalanceCount,
      hedge_ratio: hedgeRatio,
    });

    logger.info(
      `[NFT#${tokenId}] Rebalance complete. Daily count: ${ps.dailyRebalanceCount}/${config.maxDailyRebalances}`
    );

    this.saveState();
  }

  private checkEmergencyPriceMovement(
    tokenId: number,
    currentPrice: number,
    lastRebalancePrice: number,
    threshold: number
  ): string | null {
    if (lastRebalancePrice <= 0) return null;
    const movement = Math.abs(currentPrice - lastRebalancePrice) / lastRebalancePrice;
    if (movement > threshold) {
      const reason = `emergency: price moved ${(movement * 100).toFixed(2)}% ($${lastRebalancePrice.toFixed(4)} → $${currentPrice.toFixed(4)}), cooldown bypassed`;
      logger.warn(`[NFT#${tokenId}] EMERGENCY: ${reason}`);
      return reason;
    }
    return null;
  }

  private checkPriceMovement(
    tokenId: number,
    currentPrice: number,
    lastRebalancePrice: number,
    threshold: number
  ): string | null {
    if (lastRebalancePrice <= 0) return null;
    const movement = Math.abs(currentPrice - lastRebalancePrice) / lastRebalancePrice;
    if (movement > threshold) {
      const reason = `price moved ${(movement * 100).toFixed(2)}% ($${lastRebalancePrice.toFixed(4)} → $${currentPrice.toFixed(4)}) > threshold ${(threshold * 100).toFixed(1)}%`;
      logger.info(`[NFT#${tokenId}] Price movement trigger: ${reason}`);
      return reason;
    }
    return null;
  }

  private checkTimeRebalance(
    tokenId: number,
    ps: PositionState,
    intervalMin: number
  ): string | null {
    if (intervalMin <= 0) return null;

    const elapsedMs = Date.now() - ps.lastRebalanceTimestamp;
    const intervalMs = intervalMin * 60 * 1000;

    if (elapsedMs < intervalMs) return null;

    const reason = `timer: ${(elapsedMs / 60000).toFixed(1)}min elapsed ≥ ${intervalMin}min interval`;
    logger.info(`[NFT#${tokenId}] Time-based rebalance: ${reason}`);
    return reason;
  }

  private logTimeUntilNextRebalance(tokenId: number, ps: PositionState, intervalMin: number): void {
    const elapsedMs = Date.now() - ps.lastRebalanceTimestamp;
    const remainingMs = intervalMin * 60 * 1000 - elapsedMs;
    if (remainingMs > 0) {
      const h = Math.floor(remainingMs / 3600000);
      const m = Math.floor((remainingMs % 3600000) / 60000);
      logger.info(`[NFT#${tokenId}] Next rebalance in ${h}h ${m}m`);
    } else {
      logger.info(`[NFT#${tokenId}] Next rebalance window: open`);
    }
  }

}
