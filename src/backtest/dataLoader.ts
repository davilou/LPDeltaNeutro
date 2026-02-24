import fs from 'fs';
import path from 'path';
import { TickData } from './types';

/**
 * Parse CYCLE lines from bot log files.
 *
 * Log format:
 * [YYYY-MM-DD HH:mm:ss] INFO: CYCLE | VIRTUAL: 389.5553 | USDC: 246.3658 | price: 0.637134
 *   | positionUSD: $494.56 | hedgeNotional: $248.20 | funding: 0.00% | hedge: 399.7000
 *   | netDelta: -10.1447 | range: in-range
 */

// Groups: 1=ts, 2=token0, 3=token1, 4=price, 5=funding%, 6=hedge, 7=range,
//         8=fees0 (optional), 9=fees1 (optional)
const CYCLE_RE =
  /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] INFO: CYCLE \| \S+: ([\d.]+) \| \S+: ([\d.]+) \| price: ([\d.]+) \| positionUSD: \$[\d.]+ \| hedgeNotional: \$[\d.]+ \| funding: ([+-]?[\d.]+)% \| hedge: ([\d.]+) \| netDelta: [+-]?[\d.]+ \| range: (\S+)(?:\s*\|\s*fees0:\s*([\d.]+)\s*\|\s*fees1:\s*([\d.]+))?/;

function parseCycleLine(line: string): TickData | null {
  const m = CYCLE_RE.exec(line);
  if (!m) return null;

  const [, ts, t0, t1, price, funding, hedge, range, fees0, fees1] = m;
  return {
    timestamp: new Date(ts.replace(' ', 'T') + 'Z').getTime(),
    token0Amount: parseFloat(t0),
    token1Amount: parseFloat(t1),
    price: parseFloat(price),
    fundingRate: parseFloat(funding) / 100, // log shows percentage, convert to decimal
    hedgeSize: parseFloat(hedge),
    rangeStatus: range as TickData['rangeStatus'],
    lpFees0: fees0 !== undefined ? parseFloat(fees0) : 0,
    lpFees1: fees1 !== undefined ? parseFloat(fees1) : 0,
  };
}

/** Load tick data from log files in a directory, optionally filtered by date */
export function loadFromLogs(logDir: string, date?: string): TickData[] {
  const files = fs.readdirSync(logDir)
    .filter(f => f.startsWith('bot-') && f.endsWith('.log'))
    .filter(f => !date || f.includes(date))
    .sort();

  const ticks: TickData[] = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(logDir, file), 'utf-8');
    for (const line of content.split('\n')) {
      const tick = parseCycleLine(line);
      if (tick) ticks.push(tick);
    }
  }

  return ticks;
}

/** Load tick data from a CSV file. Expected columns: timestamp,token0Amount,token1Amount,price,fundingRate,hedgeSize,rangeStatus */
export function loadFromCsv(filePath: string): TickData[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const header = lines[0].split(',').map(h => h.trim());
  const ticks: TickData[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim());
    const row: Record<string, string> = {};
    header.forEach((h, idx) => { row[h] = cols[idx]; });

    ticks.push({
      timestamp: Number(row.timestamp),
      token0Amount: parseFloat(row.token0Amount),
      token1Amount: parseFloat(row.token1Amount),
      price: parseFloat(row.price),
      fundingRate: parseFloat(row.fundingRate),
      hedgeSize: parseFloat(row.hedgeSize || '0'),
      rangeStatus: (row.rangeStatus || 'in-range') as TickData['rangeStatus'],
      lpFees0: parseFloat(row.lpFees0 || '0'),
      lpFees1: parseFloat(row.lpFees1 || '0'),
    });
  }

  return ticks;
}
