import path from 'path';
import { loadFromLogs, loadFromCsv } from './dataLoader';
import { runBacktest } from './simulator';
import { ThresholdStrategy } from './strategies/thresholdStrategy';
import { TimeBasedStrategy } from './strategies/timeBasedStrategy';
import { BandStrategy } from './strategies/bandStrategy';
import { HybridStrategy } from './strategies/hybridStrategy';
import { printReport } from './reporter';
import { BacktestConfig, BacktestResult } from './types';

// --- CLI args ---
const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const logDir = getArg('--logs') || path.resolve(__dirname, '..', '..', 'logs');
const dateFilter = getArg('--date');
const csvFile = getArg('--csv');

// --- Load data ---
console.log(`Loading data...`);
const ticks = csvFile
  ? loadFromCsv(csvFile)
  : loadFromLogs(logDir, dateFilter);

if (ticks.length === 0) {
  console.error('No tick data found. Check --logs / --date / --csv arguments.');
  process.exit(1);
}

const first = new Date(ticks[0].timestamp).toISOString();
const last = new Date(ticks[ticks.length - 1].timestamp).toISOString();
console.log(`Loaded ${ticks.length} ticks from ${first} to ${last}`);

// --- Base config (mirrors current production) ---
const baseConfig: Omit<BacktestConfig, 'label' | 'deltaMismatchThreshold'> = {
  hedgeFloor: 0.90,
  hedgeRatio: 1.0,
  rebalanceIntervalMin: 240,    // 4h — config atual
  maxDailyRebalances: 150,
  minRebalanceUsd: 10,
  minNotionalUsd: 10,
  hlTakerFee: 0.000432,
};

const results: BacktestResult[] = [];

// ─────────────────────────────────────────────────────────────────
// REFERÊNCIA: sem emergency
// ─────────────────────────────────────────────────────────────────
results.push(runBacktest(ticks, new TimeBasedStrategy(4 * 3600), {
  ...baseConfig,
  deltaMismatchThreshold: 1.0,
  label: '4h-no-emergency',
}));

// ─────────────────────────────────────────────────────────────────
// EMT 75% — hedge ratio: 50%, 75%, 100%
// ─────────────────────────────────────────────────────────────────
for (const emR of [0.50, 0.75, 1.00]) {
  results.push(runBacktest(ticks, new TimeBasedStrategy(4 * 3600), {
    ...baseConfig,
    deltaMismatchThreshold: 1.0,
    emergencyMismatchThreshold: 0.75,
    emergencyHedgeRatio: emR,
    label: `em75%+r${(emR * 100).toFixed(0)}%`,
  }));
}

// ─────────────────────────────────────────────────────────────────
// EMT 100% — hedge ratio: 50%, 75%, 100%
// ─────────────────────────────────────────────────────────────────
for (const emR of [0.50, 0.75, 1.00]) {
  results.push(runBacktest(ticks, new TimeBasedStrategy(4 * 3600), {
    ...baseConfig,
    deltaMismatchThreshold: 1.0,
    emergencyMismatchThreshold: 1.00,
    emergencyHedgeRatio: emR,
    label: `em100%+r${(emR * 100).toFixed(0)}%`,
  }));
}

// --- Report ---
printReport(results);
