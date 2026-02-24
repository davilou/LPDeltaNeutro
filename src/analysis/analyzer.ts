import { TickData } from '../backtest/types';

export interface DayStats {
  date: string;
  ticks: number;
  inRangePct: number;
  avgDeltaGapPct: number;
  maxDeltaGapPct: number;
  rebalances: number;
  estimatedFeesUsd: number;
  fundingPnlUsd: number;
  lpPnlUsd: number;
  hlMtmPnlUsd: number;
  netPnlUsd: number;
}

export interface Anomaly {
  timestamp: number;
  date: string;
  type: 'HIGH_DELTA_GAP' | 'OUT_OF_RANGE_STREAK' | 'NEGATIVE_FUNDING' | 'REBALANCE_BURST';
  severity: 'WARN' | 'CRIT';
  detail: string;
}

export interface AnalysisResult {
  periodStart: number;
  periodEnd: number;
  totalTicks: number;
  inRangePct: number;
  /** Avg |netDelta| / token0Amount across all ticks */
  avgDeltaGapPct: number;
  maxDeltaGapPct: number;
  totalRebalances: number;
  totalEstimatedFeesUsd: number;
  totalFundingPnlUsd: number;
  totalLpPnlUsd: number;
  totalHlMtmPnlUsd: number;
  totalNetPnlUsd: number;
  maxDrawdownUsd: number;
  days: DayStats[];
  anomalies: Anomaly[];
}

const REBALANCE_MIN_CHANGE = 0.001; // hedgeSize delta threshold to count as rebalance

function utcDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Analyzes actual bot performance from log-derived tick data.
 * Unlike the backtest (which simulates strategies), this measures what the bot really did.
 */
export function analyze(ticks: TickData[], hlTakerFee: number): AnalysisResult {
  if (ticks.length === 0) {
    return {
      periodStart: 0, periodEnd: 0, totalTicks: 0,
      inRangePct: 0, avgDeltaGapPct: 0, maxDeltaGapPct: 0,
      totalRebalances: 0, totalEstimatedFeesUsd: 0,
      totalFundingPnlUsd: 0, totalLpPnlUsd: 0, totalHlMtmPnlUsd: 0,
      totalNetPnlUsd: 0, maxDrawdownUsd: 0,
      days: [], anomalies: [],
    };
  }

  const days: DayStats[] = [];
  const anomalies: Anomaly[] = [];

  // Anomaly tracking state (persists across days)
  let consecutiveHighDelta = 0;
  let consecutiveOutOfRange = 0;
  let lastNegFundingAnomalyTs = -Infinity;
  let lastHighDeltaAnomalyTs = -Infinity;   // 1h debounce
  let lastOutOfRangeAnomalyTs = -Infinity;  // 2h debounce
  let lastBurstAnomalyTs = -Infinity;       // 30min debounce
  const rebalanceTsWindow: number[] = []; // rolling list for burst detection

  // Drawdown tracking over full period
  let cumulativePnl = 0;
  let peak = 0;
  let maxDrawdown = 0;

  // Overall aggregation
  let totalInRange = 0;
  let totalDeltaGapSum = 0;
  let totalMaxDeltaGap = 0;
  let totalRebalances = 0;
  let totalFees = 0;
  let totalFunding = 0;
  let totalLpPnl = 0;
  let totalHlMtm = 0;

  // Group ticks by UTC date
  const byDay = new Map<string, TickData[]>();
  for (const tick of ticks) {
    const d = utcDate(tick.timestamp);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(tick);
  }

  for (const [date, dayTicks] of [...byDay.entries()].sort()) {
    let inRangeCount = 0;
    let deltaGapSum = 0;
    let dayMaxDeltaGap = 0;
    let dayRebalances = 0;
    let dayFees = 0;
    let dayFunding = 0;
    let dayHlMtm = 0;

    const firstTick = dayTicks[0];
    const lastTick = dayTicks[dayTicks.length - 1];
    const dayLpPnl =
      (lastTick.token0Amount * lastTick.price + lastTick.token1Amount) -
      (firstTick.token0Amount * firstTick.price + firstTick.token1Amount);

    for (let i = 0; i < dayTicks.length; i++) {
      const tick = dayTicks[i];
      const prev = i > 0 ? dayTicks[i - 1] : null;

      if (tick.rangeStatus === 'in-range') inRangeCount++;

      // Delta gap: |LP exposure - hedge| / LP exposure
      const exposure = tick.token0Amount;
      const deltaGap = exposure > 0 ? Math.abs(exposure - tick.hedgeSize) / exposure : 0;
      deltaGapSum += deltaGap;
      if (deltaGap > dayMaxDeltaGap) dayMaxDeltaGap = deltaGap;
      if (deltaGap > totalMaxDeltaGap) totalMaxDeltaGap = deltaGap;
      totalDeltaGapSum += deltaGap;

      if (prev) {
        // Rebalance detection: significant change in hedge size
        const hedgeDelta = Math.abs(tick.hedgeSize - prev.hedgeSize);
        if (hedgeDelta > REBALANCE_MIN_CHANGE) {
          const feeUsd = hedgeDelta * tick.price * hlTakerFee;
          dayFees += feeUsd;
          dayRebalances++;
          rebalanceTsWindow.push(tick.timestamp);
          // Keep window to last 10 entries
          if (rebalanceTsWindow.length > 10) rebalanceTsWindow.shift();
        }

        // Funding P&L: fundingRate * notionalUsd * dt_hours
        const dtHours = (tick.timestamp - prev.timestamp) / 3_600_000;
        const notionalUsd = tick.hedgeSize * tick.price;
        dayFunding += tick.fundingRate * notionalUsd * dtHours;

        // HL MTM: short gains when price falls
        dayHlMtm += prev.hedgeSize * (prev.price - tick.price);
      }

      // --- Anomaly detection ---

      // HIGH_DELTA_GAP: flag on 5th consecutive tick above 15%, debounce 1h
      if (deltaGap > 0.15) {
        consecutiveHighDelta++;
        if (consecutiveHighDelta === 5) {
          const hoursSince = (tick.timestamp - lastHighDeltaAnomalyTs) / 3_600_000;
          if (hoursSince > 1) {
            anomalies.push({
              timestamp: tick.timestamp,
              date,
              type: 'HIGH_DELTA_GAP',
              severity: deltaGap > 0.30 ? 'CRIT' : 'WARN',
              detail: `Delta gap ${(deltaGap * 100).toFixed(1)}% por 5+ ciclos consecutivos`,
            });
            lastHighDeltaAnomalyTs = tick.timestamp;
          }
          consecutiveHighDelta = 0; // reset para não re-disparar sem debounce
        }
      } else {
        consecutiveHighDelta = 0;
      }

      // OUT_OF_RANGE_STREAK: flag on 10th consecutive tick out of range, debounce 2h
      if (tick.rangeStatus !== 'in-range') {
        consecutiveOutOfRange++;
        if (consecutiveOutOfRange === 10) {
          const hoursSince = (tick.timestamp - lastOutOfRangeAnomalyTs) / 3_600_000;
          if (hoursSince > 2) {
            anomalies.push({
              timestamp: tick.timestamp,
              date,
              type: 'OUT_OF_RANGE_STREAK',
              severity: 'WARN',
              detail: `10+ ciclos consecutivos fora do range (${tick.rangeStatus})`,
            });
            lastOutOfRangeAnomalyTs = tick.timestamp;
          }
          consecutiveOutOfRange = 0; // reset para não re-disparar sem debounce
        }
      } else {
        consecutiveOutOfRange = 0;
      }

      // NEGATIVE_FUNDING: rate < -0.1%, debounce 4h between anomalies
      if (tick.fundingRate < -0.001) {
        const hoursSinceLastAnomaly = (tick.timestamp - lastNegFundingAnomalyTs) / 3_600_000;
        if (hoursSinceLastAnomaly > 4) {
          anomalies.push({
            timestamp: tick.timestamp,
            date,
            type: 'NEGATIVE_FUNDING',
            severity: tick.fundingRate < -0.005 ? 'CRIT' : 'WARN',
            detail: `Funding negativo: ${(tick.fundingRate * 100).toFixed(4)}% — hedge pagando taxa`,
          });
          lastNegFundingAnomalyTs = tick.timestamp;
        }
      }

      // REBALANCE_BURST: 3 rebalances within 30 min, debounce 30min between alerts
      if (rebalanceTsWindow.length >= 3) {
        const newest = rebalanceTsWindow[rebalanceTsWindow.length - 1];
        const third = rebalanceTsWindow[rebalanceTsWindow.length - 3];
        const windowMin = (newest - third) / 60_000;
        const minSinceBurst = (newest - lastBurstAnomalyTs) / 60_000;
        if (windowMin <= 30 && minSinceBurst > 30 && newest === tick.timestamp) {
          anomalies.push({
            timestamp: tick.timestamp,
            date,
            type: 'REBALANCE_BURST',
            severity: 'WARN',
            detail: `3 rebalances em ${windowMin.toFixed(0)}min — possível overtrading`,
          });
          lastBurstAnomalyTs = newest;
        }
      }
    }

    const dayNetPnl = dayLpPnl + dayHlMtm + dayFunding - dayFees;
    cumulativePnl += dayNetPnl;
    if (cumulativePnl > peak) peak = cumulativePnl;
    const drawdown = peak - cumulativePnl;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    totalInRange += inRangeCount;
    totalRebalances += dayRebalances;
    totalFees += dayFees;
    totalFunding += dayFunding;
    totalLpPnl += dayLpPnl;
    totalHlMtm += dayHlMtm;

    days.push({
      date,
      ticks: dayTicks.length,
      inRangePct: (inRangeCount / dayTicks.length) * 100,
      avgDeltaGapPct: (deltaGapSum / dayTicks.length) * 100,
      maxDeltaGapPct: dayMaxDeltaGap * 100,
      rebalances: dayRebalances,
      estimatedFeesUsd: dayFees,
      fundingPnlUsd: dayFunding,
      lpPnlUsd: dayLpPnl,
      hlMtmPnlUsd: dayHlMtm,
      netPnlUsd: dayNetPnl,
    });
  }

  const totalTicks = ticks.length;

  return {
    periodStart: ticks[0].timestamp,
    periodEnd: ticks[totalTicks - 1].timestamp,
    totalTicks,
    inRangePct: (totalInRange / totalTicks) * 100,
    avgDeltaGapPct: (totalDeltaGapSum / totalTicks) * 100,
    maxDeltaGapPct: totalMaxDeltaGap * 100,
    totalRebalances,
    totalEstimatedFeesUsd: totalFees,
    totalFundingPnlUsd: totalFunding,
    totalLpPnlUsd: totalLpPnl,
    totalHlMtmPnlUsd: totalHlMtm,
    totalNetPnlUsd: totalLpPnl + totalHlMtm + totalFunding - totalFees,
    maxDrawdownUsd: maxDrawdown,
    days,
    anomalies,
  };
}
