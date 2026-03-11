import { ethers } from 'ethers';
import { Hyperliquid, signL1Action, floatToWire } from 'hyperliquid';
import { HedgeState } from '../types';
import { FillResult, HlIsolatedPnl, IHedgeExchange } from './types';
import { logger } from '../utils/logger';

/** HL perp DEXes to scan for assets (default + HIP-3 dexes) */
const PERP_DEXES = ['', 'xyz', 'cash'] as const;

/** Default slippage for IOC market orders (0.5%) */
const DEFAULT_SLIPPAGE = 0.005;

interface AssetMeta {
  name: string;
  szDecimals: number;
  /** Global offset index for order placement (e.g. 110013 for xyz:AMZN) */
  assetIndex: number;
  /** Local index within the dex universe (for metaAndAssetCtxs array lookups) */
  localIndex: number;
  /** Dex prefix ("" for core, "xyz", "cash", etc.) */
  dex: string;
}

export class HyperliquidExchange implements IHedgeExchange {
  private sdk: Hyperliquid;
  public readonly walletAddress: string;
  /** Maps full coin name (e.g. "BTC", "xyz:AMZN") → AssetMeta */
  private assetMetaCache: Map<string, AssetMeta> = new Map();
  private allDexesLoaded = false;

  constructor(privateKey: string, walletAddress: string) {
    if (!privateKey || !walletAddress) {
      throw new Error(
        'HyperliquidExchange requires HL_PRIVATE_KEY and HL_WALLET_ADDRESS when DRY_RUN=false'
      );
    }

    const signerAddress = ethers.computeAddress(privateKey);
    const isAgentSetup = signerAddress.toLowerCase() !== walletAddress.toLowerCase();

    this.walletAddress = walletAddress;
    this.sdk = new Hyperliquid({
      privateKey,
      walletAddress,
      enableWs: false,
    });

    if (isAgentSetup) {
      logger.info(`HyperliquidExchange (agent setup): signer=${signerAddress} master=${walletAddress}`);
    } else {
      logger.info(`HyperliquidExchange initialized for wallet ${walletAddress}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Strip "-PERP" suffix: "VIRTUAL-PERP" → "VIRTUAL" */
  private baseCoin(symbol: string): string {
    return symbol ? symbol.replace(/-PERP$/, '') : '';
  }

  /** Extract dex prefix from coin name: "xyz:AMZN" → "xyz", "BTC" → "" */
  private dexOf(coin: string): string {
    const i = coin.indexOf(':');
    return i > 0 ? coin.slice(0, i) : '';
  }

  /** HL info API helper */
  private async hlInfo(type: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    const resp = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, ...extra }),
    });
    if (!resp.ok) throw new Error(`[HL] info API ${type} failed: ${resp.status}`);
    return resp.json();
  }

  /** Round size to the asset's szDecimals */
  private roundSize(size: number, szDecimals: number): number {
    const factor = Math.pow(10, szDecimals);
    return Math.round(size * factor) / factor;
  }

  // ---------------------------------------------------------------------------
  // Multi-dex asset loading
  // ---------------------------------------------------------------------------

  /**
   * Load meta from all perp DEXes with correct offset asset indices.
   * HIP-3 dex offsets (from perpDexs API): default=0, first HIP-3=110000, second=120000, etc.
   * Asset index for order placement = offset + index_within_dex_universe.
   */
  private async loadAllDexes(): Promise<void> {
    if (this.allDexesLoaded) return;
    await this.sdk.ensureInitialized();

    // Get perp dex ordering to compute offsets
    const perpDexList = await this.hlInfo('perpDexs') as Array<{ name: string } | null>;
    const dexOffsets: Map<string, number> = new Map();
    dexOffsets.set('', 0); // default perp dex
    let hip3Idx = 0;
    for (const entry of perpDexList) {
      if (entry === null) continue; // skip default dex (null entry)
      dexOffsets.set(entry.name, 110000 + hip3Idx * 10000);
      hip3Idx++;
    }
    logger.info(`[HL] Perp dex offsets: ${JSON.stringify(Object.fromEntries(dexOffsets))}`);

    for (const dex of PERP_DEXES) {
      const offset = dexOffsets.get(dex);
      if (offset === undefined) {
        logger.warn(`[HL] Dex "${dex}" not found in perpDexs list — skipping`);
        continue;
      }
      try {
        const data = await this.hlInfo('metaAndAssetCtxs', dex ? { dex } : {}) as [
          { universe: Array<{ name: string; szDecimals: number }> },
          unknown[],
        ];
        const [meta] = data;
        for (let i = 0; i < meta.universe.length; i++) {
          const asset = meta.universe[i];
          const globalAssetIndex = offset + i;
          this.assetMetaCache.set(asset.name, {
            name: asset.name,
            szDecimals: asset.szDecimals,
            assetIndex: globalAssetIndex,
            localIndex: i,
            dex,
          });
        }
        logger.debug(`[HL] Loaded ${meta.universe.length} assets from dex "${dex || 'default'}" (offset=${offset})`);
      } catch (err) {
        logger.warn(`[HL] Failed to load dex "${dex || 'default'}": ${err}`);
      }
    }
    this.allDexesLoaded = true;
    logger.info(`[HL] Total assets loaded across all dexes: ${this.assetMetaCache.size}`);
  }

  private async getAssetMeta(symbol: string): Promise<AssetMeta> {
    const coin = this.baseCoin(symbol);
    await this.loadAllDexes();
    const meta = this.assetMetaCache.get(coin);
    if (!meta) throw new Error(`Unknown asset: ${coin} — not found in any Hyperliquid dex`);
    return meta;
  }

  // ---------------------------------------------------------------------------
  // Symbol resolution
  // ---------------------------------------------------------------------------

  async isSymbolSupported(symbol: string): Promise<boolean> {
    return (await this.resolveSymbol(symbol)) !== null;
  }

  async resolveSymbol(symbol: string): Promise<string | null> {
    const coin = this.baseCoin(symbol);
    await this.loadAllDexes();

    if (this.assetMetaCache.has(coin)) return coin;

    // Try with dex prefixes (e.g. "AMZN" → "xyz:AMZN" or "cash:AMZN")
    for (const dex of PERP_DEXES) {
      if (!dex) continue;
      const prefixed = `${dex}:${coin}`;
      if (this.assetMetaCache.has(prefixed)) {
        logger.info(`[HL] Resolved symbol "${coin}" → "${prefixed}"`);
        return prefixed;
      }
    }

    logger.warn(`[HL] Symbol "${coin}" not found in any dex universe`);
    return null;
  }

  // ---------------------------------------------------------------------------
  // Market data
  // ---------------------------------------------------------------------------

  async getFundingRate(symbol: string): Promise<number> {
    const meta = await this.getAssetMeta(symbol);

    const [, contexts] = await this.hlInfo('metaAndAssetCtxs', meta.dex ? { dex: meta.dex } : {}) as [
      { universe: Array<{ name: string }> },
      Array<{ funding: string }>,
    ];

    const rate = parseFloat(contexts[meta.localIndex].funding);
    logger.info(`[HL] Funding rate for ${meta.name}: ${(rate * 100).toFixed(4)}% (hourly)`);
    return rate;
  }

  /** Get current mid price for a coin (supports HIP-3 dex-prefixed symbols) */
  private async getMidPrice(coin: string): Promise<number> {
    const meta = this.assetMetaCache.get(coin);
    if (meta && meta.dex) {
      const [, ctxs] = await this.hlInfo('metaAndAssetCtxs', { dex: meta.dex }) as [
        { universe: Array<{ name: string }> },
        Array<{ midPx?: string }>,
      ];
      const midPx = ctxs[meta.localIndex]?.midPx;
      if (midPx) return parseFloat(midPx);
      throw new Error(`[HL] Cannot get mid price for ${coin} in dex "${meta.dex}"`);
    }
    const mids = await this.sdk.info.getAllMids(true) as Record<string, string>;
    const mid = mids[coin];
    if (mid) return parseFloat(mid);
    throw new Error(`[HL] Cannot get mid price for ${coin}`);
  }

  async getAccountEquity(): Promise<number> {
    await this.sdk.ensureInitialized();
    const spotState = await this.sdk.info.spot.getSpotClearinghouseState(this.walletAddress, true);
    let equity = 0;
    for (const bal of spotState.balances) {
      if (bal.coin === 'USDC') {
        equity = parseFloat(bal.total);
        break;
      }
    }
    logger.info(`[HL] Account equity (spot USDC): $${equity.toFixed(2)}`);
    return equity;
  }

  // ---------------------------------------------------------------------------
  // Position reading
  // ---------------------------------------------------------------------------

  async getPosition(symbol: string): Promise<HedgeState> {
    const coin = this.baseCoin(symbol);
    const dex = this.dexOf(coin);

    await this.sdk.ensureInitialized();

    let state: { assetPositions: Array<{ position: Record<string, unknown> }> };
    if (dex) {
      state = await this.hlInfo('clearinghouseState', { user: this.walletAddress, dex }) as typeof state;
    } else {
      state = await this.sdk.info.perpetuals.getClearinghouseState(this.walletAddress, true) as typeof state;
    }

    const assetPos = state.assetPositions.find((ap) => String(ap.position.coin) === coin);

    if (!assetPos) {
      logger.debug(`[HL] No position found for ${coin} (dex: ${dex || 'default'})`);
      return { symbol, size: 0, notionalUsd: 0, side: 'none' };
    }

    const pos = assetPos.position;
    const szi = parseFloat(String(pos.szi));
    const positionValue = parseFloat(String(pos.positionValue));
    const entryPx = pos.entryPx ? parseFloat(String(pos.entryPx)) : undefined;
    const unrealizedPnl = pos.unrealizedPnl !== undefined ? parseFloat(String(pos.unrealizedPnl)) : undefined;

    const hedgeState: HedgeState = {
      symbol,
      size: Math.abs(szi),
      notionalUsd: Math.abs(positionValue),
      side: szi < 0 ? 'short' : 'none',
      avgEntryPrice: entryPx && entryPx > 0 ? entryPx : undefined,
      unrealizedPnlUsd: unrealizedPnl,
    };

    logger.info(
      `[HL] Position: ${coin} size=${hedgeState.size} notional=$${hedgeState.notionalUsd.toFixed(2)} side=${hedgeState.side} ` +
      `entryPx=${entryPx?.toFixed(6) ?? 'n/a'} unrealizedPnl=$${unrealizedPnl?.toFixed(4) ?? 'n/a'}`,
    );
    return hedgeState;
  }

  // ---------------------------------------------------------------------------
  // Order execution
  // ---------------------------------------------------------------------------

  /**
   * Place a HIP-3 order by building a raw action with numeric asset index
   * and `dex` field, then signing via signL1Action and submitting directly.
   *
   * The SDK's placeOrder does NOT support HIP-3 dex field, so we bypass it
   * and use the raw HL exchange API format:
   *   { type: "order", dex: "xyz", orders: [{ a: 13, b, p, s, r, t }], grouping: "na" }
   */
  private async hip3PlaceOrder(
    meta: AssetMeta,
    isBuy: boolean,
    sz: number,
    reduceOnly: boolean,
  ): Promise<unknown> {
    const midPrice = await this.getMidPrice(meta.name);

    // Round price: 5 significant figures, max 6 decimals (same as Python SDK)
    const slippagePrice = isBuy
      ? midPrice * (1 + DEFAULT_SLIPPAGE)
      : midPrice * (1 - DEFAULT_SLIPPAGE);
    const sig5 = parseFloat(slippagePrice.toPrecision(5));
    const maxDec = Math.max(0, 6 - meta.szDecimals);
    const roundedPx = Number(sig5.toFixed(maxDec));

    const pxStr = floatToWire(roundedPx);
    const szStr = floatToWire(sz);

    logger.info(
      `[HL] HIP-3 placeOrder: dex=${meta.dex} assetIndex=${meta.assetIndex} coin=${meta.name} ` +
      `side=${isBuy ? 'buy' : 'sell'} sz=${szStr} limitPx=${pxStr} midPx=${midPrice} ` +
      `reduceOnly=${reduceOnly}`,
    );

    // Build raw action — offset asset index encodes the dex (no dex field needed)
    const orderWire = {
      a: meta.assetIndex, // offset index: e.g. 110013 for xyz:AMZN
      b: isBuy,
      p: pxStr,
      s: szStr,
      r: reduceOnly,
      t: { limit: { tif: 'Ioc' as const } },
    };
    const action = {
      type: 'order' as const,
      orders: [orderWire],
      grouping: 'na' as const,
    };

    // Access SDK private members for signing and submission
    const exchange = this.sdk.exchange as any;
    const wallet = exchange.wallet as ethers.Wallet;
    const httpApi = exchange.httpApi;
    const vaultAddress = exchange.vaultAddress ?? null;

    const nonce = Date.now();

    const signature = await signL1Action(
      wallet,
      action,
      vaultAddress,
      nonce,
      true, // IS_MAINNET
    );

    const payload = { action, nonce, signature, vaultAddress };
    logger.info(`[HL] HIP-3 full payload: ${JSON.stringify(payload)}`);

    return httpApi.makeRequest(payload, 1);
  }

  async setPosition(symbol: string, targetSize: number, _notionalUsd: number): Promise<FillResult | null> {
    const current = await this.getPosition(symbol);
    const delta = targetSize - current.size;
    const epsilon = 1e-6;

    if (Math.abs(delta) < epsilon) {
      logger.info(`[HL] Position already at target size ${targetSize} — no-op`);
      return null;
    }

    const meta = await this.getAssetMeta(symbol);
    const sz = this.roundSize(Math.abs(delta), meta.szDecimals);
    await this.sdk.ensureInitialized();

    if (meta.dex) {
      // HIP-3: use placeOrder with dex param
      if (delta > 0) {
        logger.info(`[HL] HIP-3 opening/increasing short: sell ${sz} ${symbol}`);
        const result = await this.hip3PlaceOrder(meta, false, sz, false);
        return this.logOrderResult('SELL', symbol, sz, result);
      } else {
        logger.info(`[HL] HIP-3 reducing short: buy ${sz} ${symbol}`);
        const result = await this.hip3PlaceOrder(meta, true, sz, true);
        return this.logOrderResult('BUY-REDUCE', symbol, sz, result);
      }
    }

    // Core perps: use SDK convenience methods
    if (delta > 0) {
      logger.info(`[HL] Opening/increasing short: sell ${sz} ${symbol}`);
      const result = await this.sdk.custom.marketOpen(symbol, false, sz);
      return this.logOrderResult('SELL', symbol, sz, result);
    } else {
      logger.info(`[HL] Reducing short: buy ${sz} ${symbol}`);
      const result = await this.sdk.custom.marketClose(symbol, sz);
      return this.logOrderResult('BUY-REDUCE', symbol, sz, result);
    }
  }

  async closePosition(symbol: string): Promise<FillResult | null> {
    const current = await this.getPosition(symbol);
    if (current.size <= 0) {
      logger.info(`[HL] No position to close for ${symbol}`);
      return null;
    }

    const meta = await this.getAssetMeta(symbol);
    logger.info(`[HL] Closing full position: ${current.size} ${symbol}`);
    await this.sdk.ensureInitialized();

    if (meta.dex) {
      // HIP-3: buy back (reduce_only) to close short
      const result = await this.hip3PlaceOrder(meta, true, current.size, true);
      return this.logOrderResult('CLOSE', symbol, current.size, result);
    }

    const result = await this.sdk.custom.marketClose(symbol);
    return this.logOrderResult('CLOSE', symbol, current.size, result);
  }

  // ---------------------------------------------------------------------------
  // P&L
  // ---------------------------------------------------------------------------

  async getIsolatedPnl(symbol: string, sinceTimestamp: number): Promise<HlIsolatedPnl> {
    const coin = this.baseCoin(symbol);
    const dex = this.dexOf(coin);
    try {
      await this.sdk.ensureInitialized();

      const fills = await (this.sdk.info as any).getUserFillsByTime(this.walletAddress, sinceTimestamp);
      const allFills: Array<Record<string, string>> = Array.isArray(fills) ? fills : [];
      const coinFills = allFills.filter((f) => {
        const fc = f.coin ?? '';
        return fc === coin || this.baseCoin(fc) === coin;
      });
      logger.info(`[HL] getIsolatedPnl ${coin}: totalFills=${allFills.length} coinFills=${coinFills.length}`);
      const realizedPnlUsd = coinFills.reduce((sum, f) => sum + parseFloat(f.closedPnl ?? '0'), 0);
      const cumulativeFeesUsd = coinFills.reduce((sum, f) => sum + parseFloat(f.fee ?? '0'), 0);

      // HL userFunding returns: [{ delta: { coin, usdc, szi, fundingRate, type }, hash, time }]
      let fundingData: Array<{ delta?: { coin?: string; usdc?: string }; coin?: string; usdc?: string }>;
      if (dex) {
        fundingData = await this.hlInfo('userFunding', {
          user: this.walletAddress,
          startTime: sinceTimestamp,
          dex,
        }) as typeof fundingData;
      } else {
        fundingData = await (this.sdk.info.perpetuals as any).getUserFunding(this.walletAddress, sinceTimestamp) ?? [];
      }
      const coinFunding = (Array.isArray(fundingData) ? fundingData : []).filter((f) => {
        const fc = f.delta?.coin ?? f.coin ?? '';
        return fc === coin || this.baseCoin(fc) === coin;
      });
      const cumulativeFundingUsd = coinFunding.reduce((sum, f) => sum + parseFloat(f.delta?.usdc ?? f.usdc ?? '0'), 0);

      logger.info(
        `[HL] IsolatedPnl ${coin}: realized=$${realizedPnlUsd.toFixed(2)} fees=$${cumulativeFeesUsd.toFixed(4)} funding=$${cumulativeFundingUsd.toFixed(4)}`,
      );

      return { unrealizedPnlUsd: 0, realizedPnlUsd, cumulativeFundingUsd, cumulativeFeesUsd };
    } catch (err) {
      logger.warn(`[HL] getIsolatedPnl failed for ${coin}: ${err}. Returning zeros.`);
      return { unrealizedPnlUsd: 0, realizedPnlUsd: 0, cumulativeFundingUsd: 0, cumulativeFeesUsd: 0 };
    }
  }

  // ---------------------------------------------------------------------------
  // Order result parsing
  // ---------------------------------------------------------------------------

  private logOrderResult(action: FillResult['action'], symbol: string, sz: number, result: any): FillResult {
    const statuses = result?.response?.data?.statuses ?? result?.statuses;
    if (statuses && statuses.length > 0) {
      const status = statuses[0];
      if (status.filled) {
        const avgPx = parseFloat(status.filled.avgPx);
        const totalSz = parseFloat(status.filled.totalSz);
        logger.info(`[HL] ${action} ${symbol} filled: sz=${totalSz} avgPx=${avgPx}`);
        return { action, sz: totalSz, avgPx };
      }
      if (status.error) {
        throw new Error(`[HL] ${action} ${symbol} rejected by exchange: ${JSON.stringify(status.error)}`);
      }
      if (status.resting) {
        throw new Error(`[HL] ${action} ${symbol} order resting (not filled immediately): oid=${status.resting.oid}`);
      }
      throw new Error(`[HL] ${action} ${symbol} unexpected order status: ${JSON.stringify(status)}`);
    }
    throw new Error(`[HL] ${action} ${symbol} sz=${sz} no fill status in response: ${JSON.stringify(result)}`);
  }
}
