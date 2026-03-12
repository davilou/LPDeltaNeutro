import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
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
import { loadCredentials as loadDbCredentials, getUserEmail } from './auth/userStore';
import { fetchPoolPrice, poolPriceCache, getCachedPrice, isChainPriceSupported, STABLE_SYMBOLS } from './utils/priceApi';
import { IHedgeExchange, HlIsolatedPnl } from './hedge/types';
import { withContext } from './utils/correlation';
import { activePositionsCount, lpReadDuration } from './utils/metrics';
import './auth/types';

const PRICE_POLL_INTERVAL_MS = 30_000; // 30s — keep below API rate limits
const PRICE_POLL_INTER_REQUEST_MS = 500; // delay between pool price requests

interface UserEngineContext {
  rebalancer: Rebalancer;
  /** null until user provides HL credentials (no MockExchange fallback). */
  exchange: IHedgeExchange | null;
  /** Reusable readers keyed by "chain:dex" — preserves internal TTL cache across cycles. */
  readers: Map<string, ILPReader>;
  activationsInProgress: Set<PositionId>;
  deactivationsInProgress: Set<PositionId>;
  /** True while any cycle (timer, price poller, or activation) is running for this user. */
  cycleInProgress: boolean;
  /** User email for structured logging (resolved from Supabase). */
  email?: string;
}

/** User label for structured logs: email when available, userId as fallback. */
function u(ctx: UserEngineContext, userId: string): string { return ctx.email ?? userId; }

function getOrCreateReader(ctx: UserEngineContext, chain: ChainId, dex: DexId): ILPReader {
  const key = `${chain}:${dex}`;
  if (!ctx.readers.has(key)) ctx.readers.set(key, createLPReader(chain, dex));
  return ctx.readers.get(key)!;
}

const engineContexts = new Map<string, UserEngineContext>();

async function createExchangeForUser(userId: string, email?: string): Promise<IHedgeExchange | null> {
  const label = email ?? userId;
  // Try DB credentials first
  if (supabaseServiceClient) {
    try {
      const creds = await loadDbCredentials(supabaseServiceClient, userId);
      if (creds) {
        logger.info({ message: 'exchange.created', user: label, source: 'db' });
        return new HyperliquidExchange(creds.privateKey, creds.walletAddress, label);
      }
    } catch (err) {
      logger.warn({ message: 'exchange.db_creds_failed', user: label, error: String(err) });
    }
  }

  // Fall back to env credentials (only for default/single-user mode)
  if (userId === 'default') {
    if (config.dryRun) {
      logger.info({ message: 'exchange.created', user: 'default', source: 'mock' });
      return new MockExchange(0.01);
    }
    if (config.hlPrivateKey) {
      return new HyperliquidExchange(config.hlPrivateKey, config.hlWalletAddress, label);
    }
  }

  logger.info({ message: 'exchange.no_credentials', user: userId });
  return null;
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
    logger.info({ message: 'activation.start', user: u(ctx, userId), nft_id: String(activReq.tokenId), pool: activReq.poolAddress });

    // Prevent activation without exchange — attempt to reload credentials first
    if (!ctx.exchange) {
      try {
        const reloaded = await createExchangeForUser(userId, ctx.email);
        if (reloaded) {
          ctx.exchange = reloaded;
          ctx.rebalancer.setExchange(reloaded);
        }
      } catch (reloadErr) {
        logger.warn({ message: 'activation.creds_reload_failed', user: u(ctx, userId), error: String(reloadErr) });
      }

      if (!ctx.exchange) {
        logger.error({ message: 'activation.failed', user: u(ctx, userId), nft_id: String(activReq.tokenId), reason: 'no_credentials' });
        ctx.activationsInProgress.delete(activReq.tokenId);
        store.notifyActivationResult({
          success: false,
          tokenId: activReq.tokenId,
          error: 'No Hyperliquid credentials configured. Please add your HL credentials in Settings before activating protection.',
        });
        return;
      }
    }

    try {
      const activChain = (activReq.chain ?? 'base') as ChainId;
      const activDex = (activReq.dex ?? (activReq.protocolVersion === 'v4' ? 'uniswap-v4' : 'uniswap-v3')) as DexId;
      const activReader = createLPReader(activChain, activDex);
      const position = await activReader.readPosition(activReq.tokenId, activReq.poolAddress);
      const initialHlUsd = await ctx.exchange.getAccountEquity();

      const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'USDbC', 'DAI', 'USDS', 'crvUSD']);
      const HL_SYMBOL_MAP: Record<string, string> = { WETH: 'ETH', WBTC: 'BTC', cbBTC: 'BTC', cbETH: 'ETH', wstETH: 'ETH', WHYPE: 'HYPE', WBNB: 'BNB' };

      const t0Symbol = position.token0.symbol;
      const t1Symbol = position.token1.symbol;
      const rawVolatileSymbol = !STABLE_SYMBOLS.has(t0Symbol) ? t0Symbol : t1Symbol;
      const mapped = HL_SYMBOL_MAP[rawVolatileSymbol] ?? rawVolatileSymbol;
      const hedgeToken: 'token0' | 'token1' = rawVolatileSymbol === t0Symbol ? 'token0' : 'token1';

      // Resolve final HL symbol: strip trailing 'x' (e.g. NVDAx → NVDA), try dex-prefixed variants (xyz:AMZN, cash:AMZN)
      let hedgeSymbol: string;
      if (mapped.endsWith('x') && mapped.length > 1) {
        const stripped = mapped.slice(0, -1);
        const resolvedStripped = await ctx.exchange.resolveSymbol(stripped);
        const resolvedMapped = resolvedStripped ? null : await ctx.exchange.resolveSymbol(mapped);
        if (resolvedStripped) {
          hedgeSymbol = resolvedStripped;
        } else if (resolvedMapped) {
          hedgeSymbol = resolvedMapped;
        } else {
          throw new Error(`Symbol not found in Hyperliquid universe: tried "${stripped}" and "${mapped}" (checked all dexes)`);
        }
      } else {
        const resolved = await ctx.exchange.resolveSymbol(mapped);
        if (resolved) {
          hedgeSymbol = resolved;
        } else {
          throw new Error(`Symbol "${mapped}" not found in any Hyperliquid dex universe`);
        }
      }

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
        activationId: randomUUID(),
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

      // Activate in rebalancer state first (needed for cycle to run)
      ctx.rebalancer.activatePosition(cfg);

      // Run first cycle — hedge must be placed on HL before we confirm activation
      ctx.cycleInProgress = true;
      try {
        await ctx.rebalancer.cycle(activReq.tokenId, position);
      } catch (cycleErr) {
        logger.error({ message: 'activation.failed', user: u(ctx, userId), nft_id: String(activReq.tokenId), reason: 'hedge_failed', error: String(cycleErr) });
        ctx.rebalancer.deactivatePosition(activReq.tokenId);
        ctx.cycleInProgress = false;
        store.notifyActivationResult({
          success: false,
          tokenId: activReq.tokenId,
          error: `Hedge failed on Hyperliquid: ${cycleErr}`,
        });
        return;
      } finally {
        ctx.cycleInProgress = false;
      }

      // Hedge confirmed — now save to Supabase and notify UI
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

      store.setActivePositionConfig(activReq.tokenId, cfg);

      logger.info({ message: 'activation.complete', user: u(ctx, userId), nft_id: String(activReq.tokenId),
        pair: `${position.token0.symbol}/${position.token1.symbol}`, hedge_symbol: hedgeSymbol,
        lp_usd: +initialLpUsd.toFixed(2), hl_usd: +initialHlUsd.toFixed(2),
      });
      store.notifyActivationResult({ success: true, tokenId: activReq.tokenId, initialLpUsd, initialHlUsd });
      activePositionsCount.set({ userId }, Object.keys(ctx.rebalancer.fullState.positions).length);
    } catch (err) {
      logger.error({ message: 'activation.failed', user: u(ctx, userId), nft_id: String(activReq.tokenId), error: String(err) });
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
      try {
        if (!ctx.exchange) throw new Error('No exchange configured');
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
        logger.warn({ message: 'deactivation.pnl_fetch_failed', user: u(ctx, userId), nft_id: String(tokenId), error: String(pnlErr) });
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
        price_lower_usd: archived.priceLowerUsd ?? null,
        price_upper_usd: archived.priceUpperUsd ?? null,
        activation_id: archived.activationId ?? null,
      });
    } catch (err) {
      logger.error({ message: 'deactivation.archive_failed', user: u(ctx, userId), nft_id: String(tokenId), error: String(err) });
    }

    ctx.rebalancer.deactivatePosition(tokenId);
    store.setActivePositionConfig(tokenId, null);

    // Close HL position (skip if another active position shares the same hedge symbol)
    let hlCloseResult = 'no_symbol';
    try {
      if (hedgeSymbol) {
        const otherUsesSymbol = Object.values(ctx.rebalancer.fullState.positions)
          .some(pos => pos.config.hedgeSymbol === hedgeSymbol);
        if (otherUsesSymbol) {
          hlCloseResult = 'skipped_shared_symbol';
        } else if (ctx.exchange) {
          const currentHedge = await ctx.exchange.getPosition(hedgeSymbol);
          if (currentHedge.size > 0) {
            await ctx.exchange.closePosition(hedgeSymbol);
            hlCloseResult = `closed_${currentHedge.size.toFixed(4)}`;
          } else {
            hlCloseResult = 'no_position';
          }
        } else {
          hlCloseResult = 'no_exchange';
        }
      }
    } catch (err) {
      hlCloseResult = `error: ${err}`;
    }

    activePositionsCount.set({ userId }, Object.keys(ctx.rebalancer.fullState.positions).length);
    ctx.deactivationsInProgress.delete(tokenId);
    logger.info({ message: 'deactivation.complete', user: u(ctx, userId), nft_id: String(tokenId), hedge_symbol: hedgeSymbol ?? null, hl_close: hlCloseResult });
  });

  // PnL reset event
  store.on('resetPnl', ({ tokenId, initialLpUsd, initialHlUsd }: { tokenId: PositionId; initialLpUsd: number; initialHlUsd: number }) => {
    const tracker = ctx.rebalancer.getPnlTracker(tokenId);
    tracker.reinitialize(initialLpUsd, initialHlUsd);
    ctx.rebalancer.saveState();
    logger.info({ message: 'pnl.reset', user: u(ctx, userId), nft_id: String(tokenId), lp_usd: +initialLpUsd.toFixed(2), hl_usd: +initialHlUsd.toFixed(2) });
  });
}

async function getOrCreateEngineContext(userId: string): Promise<UserEngineContext> {
  if (engineContexts.has(userId)) {
    return engineContexts.get(userId)!;
  }

  let email: string | undefined;
  if (supabaseServiceClient && userId !== 'default') {
    email = (await getUserEmail(supabaseServiceClient, userId)) ?? undefined;
  }

  const exchange = await createExchangeForUser(userId, email);
  const rebalancer = new Rebalancer(exchange, userId, email);

  const ctx: UserEngineContext = { rebalancer, exchange, readers: new Map(), activationsInProgress: new Set(), deactivationsInProgress: new Set(), cycleInProgress: false, email };
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
          logger.info({ message: 'pnl.restored', user: u(ctx, userId), nft_id: String(pos.tokenId), lp_usd: +activation.initial_lp_usd.toFixed(2) });
        }
      } catch (err) {
        logger.warn({ message: 'pnl.restore_failed', user: u(ctx, userId), nft_id: String(pos.tokenId), error: String(err) });
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
  }

  // Update credentials status in user's store
  if (exchange instanceof HyperliquidExchange) {
    store.setCredentialsStatus(exchange.walletAddress ?? null);
  }

  setupUserEventHandlers(userId, ctx);

  logger.info({ message: 'engine.created', user: u(ctx, userId), positions_restored: restoredPositions.length });
  return ctx;
}

/**
 * On startup, restore engine contexts for all users who have active positions in their state file.
 * Fails explicitly (log error + skip) if Supabase is not configured or credentials are missing —
 * never falls back to MockExchange for auto-restored users.
 */
async function autoRestoreEngineContexts(): Promise<void> {
  const stateDir = process.env.DATA_DIR || path.resolve(__dirname, '..');
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
        logger.error({ message: 'autorestore.skipped', user: userId, positions: positionCount, reason: 'no_supabase' });
        continue;
      }

      const creds = await loadDbCredentials(supabaseServiceClient, userId);
      if (!creds) {
        logger.error({ message: 'autorestore.skipped', user: userId, positions: positionCount, reason: 'no_credentials' });
        continue;
      }

      await getOrCreateEngineContext(userId);
    } catch (err) {
      logger.error({ message: 'autorestore.failed', user: userId, file, error: String(err) });
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
    getEngineContext: (userId: string) => engineContexts.get(userId) ?? null,
    hotSwapExchange: (userId: string, privateKey: string, walletAddress: string) => {
      const ctx = engineContexts.get(userId);
      if (!ctx) {
        logger.warn({ message: 'credentials.no_context', user: userId });
        return;
      }
      try {
        const newExchange = new HyperliquidExchange(privateKey, walletAddress, ctx.email ?? userId);
        ctx.exchange = newExchange;
        ctx.rebalancer.setExchange(newExchange);
        getStoreForUser(userId).setCredentialsStatus(walletAddress);
        logger.info({ message: 'credentials.activated', user: u(ctx, userId), wallet: walletAddress });
      } catch (err) {
        logger.error({ message: 'credentials.failed', user: u(ctx, userId), error: String(err) });
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
    // Seed active_positions_count gauge for all restored users
    for (const [uid, ctx] of engineContexts.entries()) {
      activePositionsCount.set({ userId: uid }, Object.keys(ctx.rebalancer.fullState.positions).length);
    }
  }

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
          store.setActivePositionConfig(tokenId, cfg);
        }

        const cycleChain = (cfg.chain ?? 'base') as ChainId;
        const cycleDex = (cfg.dex ?? (cfg.protocolVersion === 'v4' ? 'uniswap-v4' : 'uniswap-v3')) as DexId;

        await withContext({ tokenId, chain: cycleChain, dex: cycleDex }, async () => {
          try {
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
              logger.warn({ message: 'lp.position.closed', user: u(ctx, userId), nft_id: String(tokenId), source: 'cycle' });
              cycleReader.invalidateCache(tokenId);
              if (!ctx.deactivationsInProgress.has(tokenId)) {
                store.requestDeactivation(tokenId);
              }
              return;
            }

            await ctx.rebalancer.cycle(tokenId, position);
          } catch (err) {
            logger.error({ message: 'cycle.error', user: u(ctx, userId), nft_id: String(tokenId), error: String(err) });
          }
        });
      }
    });
  }

  // ── LP Read Cycle (RPCs gratuitos, sem Alchemy) ─────────────────────────────

  async function runLpReadForToken(userId: string, ctx: UserEngineContext, tokenId: PositionId): Promise<void> {
    const store = getStoreForUser(userId);
    const ps = ctx.rebalancer.fullState.positions[tokenId];
    if (!ps) return;
    const cfg = ps.config;

    const chain = (cfg.chain ?? 'base') as ChainId;
    const dex = (cfg.dex ?? (cfg.protocolVersion === 'v4' ? 'uniswap-v4' : 'uniswap-v3')) as DexId;
    const reader = getOrCreateReader(ctx, chain, dex);

    reader.refreshFees?.(tokenId);
    const endLpTimer = lpReadDuration.startTimer({ chain, dex });
    const position = await reader.readPosition(tokenId, cfg.poolAddress);
    endLpTimer();

    if (position.liquidity === 0n) {
      logger.warn({ message: 'lp.position.closed', user: u(ctx, userId), nft_id: String(tokenId), source: 'lp_read' });
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

    if (cfg.hedgeSymbol && ctx.exchange) {
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

      const lpPnlNet = pnl.lpPnlUsd;
      const maxIl = Math.abs(Math.min(lpPnlNet, 0));
      const breakevenDays = netLpFees > 0 ? (maxIl / netLpFees) : null;
      const status = position.rangeStatus !== 'in-range' ? 'OUT_OF_RANGE'
        : (lpPnlNet < -totalLpUsd * 0.05) ? 'WARNING' : 'HEALTHY';

      logger.info({ message: 'lp.position.update', user: ctx.email ?? userId, nft_id: String(tokenId),
        chain, dex, pair: `${position.token0.symbol}/${position.token1.symbol}`,
        lp_value_usd: +totalLpUsd.toFixed(2), daily_fees_usd: +netLpFees.toFixed(4),
        il_unrealized: +pnl.unrealizedVirtualPnlUsd.toFixed(2), il_realized: +pnl.realizedVirtualPnlUsd.toFixed(2), il_max: +maxIl.toFixed(2),
        breakeven_days: breakevenDays !== null ? +breakevenDays.toFixed(1) : null, status,
      });
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

      const status = position.rangeStatus !== 'in-range' ? 'OUT_OF_RANGE' : 'HEALTHY';

      logger.info({ message: 'lp.position.update', user: ctx.email ?? userId, nft_id: String(tokenId),
        pool: { chain, dex, pair: `${position.token0.symbol}/${position.token1.symbol}` },
        lp_value_usd: +totalLpUsd.toFixed(2), daily_fees_usd: +netLpFees.toFixed(4),
        status,
      });
    }
  }

  async function runLpReadForUser(userId: string, ctx: UserEngineContext): Promise<void> {
    const tokenIds: PositionId[] = Object.keys(ctx.rebalancer.fullState.positions);
    logger.info({ message: 'lp.read.start', user: u(ctx, userId), positions: tokenIds.length });
    for (const tokenId of tokenIds) {
      try {
        await runLpReadForToken(userId, ctx, tokenId);
      } catch (err) {
        logger.error({ message: 'lp.read.error', user: u(ctx, userId), nft_id: String(tokenId), error: String(err) });
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
      if (ctx.cycleInProgress) {
        logger.debug({ message: 'cycle.skipped_in_progress', user: u(ctx, userId) });
        continue;
      }
      ctx.cycleInProgress = true;
      runCycleForUser(userId, ctx).finally(() => { ctx.cycleInProgress = false; });
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
    logger.info({ message: 'price.heartbeat', ts: Date.now() });
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
            logger.debug({ message: 'price.chain_unsupported', nft_id: String(cfg.tokenId), chain });
            continue;
          }

          const key = `${chain}:${cfg.poolAddress}`;
          if (!poolGroups.has(key)) poolGroups.set(key, []);
          poolGroups.get(key)!.push({ cfg, ctx, userId });
        }
      }

      // One price fetch per unique pool; apply result to all tokenIds sharing it
      let firstPool = true;
      const priceSummary: Array<{ nft_id: string; symbol: string | null; price_usd: number | null; chain: string }> = [];
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
            logger.debug({ message: 'price.no_data', pool: rep.poolAddress.slice(0, 10), chain });
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

            const fmtPrice = (v: number) => +v.toFixed(Math.max(2, -Math.floor(Math.log10(Math.abs(v) || 1)) + 3));
            priceSummary.push({
              nft_id: String(cfg.tokenId),
              symbol: cfg.hedgeSymbol ?? null,
              price_usd: displayUsd !== null ? fmtPrice(displayUsd) : null,
              chain,
            });
            const priceLogEntry = { message: 'price.update', user: u(ctx, userId), nft_id: String(cfg.tokenId),
              symbol: cfg.hedgeSymbol ?? null, price_usd: displayUsd !== null ? fmtPrice(displayUsd) : null,
              ratio: displayUsd === null ? +price.toFixed(8) : undefined,
              chain, pair: `${cfg.token0Symbol ?? ''}/${cfg.token1Symbol ?? ''}`,
            };
            logger.info(priceLogEntry);        // → Loki + bot log
            priceLogger.info(priceLogEntry);   // → price log file (dedicated)

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
              if (ctx.cycleInProgress) {
                logger.warn({ message: 'price.trigger_skipped', user: u(ctx, userId), nft_id: String(cfg.tokenId), reason: triggerReason });
              } else {
                logger.warn({ message: 'price.trigger', user: u(ctx, userId), nft_id: String(cfg.tokenId), reason: triggerReason });
                ctx.cycleInProgress = true;
                const pollDex = (cfg.dex ?? (cfg.protocolVersion === 'v4' ? 'uniswap-v4' : 'uniswap-v3')) as DexId;
                const pollReader = getOrCreateReader(ctx, chain, pollDex);
                pollReader.readPosition(cfg.tokenId, cfg.poolAddress)
                  .then(position => ctx.rebalancer.cycle(cfg.tokenId, position))
                  .catch(err => logger.error({ message: 'price.cycle_error', user: u(ctx, userId), nft_id: String(cfg.tokenId), error: String(err) }))
                  .finally(() => { ctx.cycleInProgress = false; });
              }
            }
          }
        } catch (err) {
          logger.error({ message: 'price.pool_error', pool: rep.poolAddress.slice(0, 10), chain, error: String(err) });
        }
      }
      // Single small log per poll cycle
      if (priceSummary.length > 0) {
        logger.info({ message: 'price.poll', count: priceSummary.length });
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
