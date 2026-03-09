import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { createLPReader } from './lp/lpReaderFactory';
import type { ChainId, DexId, ILPReader, PositionId } from './lp/types';
import { EvmV4Reader } from './lp/readers/evmV4Reader';
import { MockExchange } from './hedge/mockExchange';
import { HyperliquidExchange } from './hedge/hyperliquidExchange';
import { Rebalancer } from './engine/rebalancer';
import { logger, priceLogger } from './utils/logger';
import { startDashboard, DashboardCallbacks } from './dashboard/server';
import { getStoreForUser, ActivatePositionRequest } from './dashboard/store';
import { ActivePositionConfig, PnlSnapshot } from './types';
import { insertClosedPosition, supabaseServiceClient, upsertProtectionActivation, fetchProtectionActivation } from './db/supabase';
import { loadCredentials as loadDbCredentials } from './auth/userStore';
import { fetchPoolPrice, poolPriceCache, getCachedPrice, isChainPriceSupported, STABLE_SYMBOLS } from './utils/priceApi';
import { IHedgeExchange, HlIsolatedPnl } from './hedge/types';
import './auth/types';

const PRICE_POLL_INTERVAL_MS = 30_000; // 30s — keep below API rate limits
const PRICE_POLL_INTER_REQUEST_MS = 500; // delay between pool price requests

interface UserEngineContext {
  rebalancer: Rebalancer;
  exchange: IHedgeExchange;
  /** Reusable readers keyed by "chain:dex" — preserves internal TTL cache across cycles. */
  readers: Map<string, ILPReader>;
  activationsInProgress: Set<PositionId>;
  deactivationsInProgress: Set<PositionId>;
}

function getOrCreateReader(ctx: UserEngineContext, chain: ChainId, dex: DexId): ILPReader {
  const key = `${chain}:${dex}`;
  if (!ctx.readers.has(key)) ctx.readers.set(key, createLPReader(chain, dex));
  return ctx.readers.get(key)!;
}

const engineContexts = new Map<string, UserEngineContext>();

async function createExchangeForUser(userId: string): Promise<IHedgeExchange> {
  // Try DB credentials first
  if (supabaseServiceClient) {
    try {
      const creds = await loadDbCredentials(supabaseServiceClient, userId);
      if (creds) {
        logger.info(`[Init] Using DB credentials for user ${userId}`);
        return new HyperliquidExchange(creds.privateKey, creds.walletAddress);
      }
    } catch (err) {
      logger.warn(`[Init] Failed to load DB credentials for ${userId}: ${err}`);
    }
  }

  // Fall back to env credentials (only for default/single-user mode)
  if (!config.dryRun && config.hlPrivateKey && userId === 'default') {
    return new HyperliquidExchange(config.hlPrivateKey, config.hlWalletAddress);
  }

  logger.info(`[Init] No credentials found for user ${userId} — using MockExchange`);
  return new MockExchange(0.01);
}

function setupUserEventHandlers(userId: string, ctx: UserEngineContext): void {
  const store = getStoreForUser(userId);

  // Activation event: dashboard POST → reads baselines → reinitializes PnL → saves state
  store.on('activatePosition', async (activReq: ActivatePositionRequest) => {
    if (ctx.activationsInProgress.has(activReq.tokenId)) {
      store.notifyActivationResult({
        success: false,
        tokenId: activReq.tokenId,
        error: 'Activation already in progress for this position',
      });
      return;
    }
    ctx.activationsInProgress.add(activReq.tokenId);
    logger.info(`[Activation] Request for NFT #${activReq.tokenId}, pool ${activReq.poolAddress} (user: ${userId})`);

    try {
      const activChain = (activReq.chain ?? 'base') as ChainId;
      const activDex = (activReq.dex ?? (activReq.protocolVersion === 'v4' ? 'uniswap-v4' : 'uniswap-v3')) as DexId;
      const activReader = createLPReader(activChain, activDex);
      const position = await activReader.readPosition(activReq.tokenId, activReq.poolAddress);
      const initialHlUsd = await ctx.exchange.getAccountEquity();

      const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'USDbC', 'DAI', 'USDS', 'crvUSD']);
      const HL_SYMBOL_MAP: Record<string, string> = { WETH: 'ETH', WBTC: 'BTC', cbBTC: 'BTC', cbETH: 'ETH', wstETH: 'ETH', WHYPE: 'HYPE' };

      const t0Symbol = position.token0.symbol;
      const t1Symbol = position.token1.symbol;
      const rawVolatileSymbol = !STABLE_SYMBOLS.has(t0Symbol) ? t0Symbol : t1Symbol;
      const hedgeSymbol = HL_SYMBOL_MAP[rawVolatileSymbol] ?? rawVolatileSymbol;
      const hedgeToken: 'token0' | 'token1' = rawVolatileSymbol === t0Symbol ? 'token0' : 'token1';

      const volatilePriceUsd = hedgeToken === 'token0' ? position.price : 1 / position.price;
      const initialFeesUsd = hedgeToken === 'token0'
        ? position.tokensOwed0 * position.price + position.tokensOwed1
        : position.tokensOwed0 + position.tokensOwed1 * volatilePriceUsd;
      const initialLpUsd = hedgeToken === 'token0'
        ? position.token0.amountFormatted * position.price + position.token1.amountFormatted + initialFeesUsd
        : position.token0.amountFormatted + position.token1.amountFormatted * volatilePriceUsd + initialFeesUsd;

      const cfg: ActivePositionConfig = {
        tokenId: activReq.tokenId,
        protocolVersion: activReq.protocolVersion,
        poolAddress: activReq.poolAddress,
        activatedAt: Date.now(),
        hedgeSymbol,
        hedgeToken,
        protectionType: activReq.protectionType || 'delta-neutral',
        hedgeRatio: activReq.hedgeRatio ?? 1.0,
        cooldownSeconds: activReq.cooldownSeconds,
        emergencyPriceMovementThreshold: activReq.emergencyPriceMovementThreshold ?? config.emergencyPriceMovementThreshold,
        token0Symbol: activReq.token0Symbol,
        token1Symbol: activReq.token1Symbol,
        token0Address: position.token0.address,
        token1Address: position.token1.address,
        token0Decimals: position.token0.decimals,
        token1Decimals: position.token1.decimals,
        fee: activReq.fee,
        tickLower: activReq.tickLower,
        tickUpper: activReq.tickUpper,
        chain: activChain,
        dex: activDex,
        positionId: activReq.tokenId,
      };

      ctx.rebalancer.getPnlTracker(activReq.tokenId).reinitialize(initialLpUsd, initialHlUsd, initialFeesUsd);

      void upsertProtectionActivation({
        user_id: userId !== 'default' ? userId : undefined,
        token_id: activReq.tokenId,
        pool_address: activReq.poolAddress,
        protocol_version: activReq.protocolVersion,
        token0_symbol: position.token0.symbol,
        token1_symbol: position.token1.symbol,
        token0_amount: position.token0.amountFormatted,
        token1_amount: position.token1.amountFormatted,
        initial_lp_usd: initialLpUsd,
        initial_lp_fees_usd: initialFeesUsd,
        initial_timestamp: Date.now(),
        fee: activReq.fee ?? null,
        tick_lower: activReq.tickLower ?? null,
        tick_upper: activReq.tickUpper ?? null,
      });

      ctx.rebalancer.activatePosition(cfg);
      store.setActivePositionConfig(activReq.tokenId, cfg);

      logger.info(
        `[Activation] NFT #${activReq.tokenId} (${activReq.protocolVersion}) activated: LP=$${initialLpUsd.toFixed(2)} HL=$${initialHlUsd.toFixed(2)} hedge=${hedgeSymbol}`
      );
      store.notifyActivationResult({ success: true, tokenId: activReq.tokenId, initialLpUsd, initialHlUsd });

      logger.info(`[Activation] Running immediate first cycle for NFT #${activReq.tokenId}...`);
      try {
        await ctx.rebalancer.cycle(activReq.tokenId, position);
      } catch (cycleErr) {
        logger.error(`[Activation] Initial cycle failed for NFT #${activReq.tokenId}: ${cycleErr}`);
      }
    } catch (err) {
      logger.error(`[Activation] Failed for user ${userId}: ${err}`);
      store.notifyActivationResult({
        success: false,
        tokenId: activReq.tokenId,
        error: String(err),
      });
    } finally {
      ctx.activationsInProgress.delete(activReq.tokenId);
    }
  });

  // Position Config Update event
  store.on('configUpdated', (cfg: ActivePositionConfig) => {
    ctx.rebalancer.updateConfig(cfg.tokenId, cfg);
  });

  // Position Deactivation event
  store.on('deactivatePosition', async (tokenId: PositionId) => {
    // Guard against concurrent deactivation of the same position (e.g. multiple cycles detecting liquidity=0)
    if (ctx.deactivationsInProgress.has(tokenId)) return;
    ctx.deactivationsInProgress.add(tokenId);

    const ps = ctx.rebalancer.fullState.positions[tokenId];
    const hedgeSymbol = ps?.config.hedgeSymbol;

    // Determine finalPnl:
    // - If a live cycle ran (totalPositionUsd > 0), the store has real data → use it.
    // - Otherwise (e.g. after restart, store only has stub zeros), query exchange APIs
    //   with LP value = 0 (position is burned) to compute real P&L.
    const lastData = store.getCurrentData(tokenId);
    const hasRealStoreData = !!(lastData && lastData.totalPositionUsd > 0);

    let finalPnl: PnlSnapshot;
    if (hasRealStoreData) {
      finalPnl = {
        initialTotalUsd: lastData!.initialTotalUsd ?? 0,
        currentTotalUsd: lastData!.currentTotalUsd ?? 0,
        lpFeesUsd: lastData!.lpFeesUsd ?? 0,
        cumulativeFundingUsd: lastData!.cumulativeFundingUsd ?? 0,
        cumulativeHlFeesUsd: lastData!.cumulativeHlFeesUsd ?? 0,
        accountPnlUsd: lastData!.accountPnlUsd ?? 0,
        accountPnlPercent: lastData!.accountPnlPercent ?? 0,
        virtualPnlUsd: lastData!.pnlTotalUsd ?? 0,
        virtualPnlPercent: lastData!.pnlTotalPercent ?? 0,
        unrealizedVirtualPnlUsd: lastData!.unrealizedPnlUsd ?? 0,
        realizedVirtualPnlUsd: lastData!.realizedPnlUsd ?? 0,
        lpPnlUsd: lastData!.lpPnlUsd ?? 0,
      };
    } else if (ps && hedgeSymbol) {
      logger.info(`[Deactivation] NFT #${tokenId}: store data is stale (post-restart), fetching real P&L from exchange`);
      try {
        const tracker = ctx.rebalancer.getPnlTracker(tokenId);
        const sinceTs = ps.pnl?.initialTimestamp ?? Date.now();
        const [hlEquity, currentHedge, isolatedPnl] = await Promise.all([
          ctx.exchange.getAccountEquity(),
          ctx.exchange.getPosition(hedgeSymbol),
          ctx.exchange.getIsolatedPnl(hedgeSymbol, sinceTs),
        ]);
        const hlPnl: HlIsolatedPnl = { ...isolatedPnl, unrealizedPnlUsd: currentHedge.unrealizedPnlUsd ?? 0 };
        // LP value is 0 because the NFT has been burned; LP fees also 0 (collected on burn)
        finalPnl = tracker.compute(0, hlEquity, 0, hlPnl);
      } catch (pnlErr) {
        logger.error(`[Deactivation] Could not fetch real P&L for NFT #${tokenId}: ${pnlErr}`);
        finalPnl = {
          initialTotalUsd: 0, currentTotalUsd: 0, lpFeesUsd: 0, cumulativeFundingUsd: 0,
          cumulativeHlFeesUsd: 0, accountPnlUsd: 0, accountPnlPercent: 0,
          virtualPnlUsd: 0, virtualPnlPercent: 0, unrealizedVirtualPnlUsd: 0,
          realizedVirtualPnlUsd: 0, lpPnlUsd: 0,
        };
      }
    } else {
      finalPnl = {
        initialTotalUsd: 0, currentTotalUsd: 0, lpFeesUsd: 0, cumulativeFundingUsd: 0,
        cumulativeHlFeesUsd: 0, accountPnlUsd: 0, accountPnlPercent: 0,
        virtualPnlUsd: 0, virtualPnlPercent: 0, unrealizedVirtualPnlUsd: 0,
        realizedVirtualPnlUsd: 0, lpPnlUsd: 0,
      };
    }

    try {
      const archived = ctx.rebalancer.archivePosition(tokenId, finalPnl);
      store.addPositionToHistory(archived);
      void insertClosedPosition({
        user_id: userId !== 'default' ? userId : undefined,
        token_id: archived.tokenId,
        pool_address: archived.poolAddress,
        protocol_version: archived.protocolVersion,
        token0_symbol: archived.token0Symbol,
        token1_symbol: archived.token1Symbol,
        fee: archived.fee,
        tick_lower: archived.tickLower,
        tick_upper: archived.tickUpper,
        hedge_symbol: archived.hedgeSymbol,
        activated_at: new Date(archived.activatedAt).toISOString(),
        deactivated_at: new Date(archived.deactivatedAt).toISOString(),
        initial_lp_usd: archived.initialLpUsd,
        initial_hl_usd: archived.initialHlUsd,
        final_lp_fees_usd: archived.finalLpFeesUsd,
        final_cumulative_funding_usd: archived.finalCumulativeFundingUsd,
        final_cumulative_hl_fees_usd: archived.finalCumulativeHlFeesUsd,
        final_virtual_pnl_usd: archived.finalVirtualPnlUsd,
        final_virtual_pnl_pct: archived.finalVirtualPnlPercent,
        final_unrealized_pnl_usd: archived.finalUnrealizedPnlUsd,
        final_realized_pnl_usd: archived.finalRealizedPnlUsd,
      });
    } catch (err) {
      logger.error(`[Deactivation] Failed to archive position NFT #${tokenId}: ${err}`);
    }

    ctx.rebalancer.deactivatePosition(tokenId);
    store.setActivePositionConfig(tokenId, null);
    logger.info(`[Activation] NFT #${tokenId} removed from tracking — closing HL position...`);

    try {
      if (hedgeSymbol) {
        // Only close the HL position if no other active position shares the same hedgeSymbol.
        // Closing blindly would kill the hedge of a sibling position (e.g. new LP opened in same market).
        const otherUsesSymbol = Object.values(ctx.rebalancer.fullState.positions)
          .some(pos => pos.config.hedgeSymbol === hedgeSymbol);
        if (otherUsesSymbol) {
          logger.warn(`[Deactivation] NFT #${tokenId}: skipping HL close — symbol ${hedgeSymbol} also used by another active position`);
        } else {
          const currentHedge = await ctx.exchange.getPosition(hedgeSymbol);
          if (currentHedge.size > 0) {
            logger.info(`[Activation] NFT #${tokenId}: closing full HL position of ${currentHedge.size.toFixed(4)} ${hedgeSymbol}`);
            await ctx.exchange.closePosition(hedgeSymbol);
          } else {
            logger.info(`[Activation] NFT #${tokenId}: no open HL position to close`);
          }
        }
      }
    } catch (err) {
      logger.error(`[Activation] Error closing hedge during deactivation for NFT #${tokenId}: ${err}`);
    }

    ctx.deactivationsInProgress.delete(tokenId);
    logger.info(`[Activation] NFT #${tokenId} deactivation complete`);
  });

  // PnL reset event
  store.on('resetPnl', ({ tokenId, initialLpUsd, initialHlUsd }: { tokenId: PositionId; initialLpUsd: number; initialHlUsd: number }) => {
    const tracker = ctx.rebalancer.getPnlTracker(tokenId);
    tracker.reinitialize(initialLpUsd, initialHlUsd);
    ctx.rebalancer.saveState();
    logger.info(`[PnL Reset] NFT #${tokenId}: LP=$${initialLpUsd.toFixed(2)} HL=$${initialHlUsd.toFixed(2)}`);
  });
}

async function getOrCreateEngineContext(userId: string): Promise<UserEngineContext> {
  if (engineContexts.has(userId)) {
    return engineContexts.get(userId)!;
  }

  const exchange = await createExchangeForUser(userId);
  const rebalancer = new Rebalancer(exchange, userId);

  const ctx: UserEngineContext = { rebalancer, exchange, readers: new Map(), activationsInProgress: new Set(), deactivationsInProgress: new Set() };
  engineContexts.set(userId, ctx);

  const store = getStoreForUser(userId);

  // Pre-load local position history
  store.setPositionHistory(rebalancer.getHistory());

  // Restore previously active positions from state file
  const restoredPositions = rebalancer.getRestoredPositions();
  for (const pos of restoredPositions) {
    store.setActivePositionConfig(pos.tokenId, pos);
    const ps = rebalancer.fullState.positions[pos.tokenId];
    if (ps?.rebalances) {
      for (const event of ps.rebalances) {
        store.addRebalanceEvent(event);
      }
    }
    // If PnlTracker not initialized from state.json, try to restore from Supabase
    const tracker = ctx.rebalancer.getPnlTracker(pos.tokenId);
    if (!tracker.isInitialized && userId !== 'default') {
      try {
        const activation = await fetchProtectionActivation(userId, pos.tokenId);
        if (activation) {
          tracker.reinitialize(activation.initial_lp_usd, 0, activation.initial_lp_fees_usd);
          logger.info(`[User:${userId}] Restored PnL baseline from Supabase for NFT #${pos.tokenId}: LP=$${activation.initial_lp_usd.toFixed(2)}`);
        }
      } catch (err) {
        logger.warn(`[User:${userId}] Could not restore PnL baseline from Supabase for NFT #${pos.tokenId}: ${err}`);
      }
    }

    if (ps) {
      const pnlState = tracker.getStateForPersist();
      store.update({
        tokenId: pos.tokenId,
        timestamp: ps.lastRebalanceTimestamp || Date.now(),
        token0Amount: 0,
        token0Symbol: ps.config.hedgeToken === 'token0' ? (ps.config.hedgeSymbol || 'token0') : 'token0',
        token1Amount: 0,
        token1Symbol: ps.config.hedgeToken === 'token1' ? (ps.config.hedgeSymbol || 'token1') : 'token1',
        price: ps.lastPrice || 0,
        totalPositionUsd: 0,
        initialLpUsd: pnlState?.initialLpUsd,
        hedgeSize: ps.lastHedge.size || 0,
        hedgeNotionalUsd: ps.lastHedge.notionalUsd || 0,
        hedgeSide: ps.lastHedge.side || 'none',
        fundingRate: 0,
        netDelta: 0,
        rangeStatus: '-',
        dailyRebalanceCount: ps.dailyRebalanceCount || 0,
        lastRebalanceTimestamp: ps.lastRebalanceTimestamp || 0,
        lastRebalancePrice: ps.lastRebalancePrice || 0,
        pnlTotalUsd: 0,
        pnlTotalPercent: 0,
        accountPnlUsd: 0,
        accountPnlPercent: 0,
        unrealizedPnlUsd: 0,
        realizedPnlUsd: 0,
        lpFeesUsd: pnlState?.initialLpFeesUsd ?? 0,
        cumulativeFundingUsd: 0,
        cumulativeHlFeesUsd: 0,
        initialTotalUsd: (pnlState?.initialLpUsd || 0) + (pnlState?.initialHlUsd || 0),
        currentTotalUsd: 0,
        hlEquity: 0,
      });
    }
    logger.info(`[User:${userId}] Restored active position: NFT #${pos.tokenId}`);
  }

  // Update credentials status in user's store
  if (exchange instanceof HyperliquidExchange) {
    store.setCredentialsStatus(exchange.walletAddress ?? null);
  }

  setupUserEventHandlers(userId, ctx);

  logger.info(`[EngineContext] Created for user ${userId} (${restoredPositions.length} positions restored)`);
  return ctx;
}

/**
 * On startup, restore engine contexts for all users who have active positions in their state file.
 * Fails explicitly (log error + skip) if Supabase is not configured or credentials are missing —
 * never falls back to MockExchange for auto-restored users.
 */
async function autoRestoreEngineContexts(): Promise<void> {
  const stateDir = path.resolve(__dirname, '..');
  let files: string[];
  try {
    files = fs.readdirSync(stateDir).filter(f => /^state-[a-z0-9-]+\.json$/.test(f));
  } catch (err) {
    logger.error(`[AutoRestore] Cannot read state directory: ${err}`);
    return;
  }

  for (const file of files) {
    const userId = file.replace(/^state-/, '').replace(/\.json$/, '');
    if (userId === 'default') continue; // handled separately in single-user mode

    try {
      const raw = fs.readFileSync(path.join(stateDir, file), 'utf-8');
      const state = JSON.parse(raw) as { positions?: Record<string, unknown> };
      const positionCount = Object.keys(state?.positions ?? {}).length;
      if (positionCount === 0) continue;

      if (!supabaseServiceClient) {
        logger.error(`[AutoRestore] User ${userId} has ${positionCount} active position(s) but Supabase is not configured — cannot restore credentials. User must login.`);
        continue;
      }

      const creds = await loadDbCredentials(supabaseServiceClient, userId);
      if (!creds) {
        logger.error(`[AutoRestore] User ${userId} has ${positionCount} active position(s) but no HL credentials found in DB — skipping. User must login and set credentials.`);
        continue;
      }

      logger.info(`[AutoRestore] Restoring engine context for user ${userId} (${positionCount} position(s))`);
      await getOrCreateEngineContext(userId);
    } catch (err) {
      logger.error(`[AutoRestore] Failed to process ${file}: ${err}`);
    }
  }
}

async function main() {
  logger.info('=== Delta-Neutral LP Bot V2 (Multi-Position, Multi-User) Starting ===');
  logger.info(`Dry run: ${config.dryRun}`);

  let running = true;

  const shutdown = () => {
    if (!running) return;
    running = false;
    logger.info('Shutting down gracefully...');
    for (const ctx of engineContexts.values()) {
      ctx.rebalancer.saveState();
    }
    logger.info('State saved. Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const callbacks: DashboardCallbacks = {
    onUserAuthenticated: async (userId: string) => {
      await getOrCreateEngineContext(userId);
    },
    hotSwapExchange: (userId: string, privateKey: string, walletAddress: string) => {
      const ctx = engineContexts.get(userId);
      if (!ctx) {
        logger.warn(`[Credentials] No engine context for user ${userId} — cannot hot-swap`);
        return;
      }
      try {
        const newExchange = new HyperliquidExchange(privateKey, walletAddress);
        ctx.exchange = newExchange;
        ctx.rebalancer.setExchange(newExchange);
        getStoreForUser(userId).setCredentialsStatus(walletAddress);
        logger.info(`[Credentials] Live exchange activated for user ${userId} (${walletAddress})`);
      } catch (err) {
        logger.error(`[Credentials] Failed to activate for user ${userId}: ${err}`);
      }
    },
  };

  startDashboard(config.dashboardPort, callbacks);

  // For single-user / legacy mode: auto-create context for 'default' user
  // so existing setups without auth continue to work
  if (!config.googleClientId) {
    logger.info('[Init] Google auth not configured — running in single-user mode');
    await getOrCreateEngineContext('default');
  } else {
    // Multi-user mode: restore contexts for users with active positions in state files
    await autoRestoreEngineContexts();
  }

  async function runCycleForUser(userId: string, ctx: UserEngineContext): Promise<void> {
    const store = getStoreForUser(userId);
    const positionsState = ctx.rebalancer.fullState.positions;
    const tokenIds = Object.keys(positionsState).map(Number);

    if (tokenIds.length === 0) return;

    for (const tokenId of tokenIds) {
      const posState = positionsState[tokenId];
      if (!posState) continue;
      const cfg = posState.config;

      if (!store.getActivePositionConfig(tokenId)) {
        logger.warn(`[Cycle] NFT #${tokenId} present in rebalancer state but missing from dashboard — re-syncing`);
        store.setActivePositionConfig(tokenId, cfg);
      }

      try {
        logger.info(`[Cycle] User ${userId} — Processing NFT #${tokenId} (${cfg.protocolVersion})...`);
        const cycleChain = (cfg.chain ?? 'base') as ChainId;
        const cycleDex = (cfg.dex ?? (cfg.protocolVersion === 'v4' ? 'uniswap-v4' : 'uniswap-v3')) as DexId;
        const cycleReader = getOrCreateReader(ctx, cycleChain, cycleDex);
        const position = await cycleReader.readPosition(tokenId, cfg.poolAddress);

        const v4PoolId = cfg.protocolVersion === 'v4' ? (cycleReader as EvmV4Reader).getV4PoolId(tokenId) : null;
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
          continue;
        }

        await ctx.rebalancer.cycle(tokenId, position);
      } catch (err) {
        logger.error(`[NFT#${tokenId}] Cycle error: ${err}`);
      }
    }
  }

  const cyclesInProgress = new Set<string>();

  // ── LP Read Cycle (RPCs gratuitos, sem Alchemy) ─────────────────────────────

  async function runLpReadForToken(userId: string, ctx: UserEngineContext, tokenId: number): Promise<void> {
    const store = getStoreForUser(userId);
    const ps = ctx.rebalancer.fullState.positions[tokenId];
    if (!ps) return;
    const cfg = ps.config;

    const chain = (cfg.chain ?? 'base') as ChainId;
    const dex = (cfg.dex ?? (cfg.protocolVersion === 'v4' ? 'uniswap-v4' : 'uniswap-v3')) as DexId;
    const reader = getOrCreateReader(ctx, chain, dex);

    reader.refreshFees?.(tokenId);
    const position = await reader.readPosition(tokenId, cfg.poolAddress);

    if (position.liquidity === 0n) {
      logger.warn(`[LpRead] NFT #${tokenId} liquidity is 0 — LP position closed. Auto-deactivating...`);
      reader.invalidateCache(tokenId);
      if (!ctx.deactivationsInProgress.has(tokenId)) {
        store.requestDeactivation(tokenId);
      }
      return;
    }

    const current = store.getCurrentData(tokenId);
    if (!current) return;

    const hedgeToken = cfg.hedgeToken ?? 'token1';
    const cachedPrice = getCachedPrice(tokenId);
    const volatilePriceUsd = cachedPrice !== null
      ? (hedgeToken === 'token1' ? 1 / cachedPrice : cachedPrice)
      : current.price;

    const token0Usd = hedgeToken === 'token0'
      ? position.token0.amountFormatted * position.price
      : position.token0.amountFormatted;
    const token1Usd = hedgeToken === 'token1'
      ? position.token1.amountFormatted * volatilePriceUsd
      : position.token1.amountFormatted;

    const rawFeesUsd = hedgeToken === 'token0'
      ? position.tokensOwed0 * position.price + position.tokensOwed1
      : position.tokensOwed0 + position.tokensOwed1 * volatilePriceUsd;
    const netLpFees = Math.max(0, rawFeesUsd - (ps.pnl?.initialLpFeesUsd ?? 0));

    const totalLpUsd = token0Usd + token1Usd;

    if (cfg.hedgeSymbol) {
      const sinceTs = ps.pnl?.initialTimestamp ?? Date.now();
      const [hlEquity, currentHedge, isolatedPnl] = await Promise.all([
        ctx.exchange.getAccountEquity(),
        ctx.exchange.getPosition(cfg.hedgeSymbol),
        ctx.exchange.getIsolatedPnl(cfg.hedgeSymbol, sinceTs),
      ]);
      const hlPnl: HlIsolatedPnl = { ...isolatedPnl, unrealizedPnlUsd: currentHedge.unrealizedPnlUsd ?? 0 };
      const tracker = ctx.rebalancer.getPnlTracker(tokenId);
      const pnl = tracker.compute(totalLpUsd + rawFeesUsd, hlEquity, rawFeesUsd, hlPnl);

      store.update({
        ...current,
        timestamp: Date.now(),
        token0Amount: position.token0.amountFormatted,
        token0Symbol: position.token0.symbol,
        token1Amount: position.token1.amountFormatted,
        token1Symbol: position.token1.symbol,
        totalPositionUsd: totalLpUsd,
        rangeStatus: position.rangeStatus,
        price: volatilePriceUsd,
        lpFeesUsd: netLpFees,
        hedgeSize: currentHedge.size,
        hedgeNotionalUsd: currentHedge.notionalUsd,
        hedgeSide: currentHedge.side,
        hlEquity,
        unrealizedPnlUsd: pnl.unrealizedVirtualPnlUsd,
        realizedPnlUsd: pnl.realizedVirtualPnlUsd,
        lpPnlUsd: pnl.lpPnlUsd,
        pnlTotalUsd: pnl.virtualPnlUsd,
        pnlTotalPercent: pnl.virtualPnlPercent,
        accountPnlUsd: pnl.accountPnlUsd,
        accountPnlPercent: pnl.accountPnlPercent,
        cumulativeFundingUsd: pnl.cumulativeFundingUsd,
        cumulativeHlFeesUsd: pnl.cumulativeHlFeesUsd,
        initialTotalUsd: pnl.initialTotalUsd,
        currentTotalUsd: pnl.currentTotalUsd,
      });

      logger.info(
        `[LpRead] NFT #${tokenId} lp=$${totalLpUsd.toFixed(2)} fees=$${netLpFees.toFixed(4)} ` +
        `unrealized=$${pnl.unrealizedVirtualPnlUsd.toFixed(2)} realized=$${pnl.realizedVirtualPnlUsd.toFixed(2)}`
      );
    } else {
      store.update({
        ...current,
        timestamp: Date.now(),
        token0Amount: position.token0.amountFormatted,
        token0Symbol: position.token0.symbol,
        token1Amount: position.token1.amountFormatted,
        token1Symbol: position.token1.symbol,
        totalPositionUsd: totalLpUsd,
        rangeStatus: position.rangeStatus,
        price: volatilePriceUsd,
        lpFeesUsd: netLpFees,
      });

      logger.info(`[LpRead] NFT #${tokenId} lp=$${totalLpUsd.toFixed(2)} fees=$${netLpFees.toFixed(4)}`);
    }
  }

  async function runLpReadForUser(userId: string, ctx: UserEngineContext): Promise<void> {
    const tokenIds = Object.keys(ctx.rebalancer.fullState.positions).map(Number);
    for (const tokenId of tokenIds) {
      try {
        await runLpReadForToken(userId, ctx, tokenId);
      } catch (err) {
        logger.error(`[LpRead] NFT #${tokenId}: ${err}`);
      }
    }
  }

  let lpReadInProgress = false;
  async function runLpReadForAllUsers(): Promise<void> {
    if (lpReadInProgress) {
      logger.warn('[LpRead] Previous LP read still in progress, skipping');
      return;
    }
    lpReadInProgress = true;
    try {
      let first = true;
      for (const [userId, ctx] of engineContexts.entries()) {
        if (!first) await new Promise(r => setTimeout(r, config.lpReadInterUserDelayMs));
        first = false;
        await runLpReadForUser(userId, ctx);
      }
    } finally {
      lpReadInProgress = false;
    }
  }

  // ── Main Cycle ───────────────────────────────────────────────────────────────

  async function runCycleForAllUsers(): Promise<void> {
    for (const [userId, ctx] of engineContexts.entries()) {
      if (cyclesInProgress.has(userId)) {
        logger.warn(`[Cycle] User ${userId} — cycle already in progress, skipping`);
        continue;
      }
      cyclesInProgress.add(userId);
      runCycleForUser(userId, ctx).finally(() => cyclesInProgress.delete(userId));
    }
  }

  // Initial cycles for all users with active positions
  if (engineContexts.size > 0) {
    try {
      logger.info('Running initial cycle for all restored positions...');
      await runCycleForAllUsers();
    } catch (err) {
      logger.error(`Initial cycle failed: ${err}`);
    }
  } else {
    logger.info('No positions configured — skipping initial cycle. Use dashboard to activate positions.');
  }

  const cycleIntervalMs = config.cycleIntervalMin * 60_000;
  logger.info(`[Cycle] Heavy cycle every ${config.cycleIntervalMin}min (price poller handles out-of-range + emergency)`);
  setInterval(runCycleForAllUsers, cycleIntervalMs);

  // Price poller
  let pricePollRunning = false;
  setInterval(async () => {
    if (pricePollRunning || !running) return;
    pricePollRunning = true;
    try {
      // Collect all valid configs across all users, keyed for dedup by chain+poolAddress
      interface PollEntry { cfg: ActivePositionConfig; ctx: UserEngineContext; userId: string; }
      const poolGroups = new Map<string, PollEntry[]>();

      for (const [userId, ctx] of engineContexts.entries()) {
        const store = getStoreForUser(userId);
        for (const cfg of store.getAllActiveConfigs()) {
          if (
            !cfg.token0Address ||
            !cfg.token1Address ||
            cfg.token0Decimals === undefined ||
            cfg.token1Decimals === undefined
          ) continue;

          const chain = (cfg.chain ?? 'base') as ChainId;
          if (!isChainPriceSupported(chain)) {
            logger.warn(`[PricePoller] NFT #${cfg.tokenId} chain '${chain}' not supported by price APIs — skipping`);
            continue;
          }

          const key = `${chain}:${cfg.poolAddress}`;
          if (!poolGroups.has(key)) poolGroups.set(key, []);
          poolGroups.get(key)!.push({ cfg, ctx, userId });
        }
      }

      // One price fetch per unique pool; apply result to all tokenIds sharing it
      let firstPool = true;
      for (const [, entries] of poolGroups.entries()) {
        if (!firstPool) await new Promise(r => setTimeout(r, PRICE_POLL_INTER_REQUEST_MS));
        firstPool = false;
        const { cfg: rep } = entries[0];
        const chain = (rep.chain ?? 'base') as ChainId;
        try {
          const price = await fetchPoolPrice(
            rep.poolAddress,
            rep.token0Address!,
            rep.token0Symbol ?? '',
            rep.token1Address!,
            rep.token1Symbol ?? '',
            chain,
          );
          if (price === null) {
            logger.info(`[PricePoller] No price for pool ${rep.poolAddress.slice(0, 10)}... (${chain})`);
            continue;
          }

          for (const { cfg, ctx, userId } of entries) {
            poolPriceCache.set(cfg.tokenId, { price, updatedAt: Date.now() });

            // Convert Uniswap ratio (token1/token0) to USD price of the hedged token for display
            const t0Stable = STABLE_SYMBOLS.has(cfg.token0Symbol ?? '');
            const t1Stable = STABLE_SYMBOLS.has(cfg.token1Symbol ?? '');
            let displayUsd: number | null = null;
            if (cfg.hedgeToken === 'token0' && t1Stable) displayUsd = price;
            else if (cfg.hedgeToken === 'token1' && t0Stable) displayUsd = 1 / price;
            const displayStr = displayUsd !== null ? `$${displayUsd.toFixed(2)}` : `ratio ${price.toFixed(8)}`;
            priceLogger.info(`NFT #${cfg.tokenId} ${cfg.hedgeSymbol ?? ''} ${displayStr}`);

            if (!ctx.rebalancer.fullState.positions[cfg.tokenId]) continue;

            let triggerReason: string | null = null;

            // Out-of-range check (requires tick config)
            if (cfg.tickLower !== undefined && cfg.tickUpper !== undefined) {
              const decimalAdj = cfg.token0Decimals! - cfg.token1Decimals!;
              const rawPrice = price / Math.pow(10, decimalAdj);
              const tickCurrent = Math.round(Math.log(rawPrice) / Math.log(1.0001));
              if (tickCurrent < cfg.tickLower || tickCurrent >= cfg.tickUpper) {
                triggerReason = `out of range (tick ${tickCurrent})`;
              }
            }

            // Emergency price movement check
            if (!triggerReason) {
              const ps = ctx.rebalancer.fullState.positions[cfg.tokenId];
              const lastRebalancePrice = ps.lastRebalancePrice ?? 0;
              const emergThreshold = cfg.emergencyPriceMovementThreshold ?? config.emergencyPriceMovementThreshold;
              if (lastRebalancePrice > 0) {
                const movement = Math.abs(price - lastRebalancePrice) / lastRebalancePrice;
                if (movement > emergThreshold) {
                  triggerReason = `emergency: price moved ${(movement * 100).toFixed(2)}% from $${lastRebalancePrice.toFixed(4)}`;
                }
              }
            }

            if (triggerReason) {
              if (cyclesInProgress.has(userId)) {
                logger.warn(`[PricePoller] NFT #${cfg.tokenId} ${triggerReason} — cycle skipped (main cycle in progress)`);
              } else {
                logger.warn(`[PricePoller] NFT #${cfg.tokenId} ${triggerReason} — triggering immediate cycle`);
                cyclesInProgress.add(userId);
                const pollDex = (cfg.dex ?? (cfg.protocolVersion === 'v4' ? 'uniswap-v4' : 'uniswap-v3')) as DexId;
                const pollReader = getOrCreateReader(ctx, chain, pollDex);
                pollReader.readPosition(cfg.tokenId, cfg.poolAddress)
                  .then(position => ctx.rebalancer.cycle(cfg.tokenId, position))
                  .catch(err => logger.error(`[PricePoller] Cycle error for NFT #${cfg.tokenId}: ${err}`))
                  .finally(() => cyclesInProgress.delete(userId));
              }
            }
          }
        } catch (err) {
          logger.error(`[PricePoller] Error for pool ${rep.poolAddress} (${chain}): ${err}`);
        }
      }
    } finally {
      pricePollRunning = false;
    }
  }, PRICE_POLL_INTERVAL_MS);

  // LP Read Cycle — usa LP_FREE_*_RPC_URL (sem Alchemy), stagger entre usuários
  const lpReadIntervalMs = config.lpReadIntervalMin * 60_000;
  logger.info(`[LpRead] Cycle every ${config.lpReadIntervalMin}min, ${config.lpReadInterUserDelayMs / 1000}s delay between users`);
  setInterval(runLpReadForAllUsers, lpReadIntervalMs);
}

main().catch((err) => {
  logger.error(`Fatal error: ${err}`);
  process.exit(1);
});
