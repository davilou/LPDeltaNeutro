import express from 'express';
import path from 'path';
import { dashboardStore, ActivatePositionRequest, SaveCredentialsRequest } from './store';
import { WalletScanner } from '../lp/walletScanner';
import { logger } from '../utils/logger';

export function startDashboard(port: number): void {
  const app = express();

  app.use(express.json());

  // Serve static files — works both with ts-node (src/) and compiled (dist/)
  const publicDir = path.resolve(__dirname, 'public');
  const srcPublicDir = path.resolve(__dirname, '..', '..', 'src', 'dashboard', 'public');
  const fs = require('fs');
  app.use(express.static(fs.existsSync(publicDir) ? publicDir : srcPublicDir));

  // API: current state
  app.get('/api/state', (_req, res) => {
    res.json(dashboardStore.getState());
  });

  // API: cycle history
  app.get('/api/history', (req, res) => {
    const tokenId = parseInt(req.query.tokenId as string);
    if (isNaN(tokenId)) {
      res.json([]);
      return;
    }
    res.json(dashboardStore.getHistory(tokenId));
  });

  // API: rebalance events
  app.get('/api/rebalances', (req, res) => {
    const tokenId = parseInt(req.query.tokenId as string);
    if (isNaN(tokenId)) {
      res.json([]);
      return;
    }
    res.json(dashboardStore.getRebalanceEvents(tokenId));
  });

  // API: discovered positions (cached from last scan)
  app.get('/api/discovered-positions', (_req, res) => {
    res.json(dashboardStore.getDiscoveredPositions());
  });

  // API: scan wallet for Uniswap V3 positions
  app.post('/api/scan-wallet', async (req, res) => {
    const { walletAddress } = req.body as { walletAddress?: string };
    if (!walletAddress || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
      res.status(400).json({ error: 'Invalid wallet address' });
      return;
    }
    try {
      const scanner = new WalletScanner();
      const positions = await scanner.scanWallet(walletAddress);
      dashboardStore.setDiscoveredPositions(positions);
      res.json({ count: positions.length, positions });
    } catch (err) {
      logger.error(`[Dashboard] Wallet scan failed: ${err}`);
      res.status(500).json({ error: 'Scan failed', detail: String(err) });
    }
  });

  // API: activate protection for a position
  app.post('/api/activate-position', (req, res) => {
    const body = req.body as Partial<ActivatePositionRequest>;
    if (
      typeof body.tokenId !== 'number' ||
      typeof body.poolAddress !== 'string' ||
      !/^0x[0-9a-fA-F]{40}$/.test(body.poolAddress)
    ) {
      res.status(400).json({ error: 'Invalid activation request' });
      return;
    }
    const request: ActivatePositionRequest = {
      tokenId: body.tokenId,
      protocolVersion: body.protocolVersion || 'v3',
      poolAddress: body.poolAddress,
      token0Symbol: body.token0Symbol ?? '',
      token1Symbol: body.token1Symbol ?? '',
      protectionType: body.protectionType,
      hedgeRatio: body.hedgeRatio,
      cooldownSeconds: body.cooldownSeconds,
      deltaMismatchThreshold: body.deltaMismatchThreshold,
      emergencyMismatchThreshold: body.emergencyMismatchThreshold,
      emergencyHedgeRatio: body.emergencyHedgeRatio,
    };
    dashboardStore.requestActivation(request);
    res.json({ queued: true, tokenId: request.tokenId });
  });

  // API: update config for active position
  app.post('/api/update-config', (req, res) => {
    const { tokenId, ...cfg } = req.body;
    if (typeof tokenId !== 'number') {
      res.status(400).json({ error: 'tokenId required' });
      return;
    }
    dashboardStore.requestConfigUpdate(tokenId, cfg);
    res.json({ success: true });
  });

  app.post('/api/deactivate-position', (req, res) => {
    const { tokenId } = req.body;
    if (typeof tokenId !== 'number') {
      res.status(400).json({ error: 'tokenId required' });
      return;
    }
    dashboardStore.requestDeactivation(tokenId);
    res.json({ success: true });
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
    dashboardStore.requestResetPnl(tokenId, initialLpUsd, initialHlUsd);
    res.json({ success: true });
  });

  // API: credentials status
  app.get('/api/credentials/status', (_req, res) => {
    res.json(dashboardStore.getCredentialsStatus());
  });

  // API: save credentials and trigger live exchange swap
  app.post('/api/credentials', (req, res) => {
    const { privateKey, walletAddress } = req.body as { privateKey?: string; walletAddress?: string };
    if (!privateKey || !walletAddress || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
      res.status(400).json({ error: 'privateKey and valid walletAddress required' });
      return;
    }
    const request: SaveCredentialsRequest = { privateKey, walletAddress };
    dashboardStore.requestCredentialsSave(request);
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

    dashboardStore.on('update', onUpdate);
    dashboardStore.on('rebalance', onRebalance);
    dashboardStore.on('activationComplete', onActivationResult);
    dashboardStore.on('positionsDiscovered', onPositionsDiscovered);
    dashboardStore.on('credentialsUpdated', onCredentials);
    dashboardStore.on('configUpdated', onConfigUpdated);

    // Keepalive: evita que o navegador encerre a conexão SSE por inatividade
    const keepalive = setInterval(() => {
      res.write(':keepalive\n\n');
    }, 15_000);

    req.on('close', () => {
      clearInterval(keepalive);
      dashboardStore.off('update', onUpdate);
      dashboardStore.off('rebalance', onRebalance);
      dashboardStore.off('activationComplete', onActivationResult);
      dashboardStore.off('positionsDiscovered', onPositionsDiscovered);
      dashboardStore.off('credentialsUpdated', onCredentials);
      dashboardStore.off('configUpdated', onConfigUpdated);
    });
  });

  app.listen(port, () => {
    logger.info(`Dashboard running at http://localhost:${port}`);
  });
}
