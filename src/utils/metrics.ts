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
