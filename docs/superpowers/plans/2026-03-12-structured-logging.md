# Structured Logging Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structured JSON logging with async context, Loki transport, Prometheus operational metrics, and Telegram alerts to the delta-neutral LP bot.

**Architecture:** Winston logger rewritten to emit JSON with auto-injected context from AsyncLocalStorage. New modules for correlation context, Prometheus metrics (prom-client), and Telegram alerts (node-telegram-bot-api). Incremental migration — only hot paths (rebalancer, index, server) get withContext() wrappers; remaining ~20 files get JSON format automatically.

**Tech Stack:** Winston 3.x + winston-loki + prom-client + node-telegram-bot-api + Node.js AsyncLocalStorage

**Important:** This project does NOT use unit tests (per CLAUDE.md). Validation is done via type-check (`npx tsc --noEmit`) and manual testing.

---

## Chunk 1: Foundation (correlation, metrics, alerts, config)

### Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install production dependencies**

```bash
npm install winston-loki prom-client node-telegram-bot-api
```

- [ ] **Step 2: Install dev dependencies (types)**

```bash
npm install -D @types/node-telegram-bot-api
```

- [ ] **Step 3: Verify installation**

Run: `npx tsc --noEmit`
Expected: No new errors (existing errors may remain).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add winston-loki, prom-client, node-telegram-bot-api dependencies"
```

---

### Task 2: Create Correlation Context Module

**Files:**
- Create: `src/utils/correlation.ts`

- [ ] **Step 1: Create correlation.ts**

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export interface LogContext {
  userId?: string;
  correlationId?: string;
  tokenId?: number | string;
  chain?: string;
  dex?: string;
}

const asyncLocalStorage = new AsyncLocalStorage<LogContext>();

/**
 * Execute `fn` within a log context. Merges with parent context if nested.
 * Cleanup is automatic when the promise resolves.
 */
export function withContext<T>(ctx: Partial<LogContext>, fn: () => T | Promise<T>): T | Promise<T> {
  const parent = asyncLocalStorage.getStore() ?? {};
  const merged: LogContext = { ...parent, ...ctx };
  return asyncLocalStorage.run(merged, fn);
}

/**
 * Returns the current async context or empty object if none.
 */
export function getLogContext(): LogContext {
  return asyncLocalStorage.getStore() ?? {};
}

/**
 * Generate a short correlation ID with optional prefix.
 * Example: generateCorrelationId('reb') → 'reb_a1b2c3d4'
 */
export function generateCorrelationId(prefix = 'op'): string {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add src/utils/correlation.ts
git commit -m "feat: add async correlation context module (AsyncLocalStorage)"
```

---

### Task 3: Create Prometheus Metrics Module

**Files:**
- Create: `src/utils/metrics.ts`

- [ ] **Step 1: Create metrics.ts**

```typescript
import client from 'prom-client';

// Collect default Node.js metrics (CPU, memory, event loop)
client.collectDefaultMetrics();

export const register = client.register;

// ── Operational Metrics (Category A) ──────────────────────────────────────

export const rebalancesTotal = new client.Counter({
  name: 'rebalances_total',
  help: 'Total number of rebalances executed',
  labelNames: ['userId', 'chain', 'dex', 'trigger'] as const,
});

export const rebalanceErrorsTotal = new client.Counter({
  name: 'rebalance_errors_total',
  help: 'Total number of rebalance errors',
  labelNames: ['userId', 'chain', 'dex', 'severity'] as const,
});

export const lpReadDuration = new client.Histogram({
  name: 'lp_read_duration_seconds',
  help: 'Duration of LP position reads in seconds',
  labelNames: ['chain', 'dex'] as const,
  buckets: [0.5, 1, 2, 5, 10, 30],
});

export const hedgeExecutionDuration = new client.Histogram({
  name: 'hedge_execution_duration_seconds',
  help: 'Duration of hedge execution on Hyperliquid in seconds',
  labelNames: ['chain', 'dex'] as const,
  buckets: [0.5, 1, 2, 5, 10, 30],
});

export const activePositionsCount = new client.Gauge({
  name: 'active_positions_count',
  help: 'Number of active positions per user',
  labelNames: ['userId'] as const,
});
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add src/utils/metrics.ts
git commit -m "feat: add Prometheus operational metrics module (prom-client)"
```

---

### Task 4: Create Telegram Alerts Module

**Files:**
- Create: `src/utils/alerts.ts`

- [ ] **Step 1: Create alerts.ts**

```typescript
import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { LogContext, getLogContext } from './correlation';

let bot: TelegramBot | null = null;
let botInitWarned = false;

function getBot(): TelegramBot | null {
  if (bot) return bot;
  if (!config.telegramBotToken || !config.telegramChatId) {
    if (!botInitWarned) {
      // Use console.warn here because logger may not be initialized yet
      // and we want to avoid circular imports
      console.warn('[Alerts] Telegram not configured — alerts disabled');
      botInitWarned = true;
    }
    return null;
  }
  bot = new TelegramBot(config.telegramBotToken, { polling: false });
  return bot;
}

// Rate limiting: max 1 alert per key per 60 seconds
const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_MS = 60_000;
let suppressedCount = 0;

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const lastSent = rateLimitMap.get(key);
  if (lastSent && now - lastSent < RATE_LIMIT_MS) {
    suppressedCount++;
    return true;
  }
  rateLimitMap.set(key, now);
  return false;
}

// Cleanup old rate limit entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_MS;
  for (const [key, ts] of rateLimitMap) {
    if (ts < cutoff) rateLimitMap.delete(key);
  }
  if (suppressedCount > 0) {
    const b = getBot();
    if (b) {
      b.sendMessage(
        config.telegramChatId,
        `⚠️ ${suppressedCount} alerta(s) suprimido(s) nos últimos 5min`,
      ).catch(() => {});
    }
    suppressedCount = 0;
  }
}, 5 * 60_000);

export async function sendAlert(
  level: 'warning' | 'critical',
  message: string,
  context?: Partial<LogContext>,
): Promise<void> {
  const b = getBot();
  if (!b) return;

  const ctx = { ...getLogContext(), ...context };
  const rateLimitKey = `${message}:${ctx.userId ?? ''}:${ctx.tokenId ?? ''}`;
  if (isRateLimited(rateLimitKey)) return;

  const icon = level === 'critical' ? '🔴' : '🟡';
  const posInfo = ctx.tokenId
    ? `Position: NFT #${ctx.tokenId}${ctx.chain ? ` (${ctx.chain}/${ctx.dex ?? '?'})` : ''}`
    : '';

  const text = [
    `${icon} ${level.toUpperCase()} — lpdeltaneutro`,
    '',
    message,
    ctx.userId ? `User: ${ctx.userId}` : '',
    posInfo,
    ctx.correlationId ? `Correlation: ${ctx.correlationId}` : '',
    '',
    new Date().toISOString(),
  ].filter(Boolean).join('\n');

  try {
    await b.sendMessage(config.telegramChatId, text);
  } catch {
    // Silently fail — don't crash the bot because of alert delivery issues
  }
}

export async function notifyCriticalError(
  correlationId: string,
  error: unknown,
  context?: Partial<LogContext>,
): Promise<void> {
  const errMsg = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && error.stack
    ? error.stack.split('\n').slice(0, 4).join('\n')
    : '';

  const message = stack
    ? `${errMsg}\n\n\`\`\`\n${stack}\n\`\`\``
    : errMsg;

  await sendAlert('critical', message, { ...context, correlationId });
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add src/utils/alerts.ts
git commit -m "feat: add Telegram alerts module with rate limiting"
```

---

### Task 5: Update config.ts with New Environment Variables

**Files:**
- Modify: `src/config.ts:113-134` (add after `dryRun` line)

- [ ] **Step 1: Add new config entries**

Add the following entries to the `config` object, after the `dryRun` line (line 114) and before the `// Supabase` comment (line 116):

```typescript
  // Logging
  logLevel: optionalEnv('LOG_LEVEL', 'info'),

  // Loki
  lokiEnabled: optionalEnv('LOKI_ENABLED', 'false').toLowerCase() === 'true',
  lokiUrl: optionalEnv('LOKI_URL', 'http://localhost:3100'),
  lokiTenantId: optionalEnv('LOKI_TENANT_ID', ''),
  lokiUsername: optionalEnv('LOKI_USERNAME', ''),
  lokiPassword: optionalEnv('LOKI_PASSWORD', ''),

  // Telegram Alerts
  telegramBotToken: optionalEnv('TELEGRAM_BOT_TOKEN', ''),
  telegramChatId: optionalEnv('TELEGRAM_CHAT_ID', ''),
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: add Loki, Telegram, and log level config entries"
```

---

## Chunk 2: Logger Rewrite + Integration

### Task 6: Rewrite Logger with JSON Format, Loki Transport, and Async Context

**Files:**
- Modify: `src/utils/logger.ts` (full rewrite, preserving exports)

This is the core change. The logger must:
1. Preserve exports: `logger`, `priceLogger`, `logCycle`
2. Auto-inject AsyncLocalStorage context into every log
3. Emit JSON in production, colored text in dev
4. Add Loki transport when enabled
5. Add separate error log file
6. Use LOG_LEVEL from config

- [ ] **Step 1: Rewrite logger.ts**

```typescript
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import LokiTransport from 'winston-loki';
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
  winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
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

// Loki transport (optional)
if (LOKI_ENABLED && LOKI_URL) {
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
  loggerTransports.push(new LokiTransport(lokiOptions as ConstructorParameters<typeof LokiTransport>[0]));
}

export const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: jsonFormat,
  transports: loggerTransports,
});

// ── Price Logger (separate file, no Loki — high volume) ──────────────────

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

export const priceLogger = winston.createLogger({
  level: 'info',
  format: jsonFormat,
  transports: priceTransports.length ? priceTransports : [new winston.transports.Console({ format: devConsoleFormat })],
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
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No new errors. If `winston-loki` type issues arise, the `as ConstructorParameters<typeof LokiTransport>[0]` cast handles it.

- [ ] **Step 3: Manual test — verify dev console output**

Run: `npx ts-node -e "const { logger } = require('./src/utils/logger'); logger.info('test message', { foo: 'bar' });"`
Expected: Colored output with timestamp, level, message, and metadata.

- [ ] **Step 4: Commit**

```bash
git add src/utils/logger.ts
git commit -m "feat: rewrite logger — JSON structured output, Loki transport, async context injection"
```

---

### Task 7: Add /metrics Endpoint to Dashboard Server

**Files:**
- Modify: `src/dashboard/server.ts:1-20` (add import) and after line 107 (add endpoint)

- [ ] **Step 1: Add import at top of server.ts**

After the existing imports (around line 20), add:

```typescript
import { register } from '../utils/metrics';
```

- [ ] **Step 2: Add /metrics endpoint**

Add the endpoint BEFORE the auth middleware (`app.use('/api', requireAuth)` at line 179), so it doesn't require auth (standard for Prometheus scraping):

```typescript
  // Prometheus metrics endpoint (no auth — standard for scraping)
  app.get('/metrics', async (_req, res) => {
    try {
      res.set('Content-Type', register.contentType);
      res.end(await register.metrics());
    } catch (err) {
      res.status(500).end(String(err));
    }
  });
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/server.ts
git commit -m "feat: add GET /metrics endpoint for Prometheus scraping"
```

---

### Task 8: Integrate withContext and Metrics into index.ts

**Files:**
- Modify: `src/index.ts`

This task adds context wrapping and metrics instrumentation to the three main loops.

- [ ] **Step 1: Add imports**

After the existing imports at the top of index.ts (around line 19), add:

```typescript
import { withContext, generateCorrelationId } from './utils/correlation';
import { activePositionsCount, lpReadDuration } from './utils/metrics';
```

- [ ] **Step 2: Wrap runCycleForUser with userId context**

Modify `runCycleForUser` (line 582). Wrap the body in `withContext({ userId })` and the inner loop iteration in `withContext({ tokenId, chain, dex })`:

Replace the function body so the for-loop is inside a `withContext`:

```typescript
  async function runCycleForUser(userId: string, ctx: UserEngineContext): Promise<void> {
    const store = getStoreForUser(userId);
    const positionsState = ctx.rebalancer.fullState.positions;
    const tokenIds: PositionId[] = Object.keys(positionsState);

    if (tokenIds.length === 0) return;

    await withContext({ userId }, async () => {
      for (const tokenId of tokenIds) {
        const posState = positionsState[tokenId];
        if (!posState) continue;
        const cfg = posState.config;

        if (!store.getActivePositionConfig(tokenId)) {
          logger.warn(`[Cycle] NFT #${tokenId} present in rebalancer state but missing from dashboard — re-syncing`);
          store.setActivePositionConfig(tokenId, cfg);
        }

        const cycleChain = (cfg.chain ?? 'base') as ChainId;
        const cycleDex = (cfg.dex ?? (cfg.protocolVersion === 'v4' ? 'uniswap-v4' : 'uniswap-v3')) as DexId;

        await withContext({ tokenId, chain: cycleChain, dex: cycleDex }, async () => {
          try {
            logger.info(`[Cycle] Processing NFT #${tokenId} (${cfg.protocolVersion})...`);
            const cycleReader = getOrCreateReader(ctx, cycleChain, cycleDex);
            const position = await cycleReader.readPosition(tokenId, cfg.poolAddress);

            const v4PoolId = cfg.protocolVersion === 'v4' && typeof tokenId === 'number'
              ? (cycleReader as EvmV4Reader).getV4PoolId(tokenId) : null;
            const needsBackfill = !cfg.token0Address || (v4PoolId !== null && cfg.poolAddress !== v4PoolId);
            if (needsBackfill) {
              const backfilled: ActivePositionConfig = {
                ...cfg,
                poolAddress: v4PoolId ?? cfg.poolAddress,
                token0Address: position.token0.address,
                token1Address: position.token1.address,
                token0Decimals: position.token0.decimals,
                token1Decimals: position.token1.decimals,
              };
              ctx.rebalancer.updateConfig(tokenId, backfilled);
              store.setActivePositionConfig(tokenId, backfilled);
            }

            if (position.liquidity === 0n) {
              logger.warn(`[Cycle] NFT #${tokenId} liquidity is 0 — LP position closed. Auto-deactivating...`);
              cycleReader.invalidateCache(tokenId);
              if (!ctx.deactivationsInProgress.has(tokenId)) {
                store.requestDeactivation(tokenId);
              }
              return;
            }

            await ctx.rebalancer.cycle(tokenId, position);
          } catch (err) {
            logger.error(`[Cycle] Cycle error for NFT #${tokenId}: ${err}`);
          }
        });
      }
    });
  }
```

- [ ] **Step 3: Add LP read duration metric to runLpReadForToken**

In `runLpReadForToken` (line 640), wrap the `readPosition` call with a timer:

After line 648 (`const reader = getOrCreateReader(ctx, chain, dex);`), replace lines 650-651 with:

```typescript
    reader.refreshFees?.(tokenId);
    const endLpTimer = lpReadDuration.startTimer({ chain, dex });
    const position = await reader.readPosition(tokenId, cfg.poolAddress);
    endLpTimer();
```

- [ ] **Step 4: Update active positions gauge on activation/deactivation**

In `setupUserEventHandlers`, at the end of the activation success block (after line 237 `store.notifyActivationResult...`), add:

```typescript
      const activeCount = Object.keys(ctx.rebalancer.fullState.positions).length;
      activePositionsCount.set({ userId }, activeCount);
```

At the end of the deactivation handler (before line 381 `ctx.deactivationsInProgress.delete(tokenId)`), add:

```typescript
    const activeCount = Object.keys(ctx.rebalancer.fullState.positions).length;
    activePositionsCount.set({ userId }, activeCount);
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: integrate async context and Prometheus metrics into main loops"
```

---

### Task 9: Integrate withContext, Metrics, and Alerts into Rebalancer

**Files:**
- Modify: `src/engine/rebalancer.ts`

- [ ] **Step 1: Add imports**

After the existing imports at the top (line 7), add:

```typescript
import { withContext, generateCorrelationId, getLogContext } from '../utils/correlation';
import { rebalancesTotal, rebalanceErrorsTotal, hedgeExecutionDuration } from '../utils/metrics';
import { notifyCriticalError } from '../utils/alerts';
```

- [ ] **Step 2: Wrap cycle() body with correlation context**

Replace the `cycle` method (lines 263-614) with a version that wraps the body in `withContext`. The key changes are:

1. Generate a correlationId at the start
2. Wrap the entire body in `withContext({ correlationId })`
3. Add structured log fields at key points
4. Add metrics at rebalance execution and errors
5. Add Telegram alert on critical errors

Replace the beginning of `cycle()` (lines 263-271):

```typescript
  async cycle(tokenId: PositionId, position: LPPosition): Promise<void> {
    if (!this.exchange) {
      throw new Error(`[Rebalancer] No exchange configured — cannot run cycle for NFT #${tokenId}. User must set HL credentials first.`);
    }
    const ps = this.state.positions[tokenId];
    if (!ps) {
      logger.warn(`[Rebalancer] No state for tokenId ${tokenId} — skipping cycle`);
      return;
    }

    const correlationId = generateCorrelationId('reb');
    return withContext({ correlationId }, async () => {
```

After the existing safety check block that returns early (line 497 `return;`), and before the `// Execute rebalance` comment (line 500), add trigger classification to the structured log. The existing log at lines 502-506 already logs the trigger — keep it.

Wrap the exchange execution (lines 510-518) to add timing + error alerting:

Replace lines 508-518 with:

```typescript
    let fillResult: FillResult | null = null;
    try {
      const ctx = getLogContext();
      const endHedgeTimer = hedgeExecutionDuration.startTimer({
        chain: ctx.chain ?? 'unknown',
        dex: ctx.dex ?? 'unknown',
      });
      if (effectiveSize <= 0) {
        fillResult = await this.exchange.closePosition(hedgeSymbol);
      } else {
        fillResult = await this.exchange.setPosition(hedgeSymbol, effectiveSize, effectiveNotional);
      }
      endHedgeTimer();
    } catch (exchangeErr) {
      const ctx = getLogContext();
      logger.error(`[NFT#${tokenId}] Exchange error — rebalance aborted, state unchanged`, {
        action: 'rebalance_failed',
        severity: 'critical',
        error: String(exchangeErr),
      });
      rebalanceErrorsTotal.inc({
        userId: ctx.userId ?? 'unknown',
        chain: ctx.chain ?? 'unknown',
        dex: ctx.dex ?? 'unknown',
        severity: 'critical',
      });
      void notifyCriticalError(correlationId, exchangeErr);
      throw exchangeErr;
    }
```

After the existing success log (line 609-611), add the rebalance counter:

```typescript
    const ctx = getLogContext();
    const triggerLabel = isForcedClose ? 'forced_close'
      : isForcedHedge ? 'forced_hedge'
      : liquidityChangeReason ? 'liquidity_change'
      : emergencyReason ? 'emergency'
      : 'timer';
    rebalancesTotal.inc({
      userId: ctx.userId ?? 'unknown',
      chain: ctx.chain ?? 'unknown',
      dex: ctx.dex ?? 'unknown',
      trigger: triggerLabel,
    });
```

Close the `withContext` at the end of the method (before the final `}`):

```typescript
    }); // end withContext
  }
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add src/engine/rebalancer.ts
git commit -m "feat: integrate correlation context, metrics, and alerts into rebalancer cycle"
```

---

### Task 10: Update .env.example

**Files:**
- Modify or create: `.env.example`

- [ ] **Step 1: Add logging section to .env.example**

Append the following block to `.env.example` (create file if it doesn't exist):

```env
# ── Logging ──────────────────────────────────────────────────────────────
LOG_LEVEL=info                    # debug | info | warn | error

# ── Loki (Grafana Cloud ou self-hosted) ──────────────────────────────────
LOKI_ENABLED=false
LOKI_URL=https://logs-prod-xxx.grafana.net
LOKI_TENANT_ID=                   # Grafana Cloud: seu tenant ID
LOKI_USERNAME=                    # Grafana Cloud: user ID numérico
LOKI_PASSWORD=                    # Grafana Cloud: API key com role Editor

# ── Telegram Alerts ──────────────────────────────────────────────────────
# 1. Fale com @BotFather no Telegram → /newbot → copie o token
# 2. Envie qualquer mensagem para o bot criado
# 3. Acesse https://api.telegram.org/bot<TOKEN>/getUpdates → copie chat.id
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: add Loki, Telegram, and log level to .env.example"
```

---

### Task 11: Build Verification

- [ ] **Step 1: Full type-check**

Run: `npx tsc --noEmit`
Expected: Clean (no new errors).

- [ ] **Step 2: Full build**

Run: `npm run build`
Expected: Compiles to `dist/` without errors.

- [ ] **Step 3: Manual smoke test**

Run: `LOG_LEVEL=debug npx ts-node -e "
const { logger } = require('./src/utils/logger');
const { withContext, generateCorrelationId } = require('./src/utils/correlation');

// Test basic log
logger.info('Boot test');

// Test with context
withContext({ userId: 'test-user', tokenId: 12345, chain: 'base', dex: 'uniswap-v3' }, () => {
  const cid = generateCorrelationId('reb');
  withContext({ correlationId: cid }, () => {
    logger.info('Nested context test', { action: 'test', foo: 'bar' });
  });
});

// Give winston time to flush
setTimeout(() => process.exit(0), 500);
"`

Expected: JSON output in console with all context fields present.

- [ ] **Step 4: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address build/type issues from structured logging integration"
```
