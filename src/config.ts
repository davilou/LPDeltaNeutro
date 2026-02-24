import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function numEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseFloat(raw);
  if (isNaN(parsed)) throw new Error(`Env var ${key} must be a number, got: ${raw}`);
  return parsed;
}

export const config = {
  // RPC
  /** WebSocket URL for blocks */
  get wsUrl(): string {
    const custom = process.env.WS_URL;
    if (custom) return custom;
    // Fallback to legacy Alchemy structure
    const base = process.env.ALCHEMY_WS_URL || 'wss://base-mainnet.g.alchemy.com/v2/';
    const key = process.env.ALCHEMY_API_KEY || '';
    return `${base}${key}`;
  },

  /** Ordered list of HTTP RPC URLs — first that works wins */
  get httpRpcUrls(): string[] {
    const urls: string[] = [];
    const custom = process.env.HTTP_RPC_URL;
    if (custom) urls.push(custom);

    const alchBase = process.env.ALCHEMY_WS_URL;
    const alchKey = process.env.ALCHEMY_API_KEY;
    if (alchBase && alchKey) {
      urls.push(`${alchBase.replace('wss://', 'https://')}${alchKey}`);
    }

    const rpc2 = process.env.HTTP_RPC_URL_2;
    if (rpc2) urls.push(rpc2);
    const rpc3 = process.env.HTTP_RPC_URL_3;
    if (rpc3) urls.push(rpc3);

    // Clean trailing slashes to be safe
    return urls.map(u => u.endsWith('/') ? u.slice(0, -1) : u);
  },

  // Hedge config
  hedgeToken: optionalEnv('HEDGE_TOKEN', 'token0') as 'token0' | 'token1',
  hedgeSymbol: requireEnv('HEDGE_SYMBOL'),

  // Strategy
  hedgeFloor: numEnv('HEDGE_FLOOR', 0.90),
  minNotionalUsd: numEnv('MIN_NOTIONAL_USD', 50),
  maxNotionalUsd: numEnv('MAX_NOTIONAL_USD', 100000),
  maxDailyRebalances: numEnv('MAX_DAILY_REBALANCES', 10),
  maxHourlyRebalances: numEnv('MAX_HOURLY_REBALANCES', 3),
  cooldownSeconds: numEnv('COOLDOWN_SECONDS', 60),
  deltaMismatchThreshold: numEnv('DELTA_MISMATCH_THRESHOLD', 0.08),
  minRebalanceUsd: numEnv('MIN_REBALANCE_USD', 10),
  timeRebalanceIntervalMin: numEnv('TIME_REBALANCE_INTERVAL_MIN', 0),
  // Mismatch mínimo para o time rebalance disparar (evita micro-ajustes no timer)
  timeRebalanceMinMismatch: numEnv('TIME_REBALANCE_MIN_MISMATCH', 0.0),

  // Threshold adaptativo por gamma: escala deltaMismatchThreshold inversamente
  // com a largura do range de ticks. Ranges estreitos → threshold maior → menos rebalances.
  // effectiveThreshold = deltaMismatchThreshold * (adaptiveReferenceTickRange / tickRange)
  // capped em [deltaMismatchThreshold * 0.5, adaptiveMaxThreshold]
  adaptiveThreshold: optionalEnv('ADAPTIVE_THRESHOLD', 'false').toLowerCase() === 'true',
  adaptiveReferenceTickRange: numEnv('ADAPTIVE_REFERENCE_TICK_RANGE', 1000),
  adaptiveMaxThreshold: numEnv('ADAPTIVE_MAX_THRESHOLD', 0.40),

  // Emergency rebalance: dispara se o mismatch ultrapassar este valor,
  // ignorando cooldown. Executa rebalance parcial (emergencyHedgeRatio do gap).
  emergencyMismatchThreshold: numEnv('EMERGENCY_MISMATCH_THRESHOLD', 0.60),
  // Fração do gap a fechar no emergency (0.5 = fecha metade, 1.0 = fecha tudo)
  emergencyHedgeRatio: numEnv('EMERGENCY_HEDGE_RATIO', 0.50),
  blockThrottle: numEnv('BLOCK_THROTTLE', 10),

  // Hyperliquid credentials (required when DRY_RUN=false)
  hlPrivateKey: process.env.HL_PRIVATE_KEY || '',
  hlWalletAddress: process.env.HL_WALLET_ADDRESS || '',

  // Dashboard
  dashboardPort: numEnv('DASHBOARD_PORT', 3000),

  // Uniswap V4
  positionManagerV4Address: optionalEnv('POSITION_MANAGER_V4_ADDRESS', '0x7c5f5a4bbd8fd63184577525326123b519429bdc'),

  // PnL — saldo inicial (se não definido, captura no 1º ciclo)
  initialLpUsd: process.env.INITIAL_LP_USD ? numEnv('INITIAL_LP_USD', 0) : undefined,
  initialHlUsd: process.env.INITIAL_HL_USD ? numEnv('INITIAL_HL_USD', 0) : undefined,
  hlTakerFee: numEnv('HL_TAKER_FEE', 0.000432),

  // Mode
  dryRun: optionalEnv('DRY_RUN', 'true').toLowerCase() === 'true',

  // Supabase (optional — deixar em branco para desativar persistência)
  supabaseUrl: optionalEnv('SUPABASE_URL', ''),
  supabaseKey: optionalEnv('SUPABASE_KEY', ''),
} as const;

// Validate hedge token
if (config.hedgeToken !== 'token0' && config.hedgeToken !== 'token1') {
  throw new Error(`HEDGE_TOKEN must be "token0" or "token1", got: ${config.hedgeToken}`);
}
