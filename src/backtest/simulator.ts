import { TickData, BacktestConfig, BacktestResult, TradeRecord, IRebalanceStrategy } from './types';

/**
 * Compute target hedge size — pure replica of hedgeCalculator.ts logic
 * without importing the config singleton.
 */
function computeTargetHedge(
  tick: TickData,
  config: BacktestConfig,
): { targetSize: number; targetNotionalUsd: number } {
  const exposure = tick.token0Amount; // hedgeToken = token0
  const priceInQuote = tick.price;
  const notional = exposure * priceInQuote;

  let hedgeRatio: number;

  if (tick.rangeStatus === 'above-range') {
    hedgeRatio = 0;
  } else if (tick.rangeStatus === 'below-range') {
    hedgeRatio = 1.0;
  } else {
    // in-range: ratio based on funding
    if (tick.fundingRate >= 0) {
      hedgeRatio = 1.0;
    } else if (tick.fundingRate >= -0.0020) {
      hedgeRatio = 0.98;
    } else {
      hedgeRatio = 0.90;
    }
  }

  // Scale pelo alvo de cobertura do config (ex: 0.8 = 80% do delta)
  hedgeRatio *= config.hedgeRatio;

  // Apply floor (também escalado proporcionalmente)
  if (hedgeRatio > 0) {
    hedgeRatio = Math.max(hedgeRatio, config.hedgeFloor * config.hedgeRatio);
  }

  return {
    targetSize: exposure * hedgeRatio,
    targetNotionalUsd: notional * hedgeRatio,
  };
}

/**
 * Safety checks — pure replica of safety.ts logic using tick timestamps
 * instead of Date.now().
 */
function passesSafetyChecks(
  changeUsd: number,
  targetNotionalUsd: number,
  targetSize: number,
  currentSize: number,
  dailyCount: number,
  hourlyCount: number,
  lastRebalanceTs: number,
  tickTs: number,
  config: BacktestConfig,
): boolean {
  if (Math.abs(changeUsd) < config.minNotionalUsd) return false;
  if (Math.abs(targetSize - currentSize) < 1e-8) return false;
  if (dailyCount >= config.maxDailyRebalances) return false;
  if (hourlyCount >= config.maxHourlyRebalances) return false;
  const elapsedSec = (tickTs - lastRebalanceTs) / 1000;
  if (elapsedSec < config.cooldownSeconds) return false;
  return true;
}

/** Run a full backtest replay over tick data */
export function runBacktest(
  ticks: TickData[],
  strategy: IRebalanceStrategy,
  config: BacktestConfig,
): BacktestResult {
  if (ticks.length === 0) {
    return {
      label: config.label,
      totalTrades: 0,
      rangeTriggeredTrades: 0,
      strategyTriggeredTrades: 0,
      emergencyTrades: 0,
      totalFeesUsd: 0,
      lpValuePnlUsd: 0,
      hlMarkToMarketPnlUsd: 0,
      fundingPnlUsd: 0,
      lpFeesPnlUsd: 0,
      maxDrawdownUsd: 0,
      finalPnlUsd: 0,
      avgTimeBetweenTrades: 0,
      trades: [],
    };
  }

  // State
  let currentHedgeSize = ticks[0].hedgeSize; // start with the actual hedge from first tick
  let lastRebalanceTs = 0;
  let dailyCount = 0;
  let hourlyCount = 0;
  let dailyResetDate = '';
  let hourlyResetTs = 0;
  let lastRangeStatus: string | null = null;

  // P&L tracking — valores do tick anterior (antes do 1º intervalo)
  let prevPrice     = ticks[0].price;
  let prevTimestamp = ticks[0].timestamp;
  let prevLpUsd     = ticks[0].token0Amount * ticks[0].price + ticks[0].token1Amount;
  let prevLpFees    = ticks[0].lpFees0 * ticks[0].price + ticks[0].lpFees1;

  const trades: TradeRecord[] = [];
  let totalFeesUsd        = 0; // taxas de rebalanceamento pagas à HL
  let lpValuePnl          = 0; // Δ(token0*price + token1) tick a tick
  let hlMarkToMarketPnl   = 0; // short MTM: hedge * (prevPrice - price)
  let fundingPnl          = 0; // funding_rate * hedgeNotional * tempo
  let lpFeesPnl           = 0; // Δ(lpFees) tick a tick
  let maxDrawdownUsd      = 0;
  let peakPnl             = 0;

  for (const tick of ticks) {
    // Reset daily counter
    const tickDate = new Date(tick.timestamp).toISOString().split('T')[0];
    if (dailyResetDate !== tickDate) {
      dailyCount = 0;
      dailyResetDate = tickDate;
    }

    // Reset hourly counter
    if (hourlyResetTs === 0 || tick.timestamp - hourlyResetTs >= 3600_000) {
      hourlyCount = 0;
      hourlyResetTs = tick.timestamp;
    }

    // -----------------------------------------------------------
    // P&L do intervalo [prevTick → thisTick]
    // Usa o estado vigente ANTES de qualquer rebalanceamento deste tick.
    // -----------------------------------------------------------

    const currentLpUsd  = tick.token0Amount * tick.price + tick.token1Amount;
    const currentLpFees = tick.lpFees0 * tick.price + tick.lpFees1;
    const timeInHours   = (tick.timestamp - prevTimestamp) / 3_600_000;

    // 1. Variação do valor da LP (captura IL + efeito de preço nos dois tokens)
    lpValuePnl += currentLpUsd - prevLpUsd;

    // 2. Mark-to-market da posição short na HL
    //    Short lucra quando preço cai: hedge * (prevPrice - currentPrice)
    hlMarkToMarketPnl += currentHedgeSize * (prevPrice - tick.price);

    // 3. Funding rate (positivo = shorts recebem; negativo = shorts pagam)
    //    Usa notional em USD = hedgeSize * currentPrice
    fundingPnl += tick.fundingRate * currentHedgeSize * tick.price * timeInHours;

    // 4. LP fees acumuladas (zero enquanto o bot não logar tokensOwed)
    lpFeesPnl += currentLpFees - prevLpFees;

    // -----------------------------------------------------------
    // Compute target e decide rebalanceamento
    // -----------------------------------------------------------
    const { targetSize, targetNotionalUsd } = computeTargetHedge(tick, config);

    // --- Emergency check (bypassa cooldown) ---
    const emThreshold = config.emergencyMismatchThreshold;
    const emRatio     = config.emergencyHedgeRatio ?? 1.0;
    let handledByEmergency = false;

    if (emThreshold !== undefined && tick.price > 0) {
      const reference = targetSize > 0 ? targetSize : currentHedgeSize;
      if (reference > 0) {
        const mismatch = Math.abs(targetSize - currentHedgeSize) / reference;
        if (mismatch > emThreshold) {
          // Partial target: fecha emRatio do gap
          const emSize     = currentHedgeSize + (targetSize - currentHedgeSize) * emRatio;
          const emNotional = emSize * tick.price;
          const changeUsd  = Math.abs(emNotional - currentHedgeSize * tick.price);

          // Safety sem cooldown: minNotional, daily, hourly, duplicate
          const safeDup     = Math.abs(emSize - currentHedgeSize) >= 1e-8;
          const safeMin     = changeUsd >= config.minNotionalUsd;
          const safeDaily   = dailyCount < config.maxDailyRebalances;
          const safeHourly  = hourlyCount < config.maxHourlyRebalances;

          if (safeDup && safeMin && safeDaily && safeHourly) {
            const deltaTokens = Math.abs(emSize - currentHedgeSize);
            const deltaUsd    = deltaTokens * tick.price;
            const feeUsd      = deltaUsd * config.hlTakerFee;

            trades.push({
              timestamp: tick.timestamp,
              fromSize: currentHedgeSize,
              toSize: emSize,
              deltaUsd,
              feeUsd,
              price: tick.price,
              trigger: 'emergency',
            });

            totalFeesUsd    += feeUsd;
            currentHedgeSize = emSize;
            lastRebalanceTs  = tick.timestamp;
            dailyCount++;
            hourlyCount++;
            handledByEmergency = true;
          }
        }
      }
    }

    // --- Normal strategy check ---
    if (!handledByEmergency) {
      const wantsRebalance = strategy.shouldRebalance(
        tick, currentHedgeSize, targetSize, lastRebalanceTs, config,
      );
      const rangeChanged = lastRangeStatus !== null && lastRangeStatus !== tick.rangeStatus;

      if (wantsRebalance || rangeChanged) {
        const changeUsd = Math.abs(targetNotionalUsd - currentHedgeSize * tick.price);
        const safe = passesSafetyChecks(
          changeUsd, targetNotionalUsd, targetSize, currentHedgeSize,
          dailyCount, hourlyCount, lastRebalanceTs, tick.timestamp, config,
        );

        if (safe) {
          const deltaTokens = Math.abs(targetSize - currentHedgeSize);
          const deltaUsd    = deltaTokens * tick.price;
          const feeUsd      = deltaUsd * config.hlTakerFee;

          trades.push({
            timestamp: tick.timestamp,
            fromSize: currentHedgeSize,
            toSize: targetSize,
            deltaUsd,
            feeUsd,
            price: tick.price,
            trigger: rangeChanged && !wantsRebalance ? 'range' : 'strategy',
          });

          totalFeesUsd    += feeUsd;
          currentHedgeSize = targetSize;
          lastRebalanceTs  = tick.timestamp;
          dailyCount++;
          hourlyCount++;
        }
      }
    }

    // -----------------------------------------------------------
    // Drawdown sobre P&L total
    // -----------------------------------------------------------
    const totalPnl = lpValuePnl + hlMarkToMarketPnl + fundingPnl + lpFeesPnl - totalFeesUsd;
    if (totalPnl > peakPnl) peakPnl = totalPnl;
    const dd = peakPnl - totalPnl;
    if (dd > maxDrawdownUsd) maxDrawdownUsd = dd;

    lastRangeStatus = tick.rangeStatus;
    prevPrice       = tick.price;
    prevTimestamp   = tick.timestamp;
    prevLpUsd       = currentLpUsd;
    prevLpFees      = currentLpFees;
  }

  // Average time between trades
  let avgTimeBetween = 0;
  if (trades.length >= 2) {
    const totalTime = trades[trades.length - 1].timestamp - trades[0].timestamp;
    avgTimeBetween = totalTime / (trades.length - 1) / 1000; // seconds
  }

  return {
    label: config.label,
    totalTrades: trades.length,
    rangeTriggeredTrades:    trades.filter(t => t.trigger === 'range').length,
    strategyTriggeredTrades: trades.filter(t => t.trigger === 'strategy').length,
    emergencyTrades:         trades.filter(t => t.trigger === 'emergency').length,
    totalFeesUsd,
    lpValuePnlUsd:        lpValuePnl,
    hlMarkToMarketPnlUsd: hlMarkToMarketPnl,
    fundingPnlUsd:        fundingPnl,
    lpFeesPnlUsd:         lpFeesPnl,
    maxDrawdownUsd,
    finalPnlUsd: lpValuePnl + hlMarkToMarketPnl + fundingPnl + lpFeesPnl - totalFeesUsd,
    avgTimeBetweenTrades: avgTimeBetween,
    trades,
  };
}
