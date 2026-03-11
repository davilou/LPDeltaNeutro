import express from 'express';
import path from 'path';
import session from 'express-session';
import passport from 'passport';
import connectPgSimple from 'connect-pg-simple';
import { ethers } from 'ethers';
import { getStoreForUser, ActivatePositionRequest, SaveCredentialsRequest } from './store';
import type { DiscoveredPosition, BotState } from '../types';
import { createWalletScanner } from '../lp/walletScannerFactory';
import type { ChainId, DexId } from '../lp/types';
import { isChainDexSupported } from '../lp/chainRegistry';
import { getZapperComplexPositions } from '../lp/zapperClient';
import { logger } from '../utils/logger';
import { config } from '../config';
import { fetchClosedPositions, fetchRebalances, supabaseServiceClient } from '../db/supabase';
import { HistoricalPosition } from '../types';
import { configurePassport } from '../auth/passport';
import { requireAuth } from '../auth/middleware';
import { saveCredentials } from '../auth/userStore';
import '../auth/types';

const _EVM_COMBOS_ALL: Array<{ chain: ChainId; dex: DexId }> = [
  { chain: 'base', dex: 'uniswap-v3' },
  { chain: 'base', dex: 'uniswap-v4' },
  { chain: 'base', dex: 'aerodrome-cl' },
  { chain: 'eth', dex: 'uniswap-v3' },
  { chain: 'eth', dex: 'uniswap-v4' },
  { chain: 'eth', dex: 'pancake-v3' },
  { chain: 'bsc', dex: 'uniswap-v3' },
  { chain: 'bsc', dex: 'uniswap-v4' },
  { chain: 'bsc', dex: 'pancake-v3' },
  { chain: 'arbitrum', dex: 'uniswap-v3' },
  { chain: 'arbitrum', dex: 'uniswap-v4' },
  { chain: 'arbitrum', dex: 'pancake-v3' },
  { chain: 'polygon', dex: 'uniswap-v3' },
  { chain: 'polygon', dex: 'uniswap-v4' },
  { chain: 'polygon', dex: 'pancake-v3' },
  { chain: 'avalanche', dex: 'uniswap-v3' },
  { chain: 'avalanche', dex: 'uniswap-v4' },
  { chain: 'hyperliquid-l1', dex: 'project-x' },
];
const EVM_CHAIN_DEX_COMBOS: Array<{ chain: ChainId; dex: DexId }> =
  _EVM_COMBOS_ALL.filter(({ chain, dex }) => isChainDexSupported(chain, dex));

const SOLANA_DEX_COMBOS: DexId[] = ['orca', 'raydium', 'meteora'];

interface RebalancerView {
  getScannedPositions(): {
    positions: DiscoveredPosition[];
    scannedAt?: number;
    scannedNetwork?: 'evm' | 'solana';
    scannedWallet?: string;
  };
  saveScannedPositions(positions: DiscoveredPosition[], network: 'evm' | 'solana', wallet: string): void;
  getState(): BotState;
}

export interface DashboardCallbacks {
  onUserAuthenticated: (userId: string) => Promise<void>;
  hotSwapExchange: (userId: string, privateKey: string, walletAddress: string) => void;
  getEngineContext: (userId: string) => { rebalancer: RebalancerView } | null;
}

export function startDashboard(port: number, callbacks: DashboardCallbacks): void {
  const app = express();
  const PgSession = connectPgSimple(session);

  // Session middleware
  const sessionOptions: session.SessionOptions = {
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // set to true behind HTTPS reverse proxy
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  };

  if (config.supabasePostgresUrl) {
    sessionOptions.store = new PgSession({
      conString: config.supabasePostgresUrl,
      createTableIfMissing: true,
      tableName: 'session',
    });
  }

  app.use(session(sessionOptions));
  app.use(passport.initialize());
  app.use(passport.session());
  app.use(express.json());

  configurePassport();

  // Serve static files — works both with ts-node (src/) and compiled (dist/)
  const publicDir = path.resolve(__dirname, 'public');
  const srcPublicDir = path.resolve(__dirname, '..', '..', 'src', 'dashboard', 'public');
  const fs = require('fs');
  const staticDir = fs.existsSync(publicDir) ? publicDir : srcPublicDir;
  app.use(express.static(staticDir));

  // ── Auth routes (unprotected) ──────────────────────────────────────────────

  // GET / → serve index.html (auth check happens client-side via /api/auth/me)
  app.get('/', (_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });

  app.get('/login.html', (_req, res) => {
    res.sendFile(path.join(staticDir, 'login.html'));
  });

  app.get('/auth/google', passport.authenticate('google', { scope: ['email', 'profile'] }));

  app.get(
    '/auth/callback',
    passport.authenticate('google', { failureRedirect: '/login.html' }),
    async (req, res) => {
      const user = req.user as { id: string };
      req.session.userId = user.id;

      try {
        await callbacks.onUserAuthenticated(user.id);
      } catch (err) {
        logger.error(`[Auth] onUserAuthenticated failed for ${user.id}: ${err}`);
      }

      res.redirect('/');
    }
  );

  app.get('/auth/logout', (req, res) => {
    req.session.destroy(() => {
      res.redirect('/login.html');
    });
  });

  app.get('/api/auth/me', (req, res) => {
    if (req.session.userId) {
      res.json({ authenticated: true, userId: req.session.userId });
    } else {
      res.status(401).json({ authenticated: false });
    }
  });

  // ── One-time state upload (no auth — protected by UPLOAD_SECRET header) ───
  app.post('/internal/upload-state', express.json({ limit: '10mb' }), (req, res) => {
    const secret = process.env.UPLOAD_SECRET;
    if (!secret || req.headers['x-upload-secret'] !== secret) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const userId = req.query['userId'] as string;
    if (!userId || !/^[a-z0-9-]+$/.test(userId)) {
      res.status(400).json({ error: 'Invalid userId' });
      return;
    }
    const fs = require('fs') as typeof import('fs');
    const dataDir = process.env.DATA_DIR || path.resolve(__dirname, '..', '..');
    const destPath = path.join(dataDir, `state-${userId}.json`);
    try {
      fs.writeFileSync(destPath, JSON.stringify(req.body, null, 2), 'utf-8');
      logger.info(`[UploadState] Saved ${destPath}`);
      res.json({ ok: true, path: destPath });
    } catch (err) {
      logger.error(`[UploadState] Failed: ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  // ── All /api/* routes require auth ────────────────────────────────────────
  app.use('/api', requireAuth);

  // Ensure engine context is initialized for authenticated users
  // (handles session restore after server restart — onUserAuthenticated only fires on OAuth callback)
  app.use('/api', async (req, _res, next) => {
    try {
      await callbacks.onUserAuthenticated(req.session.userId!);
    } catch (err) {
      logger.error(`[Auth] Failed to initialize engine context for ${req.session.userId}: ${err}`);
    }
    next();
  });

  // ── Authenticated API routes ───────────────────────────────────────────────

  // API: current state
  app.get('/api/state', (req, res) => {
    const store = getStoreForUser(req.session.userId!);
    res.json(store.getState());
  });

  // API: cycle history
  app.get('/api/history', (req, res) => {
    const tokenId = parseInt(req.query.tokenId as string);
    if (isNaN(tokenId)) {
      res.json([]);
      return;
    }
    const store = getStoreForUser(req.session.userId!);
    res.json(store.getHistory(tokenId));
  });

  // API: rebalance events (all positions, from Supabase when available)
  app.get('/api/rebalances', async (req, res) => {
    const userId = req.session.userId!;
    if (config.supabaseUrl && config.supabaseKey) {
      const qTokenId = req.query.tokenId ? parseInt(req.query.tokenId as string) : undefined;
      const activationId = req.query.activationId as string | undefined;
      const records = await fetchRebalances(
        userId !== 'default' ? userId : undefined,
        !isNaN(qTokenId ?? NaN) ? qTokenId : undefined,
        activationId,
      );
      res.json(records);
      return;
    }
    // In-memory fallback
    const store = getStoreForUser(userId);
    const tokenId = parseInt(req.query.tokenId as string);
    if (!isNaN(tokenId)) {
      res.json(store.getRebalanceEvents(tokenId));
    } else {
      res.json(store.getAllRebalanceEvents());
    }
  });

  // API: discovered positions (persisted from last scan via rebalancer state)
  app.get('/api/discovered-positions', (req, res) => {
    const userId = req.session.userId!;
    const ctx = callbacks.getEngineContext(userId);
    if (!ctx) {
      res.json({ positions: [], scannedAt: undefined, scannedNetwork: undefined, scannedWallet: undefined });
      return;
    }
    const { positions, scannedAt, scannedNetwork, scannedWallet } =
      ctx.rebalancer.getScannedPositions();

    const activeTokenIds = new Set(Object.keys(ctx.rebalancer.getState().positions));
    const withStatus = positions.map(p => ({
      ...p,
      isActive: activeTokenIds.has(String(p.tokenId)),
    }));

    res.json({ positions: withStatus, scannedAt, scannedNetwork, scannedWallet });
  });

  // API: scan wallet for Uniswap V3 positions
  app.post('/api/scan-wallet', async (req, res) => {
    const { walletAddress, chain = 'base', dex = 'uniswap-v3' } = req.body as {
      walletAddress?: string;
      chain?: string;
      dex?: string;
    };
    const isEvmAddr = /^0x[0-9a-fA-F]{40}$/.test(walletAddress ?? '');
    const isSolanaAddr = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress ?? '');
    if (!walletAddress || (!isEvmAddr && !isSolanaAddr)) {
      res.status(400).json({ error: 'Invalid wallet address' });
      return;
    }
    logger.info(`[Dashboard] scan-wallet chain=${chain} dex=${dex} addr=${walletAddress}`);
    try {
      const scanner = createWalletScanner(chain as ChainId, dex as DexId);
      const positions = await scanner.scanWallet(walletAddress);
      const store = getStoreForUser(req.session.userId!);
      store.setDiscoveredPositions(positions);
      res.json({ count: positions.length, positions });
    } catch (err) {
      logger.error(`[Dashboard] Wallet scan failed: ${err}`);
      res.status(500).json({ error: 'Scan failed', detail: String(err) });
    }
  });

  // API: scan all supported chains/DEXes in parallel
  app.post('/api/scan-wallet-all', async (req, res) => {
    const { walletAddress, network } = req.body as {
      walletAddress?: string;
      network?: 'evm' | 'solana';
    };

    const isEvmAddr = /^0x[0-9a-fA-F]{40}$/.test(walletAddress ?? '');
    const isSolanaAddr = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress ?? '');

    if (!walletAddress || !network) {
      res.status(400).json({ error: 'walletAddress and network required' });
      return;
    }
    if (network === 'evm' && !isEvmAddr) {
      res.status(400).json({ error: 'Invalid EVM address' });
      return;
    }
    if (network === 'solana' && !isSolanaAddr) {
      res.status(400).json({ error: 'Invalid Solana address' });
      return;
    }

    const userId = req.session.userId!;
    const store = getStoreForUser(userId);
    const ctx = callbacks.getEngineContext(userId);

    logger.info(`[Scanner] scan-all network=${network} addr=${walletAddress}`);

    try {
      let combos: Array<{ chain: ChainId; dex: DexId }>;
      if (network === 'evm') {
        const zapperPositions = await getZapperComplexPositions(walletAddress);
        if (zapperPositions && zapperPositions.length > 0) {
          // Scan only the exact chain:dex pairs that Zapper found positions for
          const zapperCombos = new Set(zapperPositions.map(p => `${p.chainId}:${p.dexId}`));
          combos = [...zapperCombos].map(key => {
            const [chain, dex] = key.split(':') as [ChainId, DexId];
            return { chain, dex };
          });
          logger.info(`[Scanner] Zapper detected ${combos.length} chain:dex combo(s): [${[...zapperCombos].join(', ')}]`);
        } else {
          combos = EVM_CHAIN_DEX_COMBOS;
        }
      } else {
        combos = SOLANA_DEX_COMBOS.map(dex => ({ chain: 'solana' as ChainId, dex }));
      }

      const total = combos.length;
      let done = 0;
      const allPositions: DiscoveredPosition[] = [];
      const seen = new Set<string>();

      const tasks = combos.map(async ({ chain, dex }) => {
        try {
          const scanner = createWalletScanner(chain, dex);
          const found = await scanner.scanWallet(walletAddress);
          for (const p of found) {
            const key = `${p.tokenId}:${chain}:${dex}`;
            if (!seen.has(key)) {
              seen.add(key);
              allPositions.push(p);
            }
          }
        } catch (err) {
          logger.warn(`[Scanner] ${chain}:${dex} failed — ${err}`);
        } finally {
          done++;
          store.emitScanProgress({ done, total, chain: `${chain}:${dex}` });
        }
      });

      await Promise.allSettled(tasks);

      const filtered = allPositions.filter(p => p.estimatedUsd >= 10 || p.estimatedUsd === 0);

      if (ctx) {
        ctx.rebalancer.saveScannedPositions(filtered, network, walletAddress);
      }
      store.setDiscoveredPositions(filtered);

      res.json({ count: filtered.length, positions: filtered });
    } catch (err) {
      logger.error(`[Scanner] scan-all failed: ${err}`);
      res.status(500).json({ error: 'Scan failed', detail: String(err) });
    }
  });

  // API: lookup a single position by tokenId (bypasses wallet ownership check)
  app.post('/api/lookup-position', async (req, res) => {
    const { tokenId, chain = 'base', dex = 'uniswap-v3' } = req.body as {
      tokenId?: number;
      chain?: string;
      dex?: string;
    };
    if (typeof tokenId !== 'number') {
      res.status(400).json({ error: 'tokenId required' });
      return;
    }
    try {
      const scanner = createWalletScanner(chain as ChainId, dex as DexId);
      const position = await scanner.lookupById(tokenId);
      if (!position) {
        res.status(404).json({ error: 'Position not found or has no liquidity' });
        return;
      }
      const positions = [position];
      const store = getStoreForUser(req.session.userId!);
      store.setDiscoveredPositions(positions);
      res.json({ found: true, position });
    } catch (err) {
      logger.error(`[Dashboard] Position lookup failed: ${err}`);
      res.status(500).json({ error: 'Lookup failed', detail: String(err) });
    }
  });

  // API: activate protection for a position
  app.post('/api/activate-position', (req, res) => {
    const body = req.body as Partial<ActivatePositionRequest>;
    if (
      typeof body.tokenId !== 'number' ||
      typeof body.poolAddress !== 'string' ||
      !/^0x[0-9a-fA-F]{40,64}$/.test(body.poolAddress)
    ) {
      logger.warn(`[Dashboard] Invalid activation request: tokenId=${body.tokenId} poolAddress=${body.poolAddress}`);
      res.status(400).json({ error: 'Invalid activation request', detail: `poolAddress=${body.poolAddress}` });
      return;
    }
    const protocolVersion = body.protocolVersion || 'v3';
    const request: ActivatePositionRequest = {
      tokenId: body.tokenId,
      protocolVersion,
      poolAddress: body.poolAddress,
      token0Symbol: body.token0Symbol ?? '',
      token1Symbol: body.token1Symbol ?? '',
      fee: body.fee,
      tickLower: body.tickLower,
      tickUpper: body.tickUpper,
      protectionType: body.protectionType,
      hedgeRatio: body.hedgeRatio,
      cooldownSeconds: body.cooldownSeconds,
      emergencyPriceMovementThreshold: body.emergencyPriceMovementThreshold,
      chain: (body.chain ?? 'base') as ChainId,
      dex: (body.dex ?? (protocolVersion === 'v4' ? 'uniswap-v4' : 'uniswap-v3')) as DexId,
      positionId: body.tokenId,
    };
    const store = getStoreForUser(req.session.userId!);
    store.requestActivation(request);
    res.json({ queued: true, tokenId: request.tokenId });
  });

  // API: update config for active position
  app.post('/api/update-config', (req, res) => {
    const { tokenId, ...cfg } = req.body;
    if (typeof tokenId !== 'number') {
      res.status(400).json({ error: 'tokenId required' });
      return;
    }
    const store = getStoreForUser(req.session.userId!);
    store.requestConfigUpdate(tokenId, cfg);
    res.json({ success: true });
  });

  app.post('/api/deactivate-position', (req, res) => {
    const { tokenId } = req.body;
    if (typeof tokenId !== 'number') {
      res.status(400).json({ error: 'tokenId required' });
      return;
    }
    const store = getStoreForUser(req.session.userId!);
    store.requestDeactivation(tokenId);
    res.json({ success: true });
  });

  app.post('/api/refresh-lp', (req, res) => {
    const { tokenId } = req.body;
    if (typeof tokenId !== 'number') {
      res.status(400).json({ error: 'tokenId required' });
      return;
    }
    const store = getStoreForUser(req.session.userId!);
    store.requestLpRefresh(tokenId);
    res.json({ success: true });
  });

  // API: position history (closed positions)
  app.get('/api/position-history', async (req, res) => {
    const userId = req.session.userId!;
    if (config.supabaseUrl && config.supabaseKey) {
      const records = await fetchClosedPositions(userId);
      const history: HistoricalPosition[] = records.map(r => ({
        tokenId: r.token_id,
        poolAddress: r.pool_address ?? '',
        protocolVersion: (r.protocol_version as 'v3' | 'v4') ?? 'v3',
        token0Symbol: r.token0_symbol ?? '',
        token1Symbol: r.token1_symbol ?? '',
        fee: r.fee ?? 0,
        tickLower: r.tick_lower ?? 0,
        tickUpper: r.tick_upper ?? 0,
        hedgeSymbol: r.hedge_symbol ?? '',
        activatedAt: r.activated_at ? new Date(r.activated_at).getTime() : 0,
        deactivatedAt: r.deactivated_at ? new Date(r.deactivated_at).getTime() : 0,
        initialLpUsd: r.initial_lp_usd ?? 0,
        initialHlUsd: r.initial_hl_usd ?? 0,
        finalLpFeesUsd: r.final_lp_fees_usd ?? 0,
        finalCumulativeFundingUsd: r.final_cumulative_funding_usd ?? 0,
        finalCumulativeHlFeesUsd: r.final_cumulative_hl_fees_usd ?? 0,
        finalVirtualPnlUsd: r.final_virtual_pnl_usd ?? 0,
        finalVirtualPnlPercent: r.final_virtual_pnl_pct ?? 0,
        finalUnrealizedPnlUsd: r.final_unrealized_pnl_usd ?? 0,
        finalRealizedPnlUsd: r.final_realized_pnl_usd ?? 0,
        priceLowerUsd: r.price_lower_usd ?? undefined,
        priceUpperUsd: r.price_upper_usd ?? undefined,
        activationId: r.activation_id ?? undefined,
      }));
      res.json(history);
    } else {
      const store = getStoreForUser(userId);
      res.json(store.getPositionHistory());
    }
  });

  // API: reset PnL baseline for a position
  app.post('/api/reset-pnl', (req, res) => {
    const { tokenId, initialLpUsd, initialHlUsd } = req.body as {
      tokenId?: number;
      initialLpUsd?: number;
      initialHlUsd?: number;
    };
    if (typeof tokenId !== 'number' || typeof initialLpUsd !== 'number' || typeof initialHlUsd !== 'number') {
      res.status(400).json({ error: 'tokenId, initialLpUsd and initialHlUsd required' });
      return;
    }
    const store = getStoreForUser(req.session.userId!);
    store.requestResetPnl(tokenId, initialLpUsd, initialHlUsd);
    res.json({ success: true });
  });

  // API: derive signer address from private key (for UI validation hint)
  app.post('/api/derive-address', (req, res) => {
    const { privateKey } = req.body as { privateKey?: string };
    if (!privateKey) { res.status(400).json({ error: 'privateKey required' }); return; }
    try {
      const address = ethers.computeAddress(privateKey.startsWith('0x') ? privateKey : '0x' + privateKey);
      res.json({ address });
    } catch {
      res.status(400).json({ error: 'Invalid private key' });
    }
  });

  // API: credentials status
  app.get('/api/credentials/status', (req, res) => {
    const store = getStoreForUser(req.session.userId!);
    res.json(store.getCredentialsStatus());
  });

  // API: save credentials and trigger live exchange swap
  app.post('/api/credentials', (req, res) => {
    const { privateKey, walletAddress } = req.body as { privateKey?: string; walletAddress?: string };
    if (!privateKey || !walletAddress || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
      res.status(400).json({ error: 'privateKey and valid walletAddress required' });
      return;
    }
    const userId = req.session.userId!;
    callbacks.hotSwapExchange(userId, privateKey, walletAddress);

    // Persist credentials to DB so they survive server restarts
    if (supabaseServiceClient) {
      saveCredentials(supabaseServiceClient, userId, privateKey, walletAddress).catch(err =>
        logger.error(`[Credentials] Failed to persist for ${userId}: ${err}`)
      );
    }

    res.json({ queued: true });
  });

  // SSE: real-time updates
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');

    const store = getStoreForUser(req.session.userId!);

    const onUpdate = (data: unknown) => {
      res.write(`event: update\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const onRebalance = (event: unknown) => {
      res.write(`event: rebalance\ndata: ${JSON.stringify(event)}\n\n`);
    };

    const onActivationResult = (result: unknown) => {
      res.write(`event: activationResult\ndata: ${JSON.stringify(result)}\n\n`);
    };

    const onPositionsDiscovered = (positions: unknown) => {
      res.write(`event: positionsDiscovered\ndata: ${JSON.stringify(positions)}\n\n`);
    };

    const onCredentials = (d: unknown) => {
      res.write(`event: credentialsUpdated\ndata: ${JSON.stringify(d)}\n\n`);
    };

    const onConfigUpdated = (cfg: unknown) => {
      res.write(`event: configUpdated\ndata: ${JSON.stringify(cfg)}\n\n`);
    };

    const onScanProgress = (payload: unknown) => {
      res.write(`event: scanProgress\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    store.on('update', onUpdate);
    store.on('rebalance', onRebalance);
    store.on('activationComplete', onActivationResult);
    store.on('positionsDiscovered', onPositionsDiscovered);
    store.on('credentialsUpdated', onCredentials);
    store.on('configUpdated', onConfigUpdated);
    store.on('scanProgress', onScanProgress);

    // Keepalive: evita que o navegador encerre a conexão SSE por inatividade
    const keepalive = setInterval(() => {
      res.write(':keepalive\n\n');
    }, 15_000);

    req.on('close', () => {
      clearInterval(keepalive);
      store.off('update', onUpdate);
      store.off('rebalance', onRebalance);
      store.off('activationComplete', onActivationResult);
      store.off('positionsDiscovered', onPositionsDiscovered);
      store.off('credentialsUpdated', onCredentials);
      store.off('configUpdated', onConfigUpdated);
      store.off('scanProgress', onScanProgress);
    });
  });

  app.listen(port, () => {
    logger.info(`Dashboard running at http://localhost:${port}`);
  });
}
