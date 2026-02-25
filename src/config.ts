import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

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

  // Strategy
  hedgeFloor: numEnv('HEDGE_FLOOR', 0.90),
  minNotionalUsd: numEnv('MIN_NOTIONAL_USD', 50),
  maxNotionalUsd: numEnv('MAX_NOTIONAL_USD', 100000),
  maxDailyRebalances: numEnv('MAX_DAILY_REBALANCES', 10),
  // Intervalo de rebalance periódico (minutos) — serve também como cooldown mínimo entre rebalances
  rebalanceIntervalMin: numEnv('REBALANCE_INTERVAL_MIN', 720),

  // Gatilho por movimento de preço: dispara rebalance quando o preço se move X% desde o último rebalance
  priceMovementThreshold: numEnv('PRICE_MOVEMENT_THRESHOLD', 0.05),
  // Emergency: movimento de preço maior, bypassa cooldown
  emergencyPriceMovementThreshold: numEnv('EMERGENCY_PRICE_MOVEMENT_THRESHOLD', 0.15),
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

