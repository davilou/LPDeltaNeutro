import { ethers } from 'ethers';
import { config } from './config';
import { UniswapReader } from './lp/uniswapReader';
import { MockExchange } from './hedge/mockExchange';
import { HyperliquidExchange } from './hedge/hyperliquidExchange';
import { Rebalancer } from './engine/rebalancer';
import { logger } from './utils/logger';
import { startDashboard } from './dashboard/server';
import { dashboardStore, ActivatePositionRequest, SaveCredentialsRequest } from './dashboard/store';
import { ActivePositionConfig } from './types';
import { readCredentials, writeCredentials } from './credentials';

const BLOCK_TIMEOUT_MS = 5 * 60_000;    // 5min
const WATCHDOG_INTERVAL_MS = 15_000;   // 15s

async function main() {
  logger.info('=== Delta-Neutral LP Bot V2 (Multi-Position) Starting ===');
  logger.info(`Dry run: ${config.dryRun}`);
  logger.info(`Block throttle: every ${config.blockThrottle} blocks`);

  const reader = new UniswapReader();

  function createExchange() {
    const saved = readCredentials();
    if (saved) {
      logger.info(`[Init] Using saved credentials for ${saved.walletAddress}`);
      return new HyperliquidExchange(saved.privateKey, saved.walletAddress);
    }
    if (!config.dryRun && config.hlPrivateKey) {
      return new HyperliquidExchange(config.hlPrivateKey, config.hlWalletAddress);
    }
    logger.info('[Init] No credentials found — using MockExchange (dry-run)');
    return new MockExchange(0.01);
  }

  let exchange = createExchange();
  const rebalancer = new Rebalancer(exchange);

  // Set initial credentials status in dashboard
  const savedCreds = readCredentials();
  if (savedCreds) {
    dashboardStore.setCredentialsStatus(savedCreds.walletAddress);
  } else if (!config.dryRun && config.hlPrivateKey) {
    dashboardStore.setCredentialsStatus(config.hlWalletAddress);
  }

  startDashboard(config.dashboardPort);

  // Restore previously active positions from state.json
  const restoredPositions = rebalancer.getRestoredPositions();
  for (const pos of restoredPositions) {
    dashboardStore.setActivePositionConfig(pos.tokenId, pos);

    // Restore rebalance history for dashboard
    const ps = rebalancer.fullState.positions[pos.tokenId];
    if (ps && ps.rebalances) {
      for (const event of ps.rebalances) {
        dashboardStore.addRebalanceEvent(event);
      }
    }
    logger.info(`Restored active position: NFT #${pos.tokenId}, pool ${pos.poolAddress} (${ps?.rebalances?.length || 0} events)`);

    // Populate dashboard with last known state data immediately
    if (ps) {
      dashboardStore.update({
        tokenId: pos.tokenId,
        timestamp: ps.lastRebalanceTimestamp || Date.now(),
        token0Amount: 0, // values will be updated on first cycle
        token0Symbol: ps.config.hedgeToken === 'token0' ? (ps.config.hedgeSymbol || 'token0') : 'token0',
        token1Amount: 0,
        token1Symbol: ps.config.hedgeToken === 'token1' ? (ps.config.hedgeSymbol || 'token1') : 'token1',
        price: ps.lastPrice || 0,
        totalPositionUsd: 0,
        hedgeSize: ps.lastHedge.size || 0,
        hedgeNotionalUsd: ps.lastHedge.notionalUsd || 0,
        hedgeSide: ps.lastHedge.side || 'none',
        fundingRate: 0,
        netDelta: 0,
        rangeStatus: '-',
        dailyRebalanceCount: ps.dailyRebalanceCount || 0,
        lastRebalanceTimestamp: ps.lastRebalanceTimestamp || 0,
        pnlTotalUsd: ps.pnl?.virtualPnlUsd ?? 0,
        pnlTotalPercent: 0,
        accountPnlUsd: 0,
        accountPnlPercent: 0,
        unrealizedPnlUsd: 0,
        realizedPnlUsd: ps.pnl?.realizedPnlUsd ?? 0,
        lpFeesUsd: ps.pnl?.initialLpFeesUsd ?? 0,
        cumulativeFundingUsd: ps.pnl?.cumulativeFundingUsd ?? 0,
        cumulativeHlFeesUsd: ps.pnl?.cumulativeHlFeesUsd ?? 0,
        initialTotalUsd: (ps.pnl?.initialLpUsd || 0) + (ps.pnl?.initialHlUsd || 0),
        currentTotalUsd: 0,
        hlEquity: 0,
      });
    }
  }

  let blockCount = 0;
  let running = true;
  let lastBlockTime = Date.now();
  let activeWs: ethers.WebSocketProvider | null = null;
  let activationInProgress = false;

  const shutdown = () => {
    if (!running) return;
    running = false;
    logger.info('Shutting down gracefully...');
    rebalancer.saveState();
    logger.info('State saved. Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Activation event: dashboard POST → reads baselines → reinitializes PnL → saves state
  dashboardStore.on('activatePosition', async (req: ActivatePositionRequest) => {
    if (activationInProgress) {
      dashboardStore.notifyActivationResult({
        success: false,
        tokenId: req.tokenId,
        error: 'Another activation in progress',
      });
      return;
    }
    activationInProgress = true;
    logger.info(`[Activation] Request for NFT #${req.tokenId}, pool ${req.poolAddress}`);
    try {
      const position = await reader.readPosition(req.tokenId, req.poolAddress, req.protocolVersion);
      const initialFeesUsd = position.tokensOwed0 * position.price + position.tokensOwed1;
      const initialLpUsd =
        position.token0.amountFormatted * position.price + position.token1.amountFormatted + initialFeesUsd;
      const initialHlUsd = await exchange.getAccountEquity();

      // Determine hedge symbol from volatile token
      const hedgeSymbol = req.token0Symbol && req.token0Symbol !== 'USDC' && req.token0Symbol !== 'USDT' && req.token0Symbol !== 'USDbC' && req.token0Symbol !== 'DAI'
        ? req.token0Symbol
        : req.token1Symbol;

      const hedgeToken: 'token0' | 'token1' = hedgeSymbol === req.token0Symbol ? 'token0' : 'token1';

      const cfg: ActivePositionConfig = {
        tokenId: req.tokenId,
        protocolVersion: req.protocolVersion,
        poolAddress: req.poolAddress,
        activatedAt: Date.now(),
        hedgeSymbol,
        hedgeToken,
        protectionType: req.protectionType || 'delta-neutral',
        hedgeRatio: req.hedgeRatio ?? 1.0,
        cooldownSeconds: req.cooldownSeconds ?? config.cooldownSeconds,
        deltaMismatchThreshold: req.deltaMismatchThreshold ?? config.deltaMismatchThreshold,
        emergencyMismatchThreshold: req.emergencyMismatchThreshold ?? config.emergencyMismatchThreshold,
        emergencyHedgeRatio: req.emergencyHedgeRatio ?? config.emergencyHedgeRatio,
      };

      rebalancer.getPnlTracker(req.tokenId).reinitialize(initialLpUsd, initialHlUsd, initialFeesUsd);
      rebalancer.activatePosition(cfg);
      dashboardStore.setActivePositionConfig(req.tokenId, cfg);

      logger.info(
        `[Activation] NFT #${req.tokenId} (${req.protocolVersion}) activated: LP=$${initialLpUsd.toFixed(2)} HL=$${initialHlUsd.toFixed(2)} hedge=${hedgeSymbol} ratio=${cfg.hedgeRatio}`
      );
      dashboardStore.notifyActivationResult({
        success: true,
        tokenId: req.tokenId,
        initialLpUsd,
        initialHlUsd,
      });
    } catch (err) {
      logger.error(`[Activation] Failed for NFT #${req.tokenId}: ${err}`);
      dashboardStore.notifyActivationResult({
        success: false,
        tokenId: req.tokenId,
        error: String(err),
      });
    } finally {
      activationInProgress = false;
    }
  });

  // Position Config Update event
  dashboardStore.on('configUpdated', (cfg: ActivePositionConfig) => {
    rebalancer.updateConfig(cfg.tokenId, cfg);
  });

  // Position Deactivation event
  dashboardStore.on('deactivatePosition', async (tokenId: number) => {
    // Snapshot necessary data BEFORE removing from tracking
    const ps = rebalancer.fullState.positions[tokenId];
    const hedgeSymbol = ps?.config.hedgeSymbol;
    const virtualSize = rebalancer.getPnlTracker(tokenId).getVirtualState().size;
    const lastPrice = ps?.lastPrice || 0;

    // Remove from active tracking IMMEDIATELY — prevents any in-flight cycle from
    // re-processing this position while the async HL close is in progress
    rebalancer.deactivatePosition(tokenId);
    dashboardStore.setActivePositionConfig(tokenId, null);
    logger.info(`[Activation] NFT #${tokenId} removed from tracking — closing HL position...`);

    try {
      if (hedgeSymbol) {
        const currentHedge = await exchange.getPosition(hedgeSymbol);

        if (currentHedge.size > 0) {
          // Always close the full actual HL position on deactivation.
          // Subtracting virtualSize is unreliable after restarts (tracker resets to 0
          // while the real position remains open), which would leave a residual short.
          logger.info(`[Activation] NFT #${tokenId}: closing full HL position of ${currentHedge.size.toFixed(4)} ${hedgeSymbol} (virtual tracked: ${virtualSize.toFixed(4)})`);
          await exchange.closePosition(hedgeSymbol);
        } else {
          logger.info(`[Activation] NFT #${tokenId}: no open HL position to close`);
        }
      }
    } catch (err) {
      logger.error(`[Activation] Error closing hedge during deactivation for NFT #${tokenId}: ${err}`);
    }

    logger.info(`[Activation] NFT #${tokenId} deactivation complete`);
  });

  // PnL reset event: dashboard POST → reinitializes tracker baseline
  dashboardStore.on('resetPnl', ({ tokenId, initialLpUsd, initialHlUsd }: { tokenId: number; initialLpUsd: number; initialHlUsd: number }) => {
    const tracker = rebalancer.getPnlTracker(tokenId);
    tracker.reinitialize(initialLpUsd, initialHlUsd);
    rebalancer.saveState();
    logger.info(`[PnL Reset] NFT #${tokenId}: LP=$${initialLpUsd.toFixed(2)} HL=$${initialHlUsd.toFixed(2)}`);
  });

  // Credentials event: dashboard POST → hot-swap exchange
  dashboardStore.on('saveCredentials', async (req: SaveCredentialsRequest) => {
    try {
      writeCredentials(req.privateKey, req.walletAddress);
      const newExchange = new HyperliquidExchange(req.privateKey, req.walletAddress);
      rebalancer.setExchange(newExchange);
      exchange = newExchange;
      dashboardStore.setCredentialsStatus(req.walletAddress);
      logger.info(`[Credentials] Live exchange activated for ${req.walletAddress}`);
    } catch (err) {
      logger.error(`[Credentials] Failed to activate: ${err}`);
    }
  });

  async function runCycleForAllPositions() {
    // rebalancer.fullState.positions is the authoritative source (persisted to state.json).
    // dashboardStore.activePositions is derived/in-memory. If they diverge, the rebalancer wins.
    const positionsState = rebalancer.fullState.positions;
    const tokenIds = Object.keys(positionsState).map(Number);

    if (tokenIds.length === 0) {
      return;
    }

    for (const tokenId of tokenIds) {
      const cfg = positionsState[tokenId].config;

      // Auto-sync: if rebalancer has a position the dashboard doesn't know about,
      // re-register it so the user can see and deactivate it via the dashboard.
      if (!dashboardStore.getActivePositionConfig(tokenId)) {
        logger.warn(`[Cycle] NFT #${tokenId} present in rebalancer state but missing from dashboard — re-syncing`);
        dashboardStore.setActivePositionConfig(tokenId, cfg);
      }

      try {
        logger.info(`[Cycle] Processing NFT #${tokenId} (${cfg.protocolVersion})...`);
        const position = await reader.readPosition(tokenId, cfg.poolAddress, cfg.protocolVersion);
        logger.info(`[Cycle] Position data read for #${tokenId}. Running rebalancer logic...`);
        await rebalancer.cycle(tokenId, position);
        logger.info(`[Cycle] Logic complete for #${tokenId}.`);
      } catch (err) {
        logger.error(`[NFT#${tokenId}] Cycle error: ${err}`);
      }
    }
  }

  let wsReconnectDelay = 5_000;
  function connectWebSocket(): void {
    if (!running) return;

    if (activeWs) {
      try { (activeWs as any).destroy(); } catch { }
      activeWs = null;
    }

    let ws: ethers.WebSocketProvider;
    try {
      ws = new ethers.WebSocketProvider(config.wsUrl);
    } catch (err) {
      logger.error(`WebSocket connect failed: ${err} — retrying in ${wsReconnectDelay / 1000}s`);
      setTimeout(connectWebSocket, wsReconnectDelay);
      wsReconnectDelay = Math.min(wsReconnectDelay * 2, 60_000);
      return;
    }

    activeWs = ws;

    // Reset backoff ONLY if we stay connected for at least 30s
    const stabilityTimer = setTimeout(() => {
      if (activeWs === ws) {
        wsReconnectDelay = 5_000;
      }
    }, 30_000);

    // Detecta queda da conexão e reconecta
    const rawWs = (ws as any)._websocket ?? (ws as any).websocket;
    if (rawWs?.on) {
      rawWs.on('close', (code: number, reason: Buffer) => {
        clearTimeout(stabilityTimer);
        if (!running || activeWs !== ws) return;
        const reasonStr = reason?.toString() || 'no reason';
        logger.warn(`WebSocket closed (code: ${code}, reason: ${reasonStr}) — reconnecting in ${wsReconnectDelay / 1000}s...`);
        activeWs = null;
        setTimeout(connectWebSocket, wsReconnectDelay);
        wsReconnectDelay = Math.min(wsReconnectDelay * 2, 60_000);
      });
      rawWs.on('error', (err: any) => {
        if (!running || activeWs !== ws) return;
        logger.warn(`WebSocket error: ${err?.message || JSON.stringify(err)}`);
      });
    }

    ws.on('block', async (blockNumber: number) => {
      if (!running || activeWs !== ws) return;

      lastBlockTime = Date.now();
      blockCount++;

      // Run on FIRST block and then every config.blockThrottle blocks
      if (blockCount !== 1 && blockCount % config.blockThrottle !== 0) return;

      const activePositions = dashboardStore.getAllActivePositions();
      if (Object.keys(activePositions).length === 0) {
        logger.info(`Block ${blockNumber}: no active positions — awaiting dashboard activation`);
        return;
      }

      logger.info(`--- Block ${blockNumber} (cycle #${blockCount / config.blockThrottle}) ---`);

      await runCycleForAllPositions();
    });

    logger.info('WebSocket connected');
  }

  // Watchdog & Polling Fallback
  let lastPolledBlock = 0;
  const watchdog = setInterval(async () => {
    if (!running) {
      clearInterval(watchdog);
      return;
    }

    const elapsed = Date.now() - lastBlockTime;

    // If no blocks for 1 min, or WebSocket is down, try polling via HTTP Provider
    if (elapsed > 60_000 || !activeWs) {
      try {
        const block = await reader.getBlockNumber();
        if (block > lastPolledBlock) {
          const diff = lastPolledBlock === 0 ? 1 : block - lastPolledBlock;
          lastPolledBlock = block;
          lastBlockTime = Date.now();
          logger.info(`[Polling] New blocks detected: ${block} (+${diff})`);

          blockCount += diff;
          const lastThrottleCount = Math.floor((blockCount - diff) / config.blockThrottle);
          const currentThrottleCount = Math.floor(blockCount / config.blockThrottle);

          if (blockCount === diff || currentThrottleCount > lastThrottleCount) {
            await runCycleForAllPositions();
          }
        }
      } catch (err: any) {
        logger.warn(`[Polling] New block check failed: ${err?.message || err}`);
      }
    }

    if (elapsed > BLOCK_TIMEOUT_MS) {
      logger.warn(`No blocks for ${BLOCK_TIMEOUT_MS / 1000}s — forcing WebSocket reconnect...`);
      if (activeWs) try { (activeWs as any).destroy(); } catch { }
      activeWs = null;
      lastBlockTime = Date.now();
      connectWebSocket();
    }
  }, WATCHDOG_INTERVAL_MS);

  // Ciclo inicial
  if (restoredPositions.length > 0) {
    try {
      logger.info('Running initial cycle for all restored positions...');
      await runCycleForAllPositions();
    } catch (err) {
      logger.error(`Initial cycle failed: ${err}`);
    }
  } else {
    logger.info('No positions configured — skipping initial cycle. Use dashboard to activate positions.');
  }

  connectWebSocket();
  logger.info('Listening for new blocks...');
}

main().catch((err) => {
  logger.error(`Fatal error: ${err}`);
  process.exit(1);
});
