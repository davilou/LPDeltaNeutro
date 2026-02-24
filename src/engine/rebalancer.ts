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
            lastHedge: loaded.lastHedge || { symbol: config.hedgeSymbol, size: 0, notionalUsd: 0, side: 'none' },
            lastPrice: loaded.lastPrice || 0,
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
    const hedgeSymbol = cfg.hedgeSymbol || config.hedgeSymbol;

    this.state.positions[tokenId] = {
      lastHedge: { symbol: hedgeSymbol, size: 0, notionalUsd: 0, side: 'none' },
      lastPrice: 0,
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
    const hedgeSymbol = cfg.hedgeSymbol || config.hedgeSymbol;
    const hedgeToken = cfg.hedgeToken || config.hedgeToken;
    const hedgeRatio = cfg.hedgeRatio ?? 1.0;
    const cooldownSec = cfg.cooldownSeconds ?? config.cooldownSeconds;
    const deltaMismatchThreshold = cfg.deltaMismatchThreshold ?? config.deltaMismatchThreshold;
    const emergencyMismatchThreshold = cfg.emergencyMismatchThreshold ?? config.emergencyMismatchThreshold;
    const emergencyHedgeRatio = cfg.emergencyHedgeRatio ?? config.emergencyHedgeRatio;
    const timeRebalanceIntervalMin = config.timeRebalanceIntervalMin;

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
    const target: HedgeTarget = calculateHedge(position, fundingRate);

    // Apply per-position hedgeRatio override
    target.size *= hedgeRatio;
    target.notionalUsd *= hedgeRatio;

    // Get current hedge position for this symbol
    const currentHedge = await this.exchange.getPosition(hedgeSymbol);

    // Pre-compute mismatch
    const hedgeReference = target.size > 0 ? target.size : currentHedge.size;
    const currentMismatch = hedgeReference > 0
      ? Math.abs(target.size - currentHedge.size) / hedgeReference
      : 0;

    // Check triggers — each returns a reason string or null
    const emergencyReason = this.checkEmergencyRebalance(tokenId, target, currentHedge, emergencyMismatchThreshold, emergencyHedgeRatio);
    const deltaReason = !emergencyReason
      ? this.checkNeedsRebalance(tokenId, target, currentHedge, position.rangeStatus, position.price, position.tickLower, position.tickUpper, deltaMismatchThreshold)
      : null;
    const timeReason = !emergencyReason && !deltaReason
      ? this.checkTimeRebalance(tokenId, ps, currentMismatch, timeRebalanceIntervalMin)
      : null;

    const triggerReason = emergencyReason ?? deltaReason ?? timeReason ?? null;
    const isEmergency = emergencyReason !== null;
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
    this.logTimeUntilNextRebalance(tokenId, ps, cooldownSec, timeRebalanceIntervalMin);

    if (!needsRebalance) {
      logger.info(`[NFT#${tokenId}] No rebalance needed`);
      this.lastRangeStatusMap[tokenId] = position.rangeStatus;
      ps.lastPrice = position.price;
      return;
    }

    // Compute effective target: emergency uses partial (close X% of gap)
    let effectiveSize = target.size;
    let effectiveNotional = target.notionalUsd;
    if (isEmergency) {
      effectiveSize = currentHedge.size + (target.size - currentHedge.size) * emergencyHedgeRatio;
      effectiveNotional = effectiveSize * position.price;
    }

    // Run safety checks — emergency bypasses cooldown
    const changeUsd = Math.abs(effectiveNotional - currentHedge.notionalUsd);
    const safetyResult = isEmergency
      ? (() => {
        for (const r of [
          checkMinNotional(changeUsd),
          checkMaxNotional(effectiveNotional),
          checkDuplicate(effectiveSize, currentHedge.size),
          checkDailyLimit(ps.dailyRebalanceCount),
          checkHourlyLimit(ps.hourlyRebalanceCount),
        ]) { if (!r.allowed) return r; }
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
      `($${currentHedge.notionalUsd.toFixed(2)} → $${effectiveNotional.toFixed(2)})` +
      (isEmergency ? ` [partial ${(emergencyHedgeRatio * 100).toFixed(0)}% of gap]` : '')
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

  private checkEmergencyRebalance(
    tokenId: number,
    target: HedgeTarget,
    current: HedgeState,
    emergencyThreshold: number,
    emergencyRatio: number
  ): string | null {
    if (target.size === 0 && current.size === 0) return null;
    const reference = target.size > 0 ? target.size : current.size;
    const mismatch = Math.abs(target.size - current.size) / reference;
    if (mismatch > emergencyThreshold) {
      const reason = `emergency: mismatch ${(mismatch * 100).toFixed(1)}% > ${(emergencyThreshold * 100).toFixed(0)}%, partial ${(emergencyRatio * 100).toFixed(0)}% of gap, cooldown bypassed`;
      logger.warn(`[NFT#${tokenId}] EMERGENCY: ${reason}`);
      return reason;
    }
    return null;
  }

  private checkTimeRebalance(
    tokenId: number,
    ps: PositionState,
    currentMismatch: number,
    intervalMin: number
  ): string | null {
    if (intervalMin <= 0) return null;

    const elapsedMs = Date.now() - ps.lastRebalanceTimestamp;
    const intervalMs = intervalMin * 60 * 1000;

    if (elapsedMs < intervalMs) return null;

    const minMismatch = config.timeRebalanceMinMismatch;
    if (minMismatch > 0 && currentMismatch < minMismatch) {
      logger.info(
        `[NFT#${tokenId}] Time rebalance skipped: mismatch ${(currentMismatch * 100).toFixed(2)}% < min ${(minMismatch * 100).toFixed(2)}%`
      );
      return null;
    }

    const reason = `scheduled timer: ${(elapsedMs / 60000).toFixed(1)}min elapsed ≥ ${intervalMin}min interval` +
      (minMismatch > 0 ? `, mismatch=${(currentMismatch * 100).toFixed(2)}%` : '');
    logger.info(`[NFT#${tokenId}] Time-based rebalance triggered: ${reason}`);
    return reason;
  }

  private logTimeUntilNextRebalance(tokenId: number, ps: PositionState, cooldownSec: number, intervalMin: number): void {
    const now = Date.now();
    const elapsedMs = now - ps.lastRebalanceTimestamp;

    const parts: string[] = [];

    // Cooldown remaining
    const cooldownMs = cooldownSec * 1000;
    const cooldownRemainingMs = cooldownMs - elapsedMs;
    if (cooldownRemainingMs > 0) {
      const h = Math.floor(cooldownRemainingMs / 3600000);
      const m = Math.floor((cooldownRemainingMs % 3600000) / 60000);
      parts.push(`cooldown: ${h}h ${m}m remaining`);
    } else {
      parts.push(`cooldown: open`);
    }

    // Time-based rebalance remaining
    if (intervalMin > 0) {
      const intervalMs = intervalMin * 60 * 1000;
      const intervalRemainingMs = intervalMs - elapsedMs;
      if (intervalRemainingMs > 0) {
        const h = Math.floor(intervalRemainingMs / 3600000);
        const m = Math.floor((intervalRemainingMs % 3600000) / 60000);
        parts.push(`next scheduled: ${h}h ${m}m`);
      } else {
        parts.push(`next scheduled: open`);
      }
    }

    logger.info(`[NFT#${tokenId}] Rebalance window — ${parts.join(' | ')}`);
  }

  private computeEffectiveThreshold(tickLower: number, tickUpper: number, baseDeltaMismatch: number): number {
    if (!config.adaptiveThreshold) return baseDeltaMismatch;

    const tickRange = tickUpper - tickLower;
    if (tickRange <= 0) return baseDeltaMismatch;

    const scale = config.adaptiveReferenceTickRange / tickRange;
    const adaptive = baseDeltaMismatch * scale;

    const clamped = Math.min(
      Math.max(adaptive, baseDeltaMismatch * 0.5),
      config.adaptiveMaxThreshold
    );

    logger.info(
      `Adaptive threshold: tickRange=${tickRange}, scale=${scale.toFixed(2)}x, ` +
      `effective=${(clamped * 100).toFixed(1)}% (base=${(baseDeltaMismatch * 100).toFixed(1)}%)`
    );
    return clamped;
  }

  private checkNeedsRebalance(
    tokenId: number,
    target: HedgeTarget,
    current: HedgeState,
    rangeStatus: string,
    price: number,
    tickLower: number,
    tickUpper: number,
    deltaMismatchThreshold: number
  ): string | null {
    const lastRangeStatus = this.lastRangeStatusMap[tokenId] ?? null;

    // Range status changed
    if (lastRangeStatus !== null && lastRangeStatus !== rangeStatus) {
      const reason = `range status changed: ${lastRangeStatus} → ${rangeStatus}`;
      logger.info(`[NFT#${tokenId}] ${reason}`);
      return reason;
    }

    // Delta mismatch threshold
    if (target.size === 0 && current.size === 0) {
      return null;
    }

    const reference = target.size > 0 ? target.size : current.size;
    const mismatch = Math.abs(target.size - current.size) / reference;
    const effectiveThreshold = this.computeEffectiveThreshold(tickLower, tickUpper, deltaMismatchThreshold);

    if (mismatch > effectiveThreshold) {
      const deltaUsd = Math.abs(target.size - current.size) * price;
      if (deltaUsd < config.minRebalanceUsd) {
        logger.info(`[NFT#${tokenId}] Delta mismatch ${(mismatch * 100).toFixed(2)}% but order $${deltaUsd.toFixed(2)} < min $${config.minRebalanceUsd} — skipping`);
        return null;
      }
      const reason = `delta mismatch: ${(mismatch * 100).toFixed(2)}% > threshold ${(effectiveThreshold * 100).toFixed(2)}% (order ~$${deltaUsd.toFixed(2)})`;
      logger.info(`[NFT#${tokenId}] ${reason}`);
      return reason;
    }

    return null;
  }
}
