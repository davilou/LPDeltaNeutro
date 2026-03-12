import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';
import { getLogContext } from './correlation';

// Config values read directly from env to avoid circular import with config.ts
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOKI_ENABLED = (process.env.LOKI_ENABLED || '').toLowerCase() === 'true';
const LOKI_URL = process.env.LOKI_URL || 'http://localhost:3100';
const LOKI_TENANT_ID = process.env.LOKI_TENANT_ID || '';
const LOKI_USERNAME = process.env.LOKI_USERNAME || '';
const LOKI_PASSWORD = process.env.LOKI_PASSWORD || '';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

const logDir = process.env.LOG_DIR || path.resolve(__dirname, '..', '..', 'logs');

let fileLoggingEnabled = false;
try {
  fs.mkdirSync(logDir, { recursive: true });
  fileLoggingEnabled = true;
} catch {
  // Console-only mode (e.g. Railway read-only FS)
}

// ── Formats ──────────────────────────────────────────────────────────────

/** Injects AsyncLocalStorage context fields into the log info object. */
const contextFormat = winston.format((info) => {
  const ctx = getLogContext();
  if (ctx.userId) info.userId = ctx.userId;
  if (ctx.correlationId) info.correlationId = ctx.correlationId;
  if (ctx.tokenId !== undefined) info.tokenId = ctx.tokenId;
  if (ctx.chain) info.chain = ctx.chain;
  if (ctx.dex) info.dex = ctx.dex;
  info.service = 'lpdeltaneutro';
  return info;
});

/** Base format: adds timestamp + async context fields (no serialization). */
const baseFormat = winston.format.combine(
  winston.format.timestamp(),
  contextFormat(),
);

/** JSON format for files and prod console (base + JSON serialization). */
const jsonFormat = winston.format.combine(
  baseFormat,
  winston.format.json(),
);

/** Human-readable format for dev console. */
const devConsoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  contextFormat(),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, service: _service, ...meta }) => {
    // Build context prefix from async context fields
    const parts: string[] = [];
    if (meta.userId) parts.push(`u:${meta.userId}`);
    if (meta.tokenId !== undefined) parts.push(`#${meta.tokenId}`);
    if (meta.correlationId) parts.push(meta.correlationId as string);
    const ctxStr = parts.length ? ` [${parts.join(' ')}]` : '';

    // Remaining metadata (non-context fields)
    const { userId, correlationId, tokenId, chain, dex, ...rest } = meta;
    const metaStr = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';

    return `[${timestamp}] ${level}:${ctxStr} ${message}${metaStr}`;
  }),
);

// ── Transports ───────────────────────────────────────────────────────────

const loggerTransports: winston.transport[] = [
  new winston.transports.Console({
    format: IS_PROD ? jsonFormat : devConsoleFormat,
  }),
];

if (fileLoggingEnabled) {
  // Main bot log (JSON)
  loggerTransports.push(new DailyRotateFile({
    dirname: logDir,
    filename: 'bot-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxFiles: '14d',
    maxSize: '20m',
    format: jsonFormat,
  }));

  // Error-only log
  loggerTransports.push(new DailyRotateFile({
    dirname: logDir,
    filename: 'error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxFiles: '14d',
    maxSize: '20m',
    level: 'error',
    format: jsonFormat,
  }));
}

// Loki transport (custom HTTP transport — batches entries in order to avoid Loki out-of-order rejections)
if (LOKI_ENABLED && LOKI_URL) {
  try {
    const { LokiHttpTransport } = require('./lokiTransport');
    const lokiLabels: Record<string, string> = { job: 'lpdeltaneutro', category: 'main', environment: NODE_ENV };
    const lokiOpts: Record<string, unknown> = {
      host: LOKI_URL,
      labels: lokiLabels,
    };
    if (LOKI_TENANT_ID) {
      lokiOpts.tenantId = LOKI_TENANT_ID;
    }
    if (LOKI_USERNAME && LOKI_PASSWORD) {
      lokiOpts.basicAuth = `${LOKI_USERNAME}:${LOKI_PASSWORD}`;
    }
    // eslint-disable-next-line no-console
    console.log('[Logger] Loki basicAuth configured:', !!LOKI_USERNAME && !!LOKI_PASSWORD);
    loggerTransports.push(new LokiHttpTransport(lokiOpts));
    // eslint-disable-next-line no-console
    console.log('[Logger] Loki custom transport enabled →', LOKI_URL);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[Logger] Failed to load Loki transport:', err);
  }
}

export const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: baseFormat,
  transports: loggerTransports,
});

// ── Price Logger (separate file + Loki with category label — high volume, filterable) ──

const priceTransports: winston.transport[] = [];
if (fileLoggingEnabled) {
  priceTransports.push(new DailyRotateFile({
    dirname: logDir,
    filename: 'price-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxFiles: '7d',
    maxSize: '10m',
    format: jsonFormat,
  }));
}

// Console transport: dev uses human-readable, prod uses JSON (same as main logger).
priceTransports.push(new winston.transports.Console({
  format: IS_PROD ? jsonFormat : devConsoleFormat,
}));

// Price logger: file transport for dedicated price log files + console.
// Loki transport is NOT added here — price.update is emitted via BOTH loggers in index.ts:
// logger (→ Loki + bot log) and priceLogger (→ dedicated price file).
// Filter in Grafana with: {job="lpdeltaneutro"} | json | message="price.update"
export const priceLogger = winston.createLogger({
  level: 'info',
  format: baseFormat,
  transports: priceTransports,
});

// ── logCycle (preserves signature, now emits JSON with context) ──────────

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
  logger.info('Cycle data', {
    action: 'cycle_data',
    token0: { symbol: data.token0Symbol, amount: data.token0Amount },
    token1: { symbol: data.token1Symbol, amount: data.token1Amount },
    price: data.price,
    totalPositionUsd: data.totalPositionUsd,
    hedgeNotionalUsd: data.hedgeNotionalUsd,
    fundingRate: data.fundingRate,
    hedgeSize: data.hedgeSize,
    netDelta: data.netDelta,
    rangeStatus: data.rangeStatus,
    lpFees0: data.lpFees0,
    lpFees1: data.lpFees1,
  });
}
