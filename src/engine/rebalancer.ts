import { config } from '../config';
import { ActivePositionConfig, BotState, DiscoveredPosition, HedgeState, HistoricalPosition, LPPosition, PnlSnapshot, PositionState, PositionId } from '../types';
import { FillResult, HlIsolatedPnl, IHedgeExchange } from '../hedge/types';
import { calculateHedge, HedgeTarget } from '../hedge/hedgeCalculator';
import { insertRebalance } from '../db/supabase';
import { runAllSafetyChecks, checkMinNotional, checkMaxNotional, checkDuplicate, checkDailyLimit } from '../utils/safety';
import { logger, logCycle } from '../utils/logger';
import { withContext, generateCorrelationId, getLogContext } from '../utils/correlation';
import { rebalancesTotal, rebalanceErrorsTotal, hedgeExecutionDuration } from '../utils/metrics';
import { notifyCriticalError } from '../utils/alerts';
import { getStoreForUser } from '../dashboard/store';
import { PnlTracker } from '../pnl/tracker';
import fs from 'fs';
import path from 'path';

export class Rebalancer {
  private state: BotState;
  private exchange: IHedgeExchange | null;
  private lastRangeStatusMap: Record<string, string> = {};
  private pnlTrackers: Record<string, PnlTracker> = {};
  private readonly userId: string;
  private readonly email?: string;
  private readonly stateFile: string;

  constructor(exchange: IHedgeExchange | null, userId = 'default', email?: string) {
    this.exchange = exchange;
    this.userId = userId;
    this.email = email;
    const stateDir = process.env.DATA_DIR || path.resolve(__dirname, '..', '..');
    this.stateFile = path.join(stateDir, `state-${userId}.json`);
    this.state = this.loadState();

    // Restore PnlTrackers for all persisted positions
    for (const [tokenIdStr, posState] of Object.entries(this.state.positions)) {
      this.pnlTrackers[tokenIdStr] = new PnlTracker(posState.pnl);
    }
  }

  /** User label for structured logs: email when available, userId as fallback. */
  private get u(): string { return this.email ?? this.userId; }

  public get fullState(): BotState {
    return this.state;
  }

  private loadState(): BotState {
    try {
      // Migrate legacy state.json → state-{userId}.json on first run
      const legacyFile = path.join(path.dirname(this.stateFile), 'state.json');
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

  setExchange(exchange: IHedgeExchange | null): void {
    this.exchange = exchange;
    if (exchange) logger.info({ message: 'exchange.swapped', user: this.u });
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
    logger.info({ message: 'position.activated', user: this.u, nft_id: String(tokenId), hedge_symbol: hedgeSymbol, hedge_ratio: cfg.hedgeRatio ?? 1.0 });
  }

  updateConfig(tokenId: PositionId, cfg: ActivePositionConfig): void {
    if (this.state.positions[tokenId]) {
      this.state.positions[tokenId].config = cfg;
      this.saveState();
    }
  }

  deactivatePosition(tokenId: PositionId): void {
    if (this.state.positions[tokenId]) {
      delete this.state.positions[tokenId];
      delete this.pnlTrackers[tokenId];
      this.saveState();
      logger.info({ message: 'position.deactivated', user: this.u, nft_id: String(tokenId) });
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
    // Compute USD range from ticks (same formula as rebalancer cycle)
    const token0Dec = cfg.token0Decimals ?? 18;
    const token1Dec = cfg.token1Decimals ?? 6;
    const decimalAdj = Math.pow(10, token0Dec - token1Dec);
    const rawLo = Math.pow(1.0001, cfg.tickLower ?? 0) * decimalAdj;
    const rawHi = Math.pow(1.0001, cfg.tickUpper ?? 0) * decimalAdj;

    // Use explicitly calculated USD prices if available from scanner, otherwise estimate
    const priceLowerUsd = ps.pnl?.priceLowerUsd ?? (
      (cfg.token0Decimals != null && cfg.token1Decimals != null)
        ? (cfg.hedgeToken === 'token1' ? 1 / rawHi : rawLo)
        : undefined
    );
    const priceUpperUsd = ps.pnl?.priceUpperUsd ?? (
      (cfg.token0Decimals != null && cfg.token1Decimals != null)
        ? (cfg.hedgeToken === 'token1' ? 1 / rawLo : rawHi)
        : undefined
    );
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
      priceLowerUsd,
      priceUpperUsd,
      activationId: cfg.activationId,
    };

    if (!this.state.history) this.state.history = [];
    this.state.history.push(record);
    this.saveState();

    logger.info({ message: 'position.archived', user: this.u, nft_id: String(tokenId), pnl_usd: +finalPnl.virtualPnlUsd.toFixed(2), pnl_pct: +finalPnl.virtualPnlPercent.toFixed(2) });
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
    } catch (err) {
      logger.error(`Failed to save state: ${err}`);
    }
  }

  saveScannedPositions(
    positions: DiscoveredPosition[],
    network: 'evm' | 'solana',
    wallet: string,
  ): void {
    this.state.scannedPositions = positions;
    this.state.scannedAt = Date.now();
    this.state.scannedNetwork = network;
    this.state.scannedWallet = wallet;
    this.saveState();
  }

  getScannedPositions(): {
    positions: DiscoveredPosition[];
    scannedAt?: number;
    scannedNetwork?: 'evm' | 'solana';
    scannedWallet?: string;
  } {
    return {
      positions: this.state.scannedPositions ?? [],
      scannedAt: this.state.scannedAt,
      scannedNetwork: this.state.scannedNetwork,
      scannedWallet: this.state.scannedWallet,
    };
  }

  getState(): BotState {
    return this.state;
  }

  async cycle(tokenId: PositionId, position: LPPosition): Promise<void> {
    if (!this.exchange) {
      throw new Error(`[Rebalancer] No exchange configured — cannot run cycle for NFT #${tokenId}. User must set HL credentials first.`);
    }
    const ps = this.state.positions[tokenId];
    if (!ps) {
      logger.warn({ message: 'cycle.no_state', user: this.u, nft_id: String(tokenId) });
      return;
    }

    // Capture exchange ref for use inside withContext (TS can't narrow `this.exchange` across closures)
    const exchange = this.exchange;

    const correlationId = generateCorrelationId('reb');
    return withContext({ correlationId }, async () => {

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
    }

    // Get funding rate
    const fundingRate = await exchange.getFundingRate(hedgeSymbol);

    // Calculate target hedge (uses global config for hedgeToken/hedgeFloor, we override below)
    const target: HedgeTarget = calculateHedge(position, fundingRate, hedgeToken);

    // Apply per-position hedgeRatio override
    target.size *= hedgeRatio;
    target.notionalUsd *= hedgeRatio;

    // Get current hedge position for this symbol
    const currentHedge = await exchange.getPosition(hedgeSymbol);

    // Forced close: LP saiu do range (100% stablecoin para token0, 100% volátil para token1)
    const rangeRequiresClose =
      (hedgeToken === 'token0' && position.rangeStatus === 'above-range') ||
      (hedgeToken === 'token1' && position.rangeStatus === 'below-range');
    const isForcedClose = rangeRequiresClose && currentHedge.size > 0;
    // Forced hedge: LP abaixo do range (100% token volátil), aumenta hedge até o target imediatamente
    const isForcedHedge = position.rangeStatus === 'below-range' && target.size > currentHedge.size + 1e-8;

    // Range re-entry: LP voltou ao range e temos hedge anterior salvo — restaurar
    const isRangeReEntry = position.rangeStatus === 'in-range' && ps.preExitHedge !== undefined;

    // Salvar hedge atual antes de ajustar por saída do range (apenas na primeira saída)
    if ((isForcedClose || isForcedHedge) && !ps.preExitHedge) {
      ps.preExitHedge = { ...ps.lastHedge };
      logger.info({ message: 'range.exit_hedge_saved', user: this.u, nft_id: String(tokenId),
        saved_size: ps.lastHedge.size, saved_notional: ps.lastHedge.notionalUsd, range_status: position.rangeStatus });
    }

    // Detect liquidity change early — used as a bypass-cooldown trigger
    const liquidityChanged = ps.lastLiquidity !== undefined && ps.lastLiquidity !== position.liquidity.toString();

    const lastRebalancePrice = ps.lastRebalancePrice ?? 0;

    // Check triggers — cada um retorna reason string ou null
    const rangeReEntryReason = isRangeReEntry
      ? `range re-entry: restoring pre-exit hedge (size=${ps.preExitHedge!.size.toFixed(4)}, notional=${ps.preExitHedge!.notionalUsd.toFixed(2)})`
      : null;
    const emergencyReason = !isForcedClose && !isForcedHedge && !isRangeReEntry && !liquidityChanged
      ? this.checkEmergencyPriceMovement(tokenId, position.price, lastRebalancePrice, emergencyPriceMovThreshold)
      : null;
    const timeReason = !isForcedClose && !isForcedHedge && !isRangeReEntry && !liquidityChanged && !emergencyReason
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

    const triggerReason = forcedCloseReason ?? forcedHedgeReason ?? rangeReEntryReason ?? liquidityChangeReason ?? emergencyReason ?? timeReason ?? null;
    const isEmergency = isForcedClose || isForcedHedge || isRangeReEntry || liquidityChangeReason !== null || emergencyReason !== null;
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
      logger.error({ message: 'cycle.insane_price', user: this.u, nft_id: String(tokenId), volatile_usd: volatilePriceUsd, raw_price: position.price });
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
      logger.warn({ message: 'liquidity.changed', user: this.u, nft_id: String(tokenId), from: ps.lastLiquidity, to: currLiqStr, baseline_adj_usd: +deltaLpUsd.toFixed(2) });
    }
    ps.lastLiquidity = currLiqStr;

    // PnL tracking
    const hlEquity = await exchange.getAccountEquity();
    const pnlTracker = this.getPnlTracker(tokenId);

    const initialTimestamp = ps.pnl?.initialTimestamp ?? Date.now();
    const isolatedPnlFromApi = await exchange.getIsolatedPnl(hedgeSymbol, initialTimestamp);
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

    if (!needsRebalance) {
      const elapsedMs = Date.now() - ps.lastRebalanceTimestamp;
      const remainingMs = rebalanceIntervalMin * 60_000 - elapsedMs;
      const nextMin = remainingMs > 0 ? Math.ceil(remainingMs / 60_000) : 0;
      logger.info({ message: 'rebalance.skipped', user: this.u, nft_id: String(tokenId),
        pool: `${position.token0.symbol}/${position.token1.symbol}`, coin: hedgeSymbol, next_rebalance_min: nextMin });
      this.lastRangeStatusMap[tokenId] = position.rangeStatus;
      ps.lastPrice = position.price;
      return;
    }

    // Range re-entry: usar hedge salvo antes da saída do range em vez do target calculado
    const effectiveSize = isRangeReEntry ? ps.preExitHedge!.size : target.size;
    const effectiveNotional = isRangeReEntry ? ps.preExitHedge!.notionalUsd : target.notionalUsd;

    // Run safety checks — emergency bypasses cooldown; forced close also bypasses daily/hourly limits and minNotional
    const changeUsd = Math.abs(effectiveNotional - currentHedge.notionalUsd);
    const safetyResult = isEmergency
      ? (() => {
        const baseChecks = [
          checkMaxNotional(effectiveNotional),
          checkDuplicate(effectiveSize, currentHedge.size),
        ];
        const rateLimitChecks = (isForcedClose || isForcedHedge || isRangeReEntry) ? [] : [
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
      logger.info({ message: 'rebalance.blocked', user: this.u, nft_id: String(tokenId),
        pool: `${position.token0.symbol}/${position.token1.symbol}`, coin: hedgeSymbol, reason: safetyResult.reason });
      this.lastRangeStatusMap[tokenId] = position.rangeStatus;
      ps.lastPrice = position.price;
      return;
    }

    // Execute rebalance
    const triggerLabel = isForcedClose ? 'forced_close'
      : isForcedHedge ? 'forced_hedge'
      : isRangeReEntry ? 'range_reentry'
      : liquidityChangeReason ? 'liquidity_change'
      : emergencyReason ? 'emergency'
      : 'timer';

    let fillResult: FillResult | null = null;
    try {
      const logCtx = getLogContext();
      const endHedgeTimer = hedgeExecutionDuration.startTimer({
        chain: logCtx.chain ?? 'unknown',
        dex: logCtx.dex ?? 'unknown',
      });
      if (effectiveSize <= 0) {
        fillResult = await exchange.closePosition(hedgeSymbol);
      } else {
        fillResult = await exchange.setPosition(hedgeSymbol, effectiveSize, effectiveNotional);
      }
      endHedgeTimer();
    } catch (exchangeErr) {
      const logCtx = getLogContext();
      logger.error({ message: 'rebalance.error', user: this.u, nft_id: String(tokenId), error: String(exchangeErr), severity: 'critical' });
      rebalanceErrorsTotal.inc({
        userId: logCtx.userId ?? 'unknown',
        chain: logCtx.chain ?? 'unknown',
        dex: logCtx.dex ?? 'unknown',
        severity: 'critical',
      });
      void notifyCriticalError(correlationId, exchangeErr);
      throw exchangeErr; // propagate so callers (activation, timer, poller) can react
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
      fundingUsd: pnl.cumulativeFundingUsd,
      realizedPnlUsd: pnl.realizedVirtualPnlUsd,
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

    // Limpar preExitHedge após restauração bem-sucedida do range re-entry
    if (isRangeReEntry) {
      logger.info({ message: 'range.reentry_restored', user: this.u, nft_id: String(tokenId),
        restored_size: effectiveSize, restored_notional: effectiveNotional });
      delete ps.preExitHedge;
    }

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
      activation_id: cfg.activationId ?? null,
    });

    logger.info({ message: 'rebalance.complete', user: this.u, nft_id: String(tokenId),
      pool: `${position.token0.symbol}/${position.token1.symbol}`, coin: hedgeSymbol,
      type: triggerLabel, trigger: triggerReason,
      from_size: +currentHedge.size.toFixed(4), to_size: +effectiveSize.toFixed(4),
      from_notional_usd: +currentHedge.notionalUsd.toFixed(2), to_notional_usd: +effectiveNotional.toFixed(2),
      fill: fillResult ? { action: fillResult.action, sz: fillResult.sz, avg_px: fillResult.avgPx } : null,
      daily_count: ps.dailyRebalanceCount,
    });

    const logCtx = getLogContext();
    rebalancesTotal.inc({
      userId: logCtx.userId ?? 'unknown',
      chain: logCtx.chain ?? 'unknown',
      dex: logCtx.dex ?? 'unknown',
      trigger: triggerLabel,
    });

    this.saveState();

    }); // end withContext
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
    const sqrtLower = Math.sqrt(Math.pow(1.0001, position.tickLower));
    const sqrtUpper = Math.sqrt(Math.pow(1.0001, position.tickUpper));
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
      return `emergency: price moved ${(movement * 100).toFixed(2)}% ($${lastRebalancePrice.toFixed(4)} → $${currentPrice.toFixed(4)}), cooldown bypassed`;
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

    return `timer: ${(elapsedMs / 60000).toFixed(1)}min elapsed ≥ ${intervalMin}min interval`;
  }


}
