import path from 'path';
import { loadFromLogs, loadFromCsv } from '../backtest/dataLoader';
import { analyze, AnalysisResult, DayStats, Anomaly } from './analyzer';

// --- CLI args ---
const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const logDir    = getArg('--logs') || path.resolve(__dirname, '..', '..', 'logs');
const dateFilter = getArg('--date');
const csvFile   = getArg('--csv');
const feeRate   = parseFloat(getArg('--fee') || '0.000432');

// --- Load data ---
console.log('Loading data...');
const ticks = csvFile
  ? loadFromCsv(csvFile)
  : loadFromLogs(logDir, dateFilter);

if (ticks.length === 0) {
  console.error('No tick data found. Check --logs / --date / --csv arguments.');
  process.exit(1);
}

const first = new Date(ticks[0].timestamp).toISOString();
const last  = new Date(ticks[ticks.length - 1].timestamp).toISOString();
console.log(`Loaded ${ticks.length} ticks  ${first}  →  ${last}`);
console.log();

// --- Run analysis ---
const result: AnalysisResult = analyze(ticks, feeRate);

// --- Formatting helpers ---
function pad(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}
function padL(s: string, len: number): string {
  return s.length >= len ? s : ' '.repeat(len - s.length) + s;
}
function fmt(v: number, sign = true): string {
  const s = v.toFixed(2);
  return sign && v > 0 ? '+' + s : s;
}
function pct(v: number): string {
  return v.toFixed(1) + '%';
}

// ─────────────────────────────────────────────
// SECTION 1 — Overall Summary
// ─────────────────────────────────────────────
const durationDays = (result.periodEnd - result.periodStart) / 86_400_000;

console.log('━'.repeat(62));
console.log('  ANÁLISE DE DESEMPENHO REAL DO BOT');
console.log('━'.repeat(62));
console.log(`  Período   : ${new Date(result.periodStart).toISOString().slice(0, 10)}  →  ${new Date(result.periodEnd).toISOString().slice(0, 10)}  (${durationDays.toFixed(1)}d)`);
console.log(`  Ciclos    : ${result.totalTicks}`);
console.log(`  Tempo em range : ${pct(result.inRangePct)}`);
console.log();

console.log('  ── Delta Hedging ───────────────────────────────');
console.log(`  Avg Delta Gap   : ${pct(result.avgDeltaGapPct)}   (ideal: <5%)`);
console.log(`  Max Delta Gap   : ${pct(result.maxDeltaGapPct)}`);
console.log(`  Rebalances total: ${result.totalRebalances}   (~${durationDays > 0 ? (result.totalRebalances / durationDays).toFixed(1) : 'N/A'}/dia)`);
console.log();

console.log('  ── P&L Breakdown ($) ──────────────────────────');
console.log(`  LP Value P&L    : ${fmt(result.totalLpPnlUsd)}`);
console.log(`  HL Mark-to-Mkt  : ${fmt(result.totalHlMtmPnlUsd)}`);
console.log(`  Funding P&L     : ${fmt(result.totalFundingPnlUsd)}`);
console.log(`  HL Fees (custo) : -${result.totalEstimatedFeesUsd.toFixed(2)}`);
console.log('  ' + '─'.repeat(30));
console.log(`  Net P&L         : ${fmt(result.totalNetPnlUsd)}`);
console.log(`  Max Drawdown    : -${result.maxDrawdownUsd.toFixed(2)}`);
console.log();

// Diagnóstico rápido
const fundingVsFees = result.totalFundingPnlUsd - result.totalEstimatedFeesUsd;
console.log('  ── Diagnóstico ─────────────────────────────────');
if (result.avgDeltaGapPct > 10) {
  console.log('  [!] Delta gap alto — hedge não acompanha a posição');
} else {
  console.log('  [ok] Delta hedging dentro do esperado');
}
if (fundingVsFees < 0) {
  console.log(`  [!] Funding (${fmt(result.totalFundingPnlUsd)}) não cobre fees (${result.totalEstimatedFeesUsd.toFixed(2)}) — overtrading ou funding muito negativo`);
} else {
  console.log(`  [ok] Funding cobre fees (+${fundingVsFees.toFixed(2)} líquido)`);
}
if (result.inRangePct < 50) {
  console.log(`  [!] Posição ficou ${pct(100 - result.inRangePct)} do tempo fora do range`);
} else {
  console.log(`  [ok] ${pct(result.inRangePct)} do tempo in-range`);
}
console.log();

// ─────────────────────────────────────────────
// SECTION 2 — Daily Table
// ─────────────────────────────────────────────
const cols = {
  date: 12,
  ticks: 6,
  inRange: 8,
  avgGap: 8,
  maxGap: 8,
  rebals: 7,
  fees: 8,
  funding: 9,
  lpPnl: 10,
  hlMtm: 10,
  net: 11,
};

const sepParts = Object.values(cols).map(w => '-'.repeat(w));
const sep = '+-' + sepParts.join('-+-') + '-+';

console.log('  RESUMO DIÁRIO');
console.log(sep);
console.log(
  `| ${pad('Date', cols.date)} | ${padL('Ticks', cols.ticks)} |` +
  ` ${padL('InRange', cols.inRange)} |` +
  ` ${padL('AvgGap', cols.avgGap)} |` +
  ` ${padL('MaxGap', cols.maxGap)} |` +
  ` ${padL('Rebals', cols.rebals)} |` +
  ` ${padL('Fees$', cols.fees)} |` +
  ` ${padL('Fund$', cols.funding)} |` +
  ` ${padL('LP P&L$', cols.lpPnl)} |` +
  ` ${padL('HL MTM$', cols.hlMtm)} |` +
  ` ${padL('Net P&L$', cols.net)} |`,
);
console.log(sep);

for (const d of result.days) {
  console.log(
    `| ${pad(d.date, cols.date)} | ${padL(String(d.ticks), cols.ticks)} |` +
    ` ${padL(pct(d.inRangePct), cols.inRange)} |` +
    ` ${padL(pct(d.avgDeltaGapPct), cols.avgGap)} |` +
    ` ${padL(pct(d.maxDeltaGapPct), cols.maxGap)} |` +
    ` ${padL(String(d.rebalances), cols.rebals)} |` +
    ` ${padL(d.estimatedFeesUsd.toFixed(2), cols.fees)} |` +
    ` ${padL(fmt(d.fundingPnlUsd), cols.funding)} |` +
    ` ${padL(fmt(d.lpPnlUsd), cols.lpPnl)} |` +
    ` ${padL(fmt(d.hlMtmPnlUsd), cols.hlMtm)} |` +
    ` ${padL(fmt(d.netPnlUsd), cols.net)} |`,
  );
}

console.log(sep);
console.log();

// ─────────────────────────────────────────────
// SECTION 3 — Anomalies
// ─────────────────────────────────────────────
if (result.anomalies.length === 0) {
  console.log('  Nenhuma anomalia detectada.');
} else {
  console.log(`  ANOMALIAS DETECTADAS (${result.anomalies.length})`);
  console.log('  ' + '─'.repeat(70));
  const icons: Record<Anomaly['type'], string> = {
    HIGH_DELTA_GAP:    '[DELTA]',
    OUT_OF_RANGE_STREAK: '[RANGE]',
    NEGATIVE_FUNDING:  '[FUND ]',
    REBALANCE_BURST:   '[BURST]',
  };
  for (const a of result.anomalies) {
    const ts = new Date(a.timestamp).toISOString().replace('T', ' ').slice(0, 19);
    const sev = a.severity === 'CRIT' ? '!!' : ' !';
    console.log(`  ${sev} ${icons[a.type]} ${ts}  ${a.detail}`);
  }
}

console.log();
console.log('━'.repeat(62));
console.log('  Nota: fees estimadas via detecção de mudança em hedgeSize.');
console.log('  LP fees (tokensOwed) não incluídas — bot não as loga no CYCLE.');
console.log('━'.repeat(62));
console.log();
