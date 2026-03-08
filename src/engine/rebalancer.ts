import { config } from '../config';
import { ActivePositionConfig, BotState, HedgeState, HistoricalPosition, LPPosition, PnlSnapshot, PositionState, PositionId } from '../types';
import { FillResult, HlIsolatedPnl, IHedgeExchange } from '../hedge/types';
import { calculateHedge, HedgeTarget } from '../hedge/hedgeCalculator';
import { insertRebalance } from '../db/supabase';
import { runAllSafetyChecks, checkMinNotional, checkMaxNotional, checkDuplicate, checkDailyLimit } from '../utils/safety';
import { logger, logCycle } from '../utils/logger';
import { getStoreForUser } from '../dashboard/store';
import { PnlTracker } from '../pnl/tracker';
import fs from 'fs';
import path from 'path';

export class Rebalancer {
  private state: BotState;
  private exchange: IHedgeExchange;
  private lastRangeStatusMap: Record<string, string> = {};
  private pnlTrackers: Record<string, PnlTracker> = {};
  private readonly userId: string;
  private readonly stateFile: string;

  constructor(exchange: IHedgeExchange, userId = 'default') {
    this.exchange = exchange;
    this.userId = userId;
    this.stateFile = path.resolve(__dirname, '..', '..', `state-${userId}.json`);
    this.state = this.loadState();

    // Restore PnlTrackers for all persisted positions
    for (const [tokenIdStr, posState] of Object.entries(this.state.positions)) {
      this.pnlTrackers[tokenIdStr] = new PnlTracker(posState.pnl);
    }
  }

  public get fullState(): BotState {
    return this.state;
  }

  private loadState(): BotState {
    try {
      // Migrate legacy state.json → state-{userId}.json on first run
      const legacyFile = path.resolve(__dirname, '..', '..', 'state.json');
      if (!fs.existsSync(this.stateFile) && this.userId === 'default' && fs.existsSync(legacyFile)) {
        fs.copyFileSync(legacyFile, this.stateFile);
        logger.info(`Migrated state.json → ${this.stateFile}`);
      }

      if (fs.existsSync(this.stateFile)) {
        const raw = fs.readFileSync(this.stateFile, 'utf-8');
        const loaded = JSON.parse(raw);
        logger.info(`State loaded from ${this.stateFile}`);

        // Migrate old single-position format to new multi-position format
        if (loaded.positions) {
          // Ensure protocolVersion exists for all positions
          for (const tokenId in loaded.positions) {
            if (!loaded.positions[tokenId].config.protocolVersion) {
              loaded.positions[tokenId].config.protocolVersion = 'v3';
            }
            // Multi-chain migration: default to base:uniswap-v3 for pre-existing positions
            if (!loaded.positions[tokenId].config.chain) {
              loaded.positions[tokenId].config.chain = 'base';
            }
            if (!loaded.positions[tokenId].config.dex) {
              const proto = loaded.positions[tokenId].config.protocolVersion;
              loaded.positions[tokenId].config.dex = proto === 'v4' ? 'uniswap-v4' : 'uniswap-v3';
            }
            if (loaded.positions[tokenId].config.positionId === undefined) {
              loaded.positions[tokenId].config.positionId = loaded.positions[tokenId].config.tokenId;
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

  getPnlTracker(tokenId: PositionId): PnlTracker {
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
      config: cfg,
    };

    if (!this.pnlTrackers[tokenId]) {
      this.pnlTrackers[tokenId] = new PnlTracker();
    }

    this.saveState();
    logger.info(`[Rebalancer] Position NFT #${tokenId} activated with hedgeSymbol=${hedgeSymbol}, hedgeRatio=${cfg.hedgeRatio ?? 1.0}`);
  }

  updateConfig(tokenId: PositionId, cfg: ActivePositionConfig): void {
    if (this.state.positions[tokenId]) {
      this.state.positions[tokenId].config = cfg;
      this.saveState();
      logger.info(`[Rebalancer] Configuration updated for NFT #${tokenId}`);
    }
  }

  deactivatePosition(tokenId: PositionId): void {
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

  getHistory(): HistoricalPosition[] {
    return this.state.history ?? [];
  }

  archivePosition(tokenId: PositionId, finalPnl: PnlSnapshot): HistoricalPosition {
    const ps = this.state.positions[tokenId];
    if (!ps) throw new Error(`[Rebalancer] archivePosition: no state for tokenId ${tokenId}`);

    const cfg = ps.config;
    const record: HistoricalPosition = {
      tokenId: cfg.tokenId,
      poolAddress: cfg.poolAddress,
      protocolVersion: cfg.protocolVersion,
      token0Symbol: cfg.token0Symbol ?? '',
      token1Symbol: cfg.token1Symbol ?? '',
      fee: cfg.fee ?? 0,
      tickLower: cfg.tickLower ?? 0,
      tickUpper: cfg.tickUpper ?? 0,
      hedgeSymbol: cfg.hedgeSymbol,
      activatedAt: cfg.activatedAt,
      deactivatedAt: Date.now(),
      initialLpUsd: ps.pnl?.initialLpUsd ?? 0,
      initialHlUsd: ps.pnl?.initialHlUsd ?? 0,
      finalLpFeesUsd: finalPnl.lpFeesUsd,
      finalCumulativeFundingUsd: finalPnl.cumulativeFundingUsd,
      finalCumulativeHlFeesUsd: finalPnl.cumulativeHlFeesUsd,
      finalVirtualPnlUsd: finalPnl.virtualPnlUsd,
      finalVirtualPnlPercent: finalPnl.virtualPnlPercent,
      finalUnrealizedPnlUsd: finalPnl.unrealizedVirtualPnlUsd,
      finalRealizedPnlUsd: finalPnl.realizedVirtualPnlUsd,
    };

    if (!this.state.history) this.state.history = [];
    this.state.history.push(record);
    this.saveState();

    logger.info(`[Rebalancer] Position NFT #${tokenId} archived to history`);
    return record;
  }

  saveState(): void {
    try {
      // Persist PnL state for all positions
      for (const [tokenIdStr, posState] of Object.entries(this.state.positions)) {
        if (this.pnlTrackers[tokenIdStr]) {
          posState.pnl = this.pnlTrackers[tokenIdStr].getStateForPersist();
        }
      }
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
      logger.info(`State saved to ${this.stateFile}`);
    } catch (err) {
      logger.error(`Failed to save state: ${err}`);
    }
  }

  async cycle(tokenId: PositionId, position: LPPosition): Promise<void> {
    const ps = this.state.positions[tokenId];
    if (!ps) {
      logger.warn(`[Rebalancer] No state for tokenId ${tokenId} — skipping cycle`);
      return;
    }

    const cfg = ps.config;
    const hedgeSymbol = cfg.hedgeSymbol;
    const hedgeToken = cfg.hedgeToken ?? 'token0';
    const hedgeRatio = (cfg.hedgeRatio && cfg.hedgeRatio > 0) ? cfg.hedgeRatio : 1.0;
    const cooldownSec = cfg.cooldownSeconds ?? (config.rebalanceIntervalMin * 60);
    const emergencyPriceMovThreshold = cfg.emergencyPriceMovementThreshold ?? config.emergencyPriceMovementThreshold;
    const rebalanceIntervalMin = cfg.cooldownSeconds != null ? cfg.cooldownSeconds / 60 : config.rebalanceIntervalMin;

    // Reset daily counter if new day
    const today = new Date().toISOString().split('T')[0];
    if (ps.dailyResetDate !== today) {
      ps.dailyRebalanceCount = 0;
      ps.dailyResetDate = today;
      logger.info(`[NFT#${tokenId}] Daily rebalance counter reset`);
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

    // Forced close: LP saiu do range (100% stablecoin para token0, 100% volátil para token1)
    const rangeRequiresClose =
      (hedgeToken === 'token0' && position.rangeStatus === 'above-range') ||
      (hedgeToken === 'token1' && position.rangeStatus === 'below-range');
    const isForcedClose = rangeRequiresClose && currentHedge.size > 0;
    // Forced hedge: LP abaixo do range (100% token volátil), aumenta hedge até o target imediatamente
    const isForcedHedge = position.rangeStatus === 'below-range' && target.size > currentHedge.size + 1e-8;

    // Detect liquidity change early — used as a bypass-cooldown trigger
    const liquidityChanged = ps.lastLiquidity !== undefined && ps.lastLiquidity !== position.liquidity.toString();

    const lastRebalancePrice = ps.lastRebalancePrice ?? 0;

    // Check triggers — cada um retorna reason string ou null
    const emergencyReason = !isForcedClose && !isForcedHedge && !liquidityChanged
      ? this.checkEmergencyPriceMovement(tokenId, position.price, lastRebalancePrice, emergencyPriceMovThreshold)
      : null;
    const timeReason = !isForcedClose && !isForcedHedge && !liquidityChanged && !emergencyReason
      ? this.checkTimeRebalance(tokenId, ps, rebalanceIntervalMin)
      : null;
    const forcedCloseReason = isForcedClose
      ? `forced close: LP exited range above (hedge=${currentHedge.size.toFixed(4)})`
      : null;
    const forcedHedgeReason = isForcedHedge
      ? `forced hedge: LP below range, 100% volatile exposure (${currentHedge.size.toFixed(4)} → ${target.size.toFixed(4)})`
      : null;
    const liquidityChangeReason = liquidityChanged && !isForcedClose && !isForcedHedge
      ? `liquidity changed (${ps.lastLiquidity} → ${position.liquidity.toString()}): rebalancing to new delta`
      : null;

    const triggerReason = forcedCloseReason ?? forcedHedgeReason ?? liquidityChangeReason ?? emergencyReason ?? timeReason ?? null;
    const isEmergency = isForcedClose || isForcedHedge || liquidityChangeReason !== null || emergencyReason !== null;
    const needsRebalance = triggerReason !== null;

    // Compute net delta and total position value
    const hedgeTokenExposure = hedgeToken === 'token0'
      ? position.token0.amountFormatted
      : position.token1.amountFormatted;
    const netDelta = (hedgeTokenExposure * hedgeRatio) - currentHedge.size;

    // price = token1/token0 (Uniswap convention); when volatile is token1, invert to get USD price
    const volatilePriceUsd = hedgeToken === 'token0' ? position.price : 1 / position.price;
    const token0Usd = hedgeToken === 'token0'
      ? position.token0.amountFormatted * position.price
      : position.token0.amountFormatted;
    const token1Usd = hedgeToken === 'token1'
      ? position.token1.amountFormatted * volatilePriceUsd
      : position.token1.amountFormatted;
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
    if (volatilePriceUsd < 0.001) {
      logger.error(`[NFT#${tokenId}] ABORTING CYCLE: Insane price detected (volatileUsd=$${volatilePriceUsd}, rawPrice=$${position.price}). Check RPC decimals.`);
      return;
    }

    // Detect liquidity change (add/remove LP) and adjust P&L baseline accordingly.
    // Uses old liquidity at current price to isolate the liquidity effect from price movement.
    const currLiqStr = position.liquidity.toString();
    if (ps.lastLiquidity !== undefined && ps.lastLiquidity !== currLiqStr) {
      const prevLiquidity = BigInt(ps.lastLiquidity);
      const prevLpUsd = this.computeLpUsd(prevLiquidity, position, hedgeToken, volatilePriceUsd);
      const deltaLpUsd = totalPositionUsd - prevLpUsd;
      this.getPnlTracker(tokenId).adjustBaseline(deltaLpUsd);
      logger.warn(
        `[NFT#${tokenId}] Liquidity changed (${ps.lastLiquidity} → ${currLiqStr}), ` +
        `P&L baseline adjusted ${deltaLpUsd >= 0 ? '+' : ''}$${deltaLpUsd.toFixed(2)}`
      );
    }
    ps.lastLiquidity = currLiqStr;

    // PnL tracking
    const hlEquity = await this.exchange.getAccountEquity();
    const pnlTracker = this.getPnlTracker(tokenId);

    const initialTimestamp = ps.pnl?.initialTimestamp ?? Date.now();
    const isolatedPnlFromApi = await this.exchange.getIsolatedPnl(hedgeSymbol, initialTimestamp);
    const hlPnl: HlIsolatedPnl = {
      ...isolatedPnlFromApi,
      unrealizedPnlUsd: currentHedge.unrealizedPnlUsd ?? 0,
    };

    const lpFeesUsd = hedgeToken === 'token0'
      ? position.tokensOwed0 * position.price + position.tokensOwed1
      : position.tokensOwed0 + position.tokensOwed1 * volatilePriceUsd;
    const currentLpUsdWithFees = totalPositionUsd + lpFeesUsd;
    const pnl = pnlTracker.compute(currentLpUsdWithFees, hlEquity, lpFeesUsd, hlPnl);

    // Persist PnL state
    ps.pnl = pnlTracker.getStateForPersist();

    // Price range in volatile-token USD terms
    const decimalAdj = position.token0.decimals - position.token1.decimals;
    const rawPriceLower = Math.pow(1.0001, position.tickLower) * Math.pow(10, decimalAdj);
    const rawPriceUpper = Math.pow(1.0001, position.tickUpper) * Math.pow(10, decimalAdj);
    const priceLower = hedgeToken === 'token0' ? rawPriceLower : 1 / rawPriceUpper;
    const priceUpper = hedgeToken === 'token0' ? rawPriceUpper : 1 / rawPriceLower;

    // Push data to dashboard
    getStoreForUser(this.userId).update({
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
      lpPnlUsd: pnl.lpPnlUsd,
      lpFeesUsd: pnl.lpFeesUsd,
      cumulativeFundingUsd: pnl.cumulativeFundingUsd,
      cumulativeHlFeesUsd: pnl.cumulativeHlFeesUsd,
      initialLpUsd: this.pnlTrackers[tokenId]?.getStateForPersist()?.initialLpUsd,
      initialTotalUsd: pnl.initialTotalUsd,
      currentTotalUsd: pnl.currentTotalUsd,
      hlEquity,
      fee: ps.config.fee,
      priceLower,
      priceUpper,
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
        const rateLimitChecks = (isForcedClose || isForcedHedge) ? [] : [
          checkMinNotional(changeUsd),
          checkDailyLimit(ps.dailyRebalanceCount),
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
    const rebalanceLabel = isForcedClose ? 'FORCED CLOSE' : isForcedHedge ? 'FORCED HEDGE' : liquidityChangeReason !== null ? 'LIQUIDITY REBALANCE' : isEmergency ? 'EMERGENCY REBALANCE' : 'REBALANCING';
    logger.info(
      `[NFT#${tokenId}] ${rebalanceLabel} [trigger: ${triggerReason}]: ` +
      `${currentHedge.size.toFixed(4)} → ${effectiveSize.toFixed(4)} ` +
      `($${currentHedge.notionalUsd.toFixed(2)} → $${effectiveNotional.toFixed(2)})`
    );

    let fillResult: FillResult | null = null;
    try {
      if (effectiveSize <= 0) {
        fillResult = await this.exchange.closePosition(hedgeSymbol);
      } else {
        fillResult = await this.exchange.setPosition(hedgeSymbol, effectiveSize, effectiveNotional);
      }
    } catch (exchangeErr) {
      logger.error(`[NFT#${tokenId}] Exchange error — rebalance aborted, state unchanged: ${exchangeErr}`);
      return; // do NOT update state, cooldown or insert to Supabase
    }

    // Per-trade closed PnL using HL entryPx as ground truth
    const sizeChange = effectiveSize - currentHedge.size;
    const entryPx = currentHedge.avgEntryPrice ?? position.price;
    const closedSz = sizeChange < 0 ? Math.min(currentHedge.size, Math.abs(sizeChange)) : 0;
    const tradePnlUsd = closedSz > 0 ? (entryPx - (fillResult?.avgPx ?? position.price)) * closedSz : 0;

    const executedNotionalUsd = fillResult ? fillResult.sz * fillResult.avgPx : 0;
    const feeUsd = executedNotionalUsd * config.hlTakerFee;
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
      coin: hedgeSymbol,
      action: fillResult?.action ?? undefined,
      avgPx: fillResult?.avgPx ?? undefined,
      tradeValueUsd: executedNotionalUsd || undefined,
      feeUsd: feeUsd || undefined,
      triggerReason: triggerReason ?? undefined,
      token0Symbol: position.token0.symbol,
      token1Symbol: position.token1.symbol,
      isEmergency,
    };
    getStoreForUser(this.userId).addRebalanceEvent(event);

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
    this.lastRangeStatusMap[tokenId] = position.rangeStatus;

    // Persist to Supabase (fire-and-forget)
    void insertRebalance({
      user_id: this.userId !== 'default' ? this.userId : undefined,
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

  // Computes LP value in USD for a given liquidity at the current price/tick.
  // Mirrors computeAmountsFromTicks in uniswapReader but works with plain numbers.
  private computeLpUsd(
    liquidity: bigint,
    position: LPPosition,
    hedgeToken: 'token0' | 'token1',
    volatilePriceUsd: number
  ): number {
    const sqrtCurrent = Math.sqrt(Math.pow(1.0001, position.tickCurrent));
    const sqrtLower   = Math.sqrt(Math.pow(1.0001, position.tickLower));
    const sqrtUpper   = Math.sqrt(Math.pow(1.0001, position.tickUpper));
    const liq = Number(liquidity);
    let amount0 = 0;
    let amount1 = 0;
    if (position.tickCurrent < position.tickLower) {
      amount0 = liq * (1 / sqrtLower - 1 / sqrtUpper);
    } else if (position.tickCurrent >= position.tickUpper) {
      amount1 = liq * (sqrtUpper - sqrtLower);
    } else {
      amount0 = liq * (1 / sqrtCurrent - 1 / sqrtUpper);
      amount1 = liq * (sqrtCurrent - sqrtLower);
    }
    const amt0F = amount0 / Math.pow(10, position.token0.decimals);
    const amt1F = amount1 / Math.pow(10, position.token1.decimals);
    const t0Usd = hedgeToken === 'token0' ? amt0F * position.price : amt0F;
    const t1Usd = hedgeToken === 'token1' ? amt1F * volatilePriceUsd : amt1F;
    return t0Usd + t1Usd;
  }

  private checkEmergencyPriceMovement(
    tokenId: PositionId,
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


  private checkTimeRebalance(
    tokenId: PositionId,
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

  private logTimeUntilNextRebalance(tokenId: PositionId, ps: PositionState, intervalMin: number): void {
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
