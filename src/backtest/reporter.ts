import { BacktestResult } from './types';

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(0)}min`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

function padLeft(s: string, len: number): string {
  return s.length >= len ? s : ' '.repeat(len - s.length) + s;
}

export function printReport(results: BacktestResult[]): void {
  if (results.length === 0) {
    console.log('No results to display.');
    return;
  }

  // Colunas:
  // Strategy | Trades(rng/str) | HL Fees | LP P&L | HL MTM | Funding | Net PnL | MaxDD | AvgGap
  const cols = {
    strategy: 24,
    trades:   12, // "15 (12r/3s)"
    hlFees:   9,
    lpPnl:   10,
    hlMtm:   10,
    funding:  9,
    netPnl:  11,
    drawdown: 9,
    avgGap:   9,
  };

  const sepParts = Object.values(cols).map(w => '-'.repeat(w));
  const sep = '+-' + sepParts.join('-+-') + '-+';

  const fmt = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(2);

  console.log();
  console.log(sep);
  console.log(
    `| ${pad('Strategy', cols.strategy)} | ${padLeft('Trades(rng/str)', cols.trades)} |` +
    ` ${padLeft('HL Fees', cols.hlFees)} |` +
    ` ${padLeft('LP P&L($)', cols.lpPnl)} |` +
    ` ${padLeft('HL MTM($)', cols.hlMtm)} |` +
    ` ${padLeft('Fund($)', cols.funding)} |` +
    ` ${padLeft('Net PnL($)', cols.netPnl)} |` +
    ` ${padLeft('MaxDD($)', cols.drawdown)} |` +
    ` ${padLeft('AvgGap', cols.avgGap)} |`,
  );
  console.log(sep);

  for (const r of results) {
    const tradeLabel = r.emergencyTrades > 0
      ? `${r.totalTrades}(${r.strategyTriggeredTrades}s/${r.emergencyTrades}e)`
      : `${r.totalTrades}(${r.strategyTriggeredTrades}s)`;
    console.log(
      `| ${pad(r.label, cols.strategy)} | ${padLeft(tradeLabel, cols.trades)} |` +
      ` ${padLeft(r.totalFeesUsd.toFixed(2), cols.hlFees)} |` +
      ` ${padLeft(fmt(r.lpValuePnlUsd), cols.lpPnl)} |` +
      ` ${padLeft(fmt(r.hlMarkToMarketPnlUsd), cols.hlMtm)} |` +
      ` ${padLeft(fmt(r.fundingPnlUsd), cols.funding)} |` +
      ` ${padLeft(fmt(r.finalPnlUsd), cols.netPnl)} |` +
      ` ${padLeft(r.maxDrawdownUsd.toFixed(2), cols.drawdown)} |` +
      ` ${padLeft(formatDuration(r.avgTimeBetweenTrades), cols.avgGap)} |`,
    );
  }

  console.log(sep);
  // Nota: LP Fees($) sempre 0 até o bot logar tokensOwed0/1 nos ciclos
  console.log(' Note: LP Fees not included (bot does not yet log tokensOwed in CYCLE lines)');
  console.log();
}
