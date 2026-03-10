import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';

const logDir = process.env.LOG_DIR || path.resolve(__dirname, '..', '..', 'logs');

// Try to create the log directory; fall back to console-only if it fails (e.g. Railway read-only FS)
let fileLoggingEnabled = false;
try {
  fs.mkdirSync(logDir, { recursive: true });
  fileLoggingEnabled = true;
} catch {
  // no-op — console-only mode
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
  })
);

const loggerTransports: winston.transport[] = [new winston.transports.Console()];
if (fileLoggingEnabled) {
  loggerTransports.push(new DailyRotateFile({
    dirname: logDir,
    filename: 'bot-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxFiles: '14d',
    maxSize: '20m',
    format: logFormat,
  }));
}

export const logger = winston.createLogger({
  level: 'info',
  format: logFormat,
  transports: loggerTransports,
});

// Dedicated price logger — writes every poll (10s) to logs/price-YYYY-MM-DD.log
const priceTransports: winston.transport[] = [];
if (fileLoggingEnabled) {
  priceTransports.push(new DailyRotateFile({
    dirname: logDir,
    filename: 'price-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxFiles: '7d',
    maxSize: '10m',
    format: logFormat,
  }));
}

export const priceLogger = winston.createLogger({
  level: 'info',
  format: logFormat,
  transports: priceTransports.length ? priceTransports : [new winston.transports.Console()],
});

export function logCycle(data: {
  token0Amount: number;
  token0Symbol: string;
  token1Amount: number;
  token1Symbol: string;
  price: number;
  totalPositionUsd: number;
  hedgeNotionalUsd: number;
  fundingRate: number;
  hedgeSize: number;
  netDelta: number;
  rangeStatus: string;
  lpFees0?: number;
  lpFees1?: number;
}) {
  const feesStr = (data.lpFees0 !== undefined && data.lpFees1 !== undefined)
    ? ` | fees0: ${data.lpFees0.toFixed(6)} | fees1: ${data.lpFees1.toFixed(6)}`
    : '';

  logger.info(
    `CYCLE | ${data.token0Symbol}: ${data.token0Amount.toFixed(4)} | ` +
    `${data.token1Symbol}: ${data.token1Amount.toFixed(4)} | ` +
    `price: ${data.price.toFixed(6)} | positionUSD: $${data.totalPositionUsd.toFixed(2)} | ` +
    `hedgeNotional: $${data.hedgeNotionalUsd.toFixed(2)} | ` +
    `funding: ${(data.fundingRate * 100).toFixed(2)}% | ` +
    `hedge: ${data.hedgeSize.toFixed(4)} | netDelta: ${data.netDelta.toFixed(4)} | ` +
    `range: ${data.rangeStatus}${feesStr}`
  );
}
