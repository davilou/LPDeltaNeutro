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

/** JSON format for files and prod console. */
const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  contextFormat(),
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

// Loki transport (optional — lazy-loaded to avoid crashing when dependency is missing)
if (LOKI_ENABLED && LOKI_URL) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const LokiTransport = require('winston-loki');
    const lokiOptions: Record<string, unknown> = {
      host: LOKI_URL,
      labels: { job: 'lpdeltaneutro', environment: NODE_ENV },
      json: true,
      batching: true,
      interval: 5,
      replaceTimestamp: true,
      gracefulShutdown: true,
      clearOnError: false,
      format: jsonFormat,
    };
    if (LOKI_TENANT_ID) {
      lokiOptions.tenantId = LOKI_TENANT_ID;
    }
    if (LOKI_USERNAME && LOKI_PASSWORD) {
      lokiOptions.basicAuth = `${LOKI_USERNAME}:${LOKI_PASSWORD}`;
    }
    loggerTransports.push(new LokiTransport(lokiOptions));
    // eslint-disable-next-line no-console
    console.log('[Logger] Loki transport enabled →', LOKI_URL);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[Logger] Failed to load winston-loki:', err);
  }
}

export const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: jsonFormat,
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

// Send price logs to Loki with distinct label so they can be filtered: {category="price"}
if (LOKI_ENABLED && LOKI_URL) {
  try {
    const LokiTransport = require('winston-loki');
    const lokiOptions: Record<string, unknown> = {
      host: LOKI_URL,
      labels: { job: 'lpdeltaneutro', category: 'price', environment: NODE_ENV },
      json: true,
      batching: true,
      interval: 5,
      replaceTimestamp: true,
      gracefulShutdown: true,
      clearOnError: false,
      format: jsonFormat,
    };
    if (LOKI_TENANT_ID) lokiOptions.tenantId = LOKI_TENANT_ID;
    if (LOKI_USERNAME && LOKI_PASSWORD) lokiOptions.basicAuth = `${LOKI_USERNAME}:${LOKI_PASSWORD}`;
    priceTransports.push(new LokiTransport(lokiOptions));
  } catch {
    // winston-loki not available — file-only
  }
}

// No console transport in prod — only file + Loki. Dev fallback to console.
if (!priceTransports.length) {
  priceTransports.push(new winston.transports.Console({ format: devConsoleFormat }));
}

export const priceLogger = winston.createLogger({
  level: 'info',
  format: jsonFormat,
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
