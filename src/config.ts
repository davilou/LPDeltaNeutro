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

function parseRpcList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map(u => u.trim()).filter(Boolean).map(u => u.endsWith('/') ? u.slice(0, -1) : u);
}

export const config = {
  // RPC
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

  /** HTTP RPC URLs per additional chain (comma-separated list for fallback) */
  get ethHttpRpcUrls(): string[] { return parseRpcList(process.env.ETH_HTTP_RPC_URL); },
  get bscHttpRpcUrls(): string[] { return parseRpcList(process.env.BSC_HTTP_RPC_URL); },
  get arbHttpRpcUrls(): string[] { return parseRpcList(process.env.ARB_HTTP_RPC_URL); },
  get polygonHttpRpcUrls(): string[] { return parseRpcList(process.env.POLYGON_HTTP_RPC_URL); },
  get avaxHttpRpcUrls(): string[] { return parseRpcList(process.env.AVAX_HTTP_RPC_URL); },
  get hlL1HttpRpcUrls(): string[] { return parseRpcList(process.env.HL_L1_HTTP_RPC_URL); },

  /**
   * RPCs gratuitos dedicados a leituras de LP (positions, collect.staticCall).
   * Se não configurados, o fallback é o provider principal (Alchemy).
   * Formato: URL1,URL2,...
   */
  get lpFreeBaseRpcUrls(): string[] { return parseRpcList(process.env.LP_FREE_BASE_RPC_URL); },
  get lpFreeEthRpcUrls(): string[]  { return parseRpcList(process.env.LP_FREE_ETH_RPC_URL); },
  get lpFreeBscRpcUrls(): string[]  { return parseRpcList(process.env.LP_FREE_BSC_RPC_URL); },
  get lpFreeArbRpcUrls(): string[]  { return parseRpcList(process.env.LP_FREE_ARB_RPC_URL); },
  get lpFreePolygonRpcUrls(): string[] { return parseRpcList(process.env.LP_FREE_POLYGON_RPC_URL); },
  get lpFreeAvaxRpcUrls(): string[] { return parseRpcList(process.env.LP_FREE_AVAX_RPC_URL); },
  get lpFreeHlL1RpcUrls(): string[] { return parseRpcList(process.env.LP_FREE_HL_L1_RPC_URL); },

  /** Intervalo do ciclo de leitura de LP via RPCs gratuitos (minutos). Default: 5. */
  lpReadIntervalMin: numEnv('LP_READ_INTERVAL_MIN', 5),
  /** Delay entre usuários no ciclo de LP para evitar rate-limit (ms). Default: 5000. */
  lpReadInterUserDelayMs: numEnv('LP_READ_INTER_USER_DELAY_MS', 5000),
  get solanaHttpRpcUrl(): string {
    if (process.env.SOLANA_HTTP_RPC_URL) return process.env.SOLANA_HTTP_RPC_URL;
    const alchKey = process.env.ALCHEMY_API_KEY;
    if (alchKey) return `https://solana-mainnet.g.alchemy.com/v2/${alchKey}`;
    return 'https://api.mainnet-beta.solana.com';
  },

  /** Enable Multicall3 batching for EVM reads (default true) */
  multicall3Enabled: optionalEnv('MULTICALL3_ENABLED', 'true').toLowerCase() === 'true',

  // Strategy
  hedgeFloor: numEnv('HEDGE_FLOOR', 0.90),
  minNotionalUsd: numEnv('MIN_NOTIONAL_USD', 50),
  maxNotionalUsd: numEnv('MAX_NOTIONAL_USD', 100000),
  maxDailyRebalances: numEnv('MAX_DAILY_REBALANCES', 10),
  // Intervalo de rebalance periódico (minutos) — serve também como cooldown mínimo entre rebalances
  rebalanceIntervalMin: numEnv('REBALANCE_INTERVAL_MIN', 720),

  // Gatilho por movimento de preço: dispara rebalance quando o preço se move X% desde o último rebalance
  // Emergency: movimento de preço maior, bypassa cooldown
  emergencyPriceMovementThreshold: numEnv('EMERGENCY_PRICE_MOVEMENT_THRESHOLD', 0.15),
  /** Intervalo do ciclo pesado (minutos). Default: 30. */
  cycleIntervalMin: numEnv('CYCLE_INTERVAL_MIN', 30),
  positionCacheTtlMs: numEnv('POSITION_CACHE_TTL_MS', 30 * 60 * 1_000),
  positionCacheRefreshCycles: numEnv('POSITION_CACHE_REFRESH_CYCLES', 60),

  // Hyperliquid credentials (required when DRY_RUN=false)
  hlPrivateKey: process.env.HL_PRIVATE_KEY || '',
  hlWalletAddress: process.env.HL_WALLET_ADDRESS || '',

  // Dashboard
  dashboardPort: parseInt(process.env.PORT || process.env.DASHBOARD_PORT || '3000', 10),

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
  supabasePostgresUrl: optionalEnv('SUPABASE_POSTGRES_URL', ''),

  // Zerion API (scanner discovery)
  zerionApiKey: optionalEnv('ZERION_API_KEY', ''),

  // Auth (Google OAuth)
  googleClientId: optionalEnv('GOOGLE_CLIENT_ID', ''),
  googleClientSecret: optionalEnv('GOOGLE_CLIENT_SECRET', ''),
  googleCallbackUrl: optionalEnv('GOOGLE_CALLBACK_URL', 'http://localhost:3000/auth/callback'),
  sessionSecret: optionalEnv('SESSION_SECRET', 'dev-session-secret'),
  credentialEncryptionKey: optionalEnv('CREDENTIAL_ENCRYPTION_KEY', ''),
  // Comma-separated list of allowed Google emails. Empty = allow any.
  allowedEmails: optionalEnv('ALLOWED_EMAILS', ''),
} as const;

