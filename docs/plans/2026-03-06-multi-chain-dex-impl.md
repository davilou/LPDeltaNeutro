# Multi-Chain + Multi-DEX Expansion — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expand the bot to support 7 EVM chains (Base, ETH, BSC, Arbitrum, Polygon, Avalanche, HL L1) and 6 DEXes (Uniswap V3/V4, Pancakeswap V3/V4, Aerodrome CL, ProjectX), with Solana-aware abstractions ready for Phase 2.

**Architecture:** Thin Adapter — extract existing UniswapReader logic into parameterized base classes `EvmClReader` (V3-style) and `EvmV4Reader`. Each chain/dex combination is a factory-created instance with different contract addresses from the chain registry. `ILPReader` and `IWalletScanner` interfaces use `PositionId = number | string` to accommodate Solana phase 2. All hedges continue via Hyperliquid perps.

**Tech Stack:** Node.js + TypeScript strict + ethers.js v6 + Express v5. No new npm packages for Phase 1 (Multicall3 uses ethers.js built-ins). Solana phase 2 will need `@solana/web3.js`.

**Reference:** `docs/plans/2026-03-06-multi-chain-dex-design.md`

**Note on testing:** This project has no unit tests. Use `npx tsc --noEmit` after each task to verify types compile correctly.

---

## Task 1: Core types and interfaces

**Files:**
- Create: `src/lp/types.ts`
- Modify: `src/types.ts`

**Step 1: Create `src/lp/types.ts`**

```typescript
import { LPPosition } from '../types';
import { DiscoveredPosition } from '../types';

export type ChainId =
  | 'base'
  | 'eth'
  | 'bsc'
  | 'arbitrum'
  | 'polygon'
  | 'avalanche'
  | 'hyperliquid-l1'
  | 'solana'; // Phase 2

export type DexId =
  | 'uniswap-v3'
  | 'uniswap-v4'
  | 'pancake-v3'
  | 'pancake-v4'
  | 'aerodrome-cl'
  | 'project-x';   // HL L1

/** EVM: NFT tokenId (number). Solana phase 2: position pubkey (string). */
export type PositionId = number | string;

export interface ILPReader {
  readPosition(id: PositionId, poolAddress: string): Promise<LPPosition>;
  invalidateCache(id: PositionId): void;
  getBlockOrSlot(): Promise<number>;
}

export interface IWalletScanner {
  scanWallet(address: string): Promise<DiscoveredPosition[]>;
  lookupById(id: PositionId): Promise<DiscoveredPosition | null>;
}
```

**Step 2: Add ChainId, DexId, PositionId to `src/types.ts`**

At the top of `src/types.ts`, add:
```typescript
export type { ChainId, DexId, PositionId } from './lp/types';
```

In `ActivePositionConfig`, add three new optional fields (optional preserves backwards compat):
```typescript
  chain?: ChainId;           // default 'base' for existing positions
  dex?: DexId;               // default 'uniswap-v3' for existing positions
  positionId?: PositionId;   // alias for tokenId; number for EVM
```

In `DiscoveredPosition`, add two new optional fields:
```typescript
  chain?: ChainId;
  dex?: DexId;
```

**Step 3: Verify types compile**

```bash
cd D:\Documentos\Trae\APRDeltaNeutov3
npx tsc --noEmit
```
Expected: no errors.

**Step 4: Commit**

```bash
git add src/lp/types.ts src/types.ts
git commit -m "feat(multi-chain): core types — ChainId, DexId, PositionId, ILPReader, IWalletScanner"
```

---

## Task 2: Chain registry (contract addresses per chain/dex)

**Files:**
- Create: `src/lp/chainRegistry.ts`

**Step 1: Create the registry**

```typescript
import { ChainId, DexId } from './types';

export interface ChainDexAddresses {
  positionManagerV3?: string;
  factoryV3?: string;
  initCodeHashV3?: string;
  positionManagerV4?: string;
  stateViewV4?: string;
}

// Multicall3 is deployed at the same address on all supported EVMs
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

type RegistryKey = `${ChainId}:${DexId}`;

const REGISTRY: Partial<Record<RegistryKey, ChainDexAddresses>> = {
  // ── BASE ────────────────────────────────────────────────────────────────
  'base:uniswap-v3': {
    positionManagerV3: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
    factoryV3:         '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    initCodeHashV3:    '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
  },
  'base:uniswap-v4': {
    positionManagerV4: '0x7c5f5a4bbd8fd63184577525326123b519429bdc',
    stateViewV4:       '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
  },
  'base:aerodrome-cl': {
    positionManagerV3: '0x827922686190790b37229fd06084350e74485b72',
    factoryV3:         '0x5e7BB104d84c7CB9B682AaC2F3d509f890406f6d',
    // Aerodrome CL uses Uniswap V3-compatible math; init code hash differs
    initCodeHashV3:    '0x1565b129f2d1790f12d45301b9b084335626f0c92410bc43130763b69971135d',
  },

  // ── ETHEREUM MAINNET ────────────────────────────────────────────────────
  'eth:uniswap-v3': {
    positionManagerV3: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    factoryV3:         '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    initCodeHashV3:    '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
  },
  'eth:uniswap-v4': {
    positionManagerV4: '0x7C0f70Bff9B6aD84E2Ac21D4DC74FB4a5fFF86c',
    stateViewV4:       '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
  },
  'eth:pancake-v3': {
    positionManagerV3: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
    factoryV3:         '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    initCodeHashV3:    '0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2',
  },
  // PancakeSwap V4 on ETH — addresses TBD, add when verified
  // 'eth:pancake-v4': { ... },

  // ── BSC ─────────────────────────────────────────────────────────────────
  'bsc:pancake-v3': {
    positionManagerV3: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
    factoryV3:         '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    initCodeHashV3:    '0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2',
  },
  // PancakeSwap V4 on BSC — addresses TBD, add when verified
  // 'bsc:pancake-v4': { ... },

  // ── ARBITRUM ────────────────────────────────────────────────────────────
  'arbitrum:uniswap-v3': {
    positionManagerV3: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    factoryV3:         '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    initCodeHashV3:    '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
  },
  'arbitrum:pancake-v3': {
    positionManagerV3: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
    factoryV3:         '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    initCodeHashV3:    '0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2',
  },

  // ── POLYGON ─────────────────────────────────────────────────────────────
  'polygon:uniswap-v3': {
    positionManagerV3: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    factoryV3:         '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    initCodeHashV3:    '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
  },
  'polygon:pancake-v3': {
    positionManagerV3: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
    factoryV3:         '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    initCodeHashV3:    '0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2',
  },

  // ── AVALANCHE ───────────────────────────────────────────────────────────
  'avalanche:uniswap-v3': {
    positionManagerV3: '0x655C406EBFa14EE2006250925e54ec43AD184f8B',
    factoryV3:         '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD',
    initCodeHashV3:    '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
  },

  // ── HYPERLIQUID L1 ──────────────────────────────────────────────────────
  // ProjectX (prjx.com) — addresses TBD, research required before implementing
  // 'hyperliquid-l1:project-x': { ... },
};

export function getChainDexAddresses(chain: ChainId, dex: DexId): ChainDexAddresses {
  const key: RegistryKey = `${chain}:${dex}`;
  const config = REGISTRY[key];
  if (!config) {
    throw new Error(`No registry entry for chain=${chain} dex=${dex}. Add addresses to chainRegistry.ts.`);
  }
  return config;
}

export function isChainDexSupported(chain: ChainId, dex: DexId): boolean {
  return `${chain}:${dex}` in REGISTRY;
}

/** Returns all supported (chain, dex) pairs. */
export function listSupportedPairs(): Array<{ chain: ChainId; dex: DexId }> {
  return (Object.keys(REGISTRY) as RegistryKey[]).map(key => {
    const [chain, dex] = key.split(':') as [ChainId, DexId];
    return { chain, dex };
  });
}
```

**Step 2: Compile check**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/lp/chainRegistry.ts
git commit -m "feat(multi-chain): chain registry — contract addresses for all supported chain/dex pairs"
```

---

## Task 3: Global token info cache per chain

**Files:**
- Create: `src/lp/tokenCache.ts`

**Step 1: Create the module**

```typescript
import { ChainId } from './types';

export interface TokenMeta {
  symbol: string;
  decimals: number;
}

// Global cache — shared across all reader/scanner instances for the same chain.
// Avoids redundant decimals()/symbol() RPC calls.
const caches = new Map<ChainId, Map<string, TokenMeta>>();

export function getTokenCache(chain: ChainId): Map<string, TokenMeta> {
  let cache = caches.get(chain);
  if (!cache) {
    cache = new Map();
    caches.set(chain, cache);
  }
  return cache;
}

/** Inject known tokens into the cache (avoids RPC calls for well-known tokens). */
export function seedTokenCache(chain: ChainId, tokens: Record<string, TokenMeta>): void {
  const cache = getTokenCache(chain);
  for (const [addr, meta] of Object.entries(tokens)) {
    cache.set(addr.toLowerCase(), meta);
  }
}

/** Known tokens per chain — seeded at startup to avoid RPC calls. */
export const KNOWN_TOKENS_BY_CHAIN: Partial<Record<ChainId, Record<string, TokenMeta>>> = {
  base: {
    '0x0000000000000000000000000000000000000000': { symbol: 'ETH',   decimals: 18 },
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC',  decimals: 6  },
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { symbol: 'USDbC', decimals: 6  },
    '0x4200000000000000000000000000000000000006': { symbol: 'WETH',  decimals: 18 },
    '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': { symbol: 'cbBTC', decimals: 8  },
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI',   decimals: 18 },
    '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': { symbol: 'USDT',  decimals: 6  },
  },
  eth: {
    '0x0000000000000000000000000000000000000000': { symbol: 'ETH',   decimals: 18 },
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH',  decimals: 18 },
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC',  decimals: 6  },
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT',  decimals: 6  },
    '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI',   decimals: 18 },
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC',  decimals: 8  },
  },
  bsc: {
    '0x0000000000000000000000000000000000000000': { symbol: 'BNB',   decimals: 18 },
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': { symbol: 'WBNB',  decimals: 18 },
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { symbol: 'USDC',  decimals: 18 },
    '0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT',  decimals: 18 },
    '0xe9e7cea3dedca5984780bafc599bd69add087d56': { symbol: 'BUSD',  decimals: 18 },
  },
  arbitrum: {
    '0x0000000000000000000000000000000000000000': { symbol: 'ETH',   decimals: 18 },
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': { symbol: 'WETH',  decimals: 18 },
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { symbol: 'USDC',  decimals: 6  },
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT',  decimals: 6  },
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI',   decimals: 18 },
  },
  polygon: {
    '0x0000000000000000000000000000000000000000': { symbol: 'MATIC', decimals: 18 },
    '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': { symbol: 'WMATIC',decimals: 18 },
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': { symbol: 'USDC',  decimals: 6  },
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': { symbol: 'USDT',  decimals: 6  },
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': { symbol: 'DAI',   decimals: 18 },
  },
  avalanche: {
    '0x0000000000000000000000000000000000000000': { symbol: 'AVAX',  decimals: 18 },
    '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7': { symbol: 'WAVAX', decimals: 18 },
    '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': { symbol: 'USDC',  decimals: 6  },
    '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7': { symbol: 'USDT',  decimals: 6  },
  },
};
```

**Step 2: Compile check + commit**

```bash
npx tsc --noEmit
git add src/lp/tokenCache.ts
git commit -m "feat(multi-chain): global token info cache per chain — eliminates redundant RPC calls"
```

---

## Task 4: Per-chain FallbackProvider pool

**Files:**
- Create: `src/lp/chainProviders.ts`
- Modify: `src/config.ts`

**Step 1: Add new env vars to `src/config.ts`**

Inside the `config` object, add after `httpRpcUrls`:
```typescript
  /** HTTP RPC URLs per additional chain (each is a comma-separated list for fallback) */
  get ethHttpRpcUrls(): string[] { return parseRpcList(process.env.ETH_HTTP_RPC_URL); },
  get bscHttpRpcUrls(): string[] { return parseRpcList(process.env.BSC_HTTP_RPC_URL); },
  get arbHttpRpcUrls(): string[] { return parseRpcList(process.env.ARB_HTTP_RPC_URL); },
  get polygonHttpRpcUrls(): string[] { return parseRpcList(process.env.POLYGON_HTTP_RPC_URL); },
  get avaxHttpRpcUrls(): string[] { return parseRpcList(process.env.AVAX_HTTP_RPC_URL); },
  get hlL1HttpRpcUrls(): string[] { return parseRpcList(process.env.HL_L1_HTTP_RPC_URL); },

  /** Enable Multicall3 batching for EVM reads (default true) */
  multicall3Enabled: optionalEnv('MULTICALL3_ENABLED', 'true').toLowerCase() === 'true',
```

Add the helper function before the `config` object:
```typescript
function parseRpcList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map(u => u.trim()).filter(Boolean).map(u => u.endsWith('/') ? u.slice(0, -1) : u);
}
```

**Step 2: Create `src/lp/chainProviders.ts`**

```typescript
import { ChainId } from './types';
import { FallbackProvider } from '../utils/fallbackProvider';
import { config } from '../config';

const providers = new Map<ChainId, FallbackProvider>();

function getRpcUrls(chain: ChainId): string[] {
  switch (chain) {
    case 'base':           return config.httpRpcUrls;
    case 'eth':            return config.ethHttpRpcUrls;
    case 'bsc':            return config.bscHttpRpcUrls;
    case 'arbitrum':       return config.arbHttpRpcUrls;
    case 'polygon':        return config.polygonHttpRpcUrls;
    case 'avalanche':      return config.avaxHttpRpcUrls;
    case 'hyperliquid-l1': return config.hlL1HttpRpcUrls;
    case 'solana':         return []; // Phase 2
    default:               return [];
  }
}

/**
 * Returns a shared FallbackProvider for the given chain.
 * Lazy-initialised on first call; singleton per chain.
 */
export function getChainProvider(chain: ChainId): FallbackProvider {
  const cached = providers.get(chain);
  if (cached) return cached;

  const urls = getRpcUrls(chain);
  if (urls.length === 0) {
    throw new Error(`No RPC URLs configured for chain=${chain}. Set ${chain.toUpperCase().replace(/-/g, '_')}_HTTP_RPC_URL in .env`);
  }

  const provider = new FallbackProvider(urls);
  providers.set(chain, provider);
  return provider;
}
```

**Step 3: Compile check + commit**

```bash
npx tsc --noEmit
git add src/lp/chainProviders.ts src/config.ts
git commit -m "feat(multi-chain): per-chain FallbackProvider pool + RPC env vars for ETH/BSC/Arb/Polygon/Avax/HL"
```

---

## Task 5: Multicall3 utility

**Files:**
- Create: `src/utils/multicall.ts`

**Step 1: Create the Multicall3 helper**

This batches multiple `eth_call`s into one RPC request using the Multicall3 contract.

```typescript
import { ethers } from 'ethers';
import { MULTICALL3_ADDRESS } from '../lp/chainRegistry';

const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] results)',
];

export interface Call3 {
  target: string;
  allowFailure: boolean;
  callData: string;
}

export interface Call3Result {
  success: boolean;
  returnData: string;
}

/**
 * Execute multiple eth_call-s in a single RPC request via Multicall3.
 * Falls back to individual calls if Multicall3 is not available or disabled.
 */
export async function multicall3(
  provider: ethers.Provider,
  calls: Call3[],
): Promise<Call3Result[]> {
  if (calls.length === 0) return [];

  const contract = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
  const raw = await contract.aggregate3(calls);
  return (raw as Array<{ success: boolean; returnData: string }>).map(r => ({
    success: r.success,
    returnData: r.returnData,
  }));
}

/**
 * Build a Call3 entry for a contract method call.
 * Usage: buildCall3(myContract, 'positions', [tokenId])
 */
export function buildCall3(
  contract: ethers.Contract,
  method: string,
  args: unknown[],
  allowFailure = true,
): Call3 {
  return {
    target: contract.target as string,
    allowFailure,
    callData: contract.interface.encodeFunctionData(method, args),
  };
}

/**
 * Decode a Call3Result using a contract interface.
 * Returns null if the call failed and allowFailure was true.
 */
export function decodeCall3Result<T>(
  contract: ethers.Contract,
  method: string,
  result: Call3Result,
): T | null {
  if (!result.success) return null;
  const decoded = contract.interface.decodeFunctionResult(method, result.returnData);
  return decoded.length === 1 ? (decoded[0] as T) : (decoded as unknown as T);
}
```

**Step 2: Compile check + commit**

```bash
npx tsc --noEmit
git add src/utils/multicall.ts
git commit -m "feat(rpc-opt): Multicall3 helper — batch multiple eth_calls into one RPC request"
```

---

## Task 6: EvmClReader — base class for V3-compatible DEXes

This refactors `UniswapReader`'s V3 logic into a parameterized class. The existing `uniswapReader.ts` is preserved as-is; this is a new file.

**Files:**
- Create: `src/lp/readers/evmClReader.ts`

**Step 1: Create the reader**

The key change from the original: replaces hardcoded addresses with injected `ChainDexAddresses`, and uses `getChainProvider(chain)` + `getTokenCache(chain)` instead of `this.fallback` and `this.tokenInfoCache`.

```typescript
import { ethers } from 'ethers';
import { LPPosition, TokenInfo } from '../../types';
import { logger } from '../../utils/logger';
import { getCachedPrice } from '../../utils/priceApi';
import { ChainId, DexId, ILPReader, PositionId } from '../types';
import { ChainDexAddresses, getChainDexAddresses } from '../chainRegistry';
import { getChainProvider } from '../chainProviders';
import { getTokenCache, TokenMeta, KNOWN_TOKENS_BY_CHAIN, seedTokenCache } from '../tokenCache';
import { config } from '../../config';

const POSITION_MANAGER_V3_ABI = [
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) returns (uint256 amount0, uint256 amount1)',
];

const POOL_V3_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

interface CachedPositionData {
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  token0Address: string;
  token1Address: string;
  tokensOwed0: number;
  tokensOwed1: number;
  feesCycleCount: number;
  cachedAt: number;
}

const POSITION_CACHE_TTL_MS = 30 * 60 * 1_000;

/**
 * LP reader for Uniswap V3-compatible DEXes on EVM chains.
 * Supports: Uniswap V3, Pancakeswap V3, Aerodrome CL — any DEX sharing the V3 position model.
 */
export class EvmClReader implements ILPReader {
  private readonly chain: ChainId;
  private readonly dex: DexId;
  private readonly addresses: ChainDexAddresses;
  private readonly positionDataCache: Map<number, CachedPositionData> = new Map();

  constructor(chain: ChainId, dex: DexId) {
    this.chain = chain;
    this.dex = dex;
    this.addresses = getChainDexAddresses(chain, dex);

    if (!this.addresses.positionManagerV3) {
      throw new Error(`EvmClReader: no positionManagerV3 address for ${chain}:${dex}`);
    }

    // Seed known tokens for this chain into the global cache
    const known = KNOWN_TOKENS_BY_CHAIN[chain];
    if (known) seedTokenCache(chain, known);
  }

  async readPosition(id: PositionId, poolAddress: string): Promise<LPPosition> {
    const tokenId = Number(id);
    const fallback = getChainProvider(this.chain);

    return fallback.call(async (provider) => {
      const pm = new ethers.Contract(this.addresses.positionManagerV3!, POSITION_MANAGER_V3_ABI, provider);
      const now = Date.now();
      const cached = this.positionDataCache.get(tokenId);
      const needsFullRefresh = !cached || (now - cached.cachedAt > POSITION_CACHE_TTL_MS);

      let liquidity: bigint;
      let tickLower: number;
      let tickUpper: number;
      let token0Info: TokenMeta;
      let token1Info: TokenMeta;
      let tokensOwed0: number;
      let tokensOwed1: number;

      if (needsFullRefresh) {
        logger.info(`[Cache][${this.chain}:${this.dex}] Full refresh for V3 NFT #${tokenId}`);
        const pos = await pm.positions(tokenId);
        tickLower = Number(pos.tickLower);
        tickUpper = Number(pos.tickUpper);
        liquidity = BigInt(pos.liquidity);

        [token0Info, token1Info] = await Promise.all([
          this.getTokenInfo(provider, pos.token0),
          this.getTokenInfo(provider, pos.token1),
        ]);

        tokensOwed0 = Number(ethers.formatUnits(pos.tokensOwed0, token0Info.decimals));
        tokensOwed1 = Number(ethers.formatUnits(pos.tokensOwed1, token1Info.decimals));

        try {
          const MAX_UINT128 = (1n << 128n) - 1n;
          const res = await pm.collect.staticCall({
            tokenId,
            recipient: ethers.ZeroAddress,
            amount0Max: MAX_UINT128,
            amount1Max: MAX_UINT128,
          });
          tokensOwed0 = Number(ethers.formatUnits(res.amount0, token0Info.decimals));
          tokensOwed1 = Number(ethers.formatUnits(res.amount1, token1Info.decimals));
        } catch { }

        this.positionDataCache.set(tokenId, {
          liquidity, tickLower, tickUpper,
          token0Address: pos.token0,
          token1Address: pos.token1,
          tokensOwed0, tokensOwed1,
          feesCycleCount: 0,
          cachedAt: now,
        });
      } else {
        cached.feesCycleCount++;
        liquidity = cached.liquidity;
        tickLower = cached.tickLower;
        tickUpper = cached.tickUpper;

        [token0Info, token1Info] = await Promise.all([
          this.getTokenInfo(provider, cached.token0Address),
          this.getTokenInfo(provider, cached.token1Address),
        ]);

        if (cached.feesCycleCount >= config.positionCacheRefreshCycles) {
          logger.info(`[Cache][${this.chain}:${this.dex}] Refreshing fees for V3 NFT #${tokenId}`);
          try {
            const MAX_UINT128 = (1n << 128n) - 1n;
            const res = await pm.collect.staticCall({
              tokenId,
              recipient: ethers.ZeroAddress,
              amount0Max: MAX_UINT128,
              amount1Max: MAX_UINT128,
            });
            cached.tokensOwed0 = Number(ethers.formatUnits(res.amount0, token0Info.decimals));
            cached.tokensOwed1 = Number(ethers.formatUnits(res.amount1, token1Info.decimals));
          } catch { }
          cached.feesCycleCount = 0;
        } else {
          logger.info(`[Cache][${this.chain}:${this.dex}] Using cached position #${tokenId} (fee cycle ${cached.feesCycleCount}/${config.positionCacheRefreshCycles})`);
        }

        tokensOwed0 = cached.tokensOwed0;
        tokensOwed1 = cached.tokensOwed1;
      }

      const decimalAdj = token0Info.decimals - token1Info.decimals;
      let tickCurrent: number;
      const cachedPrice = getCachedPrice(tokenId);
      if (cachedPrice !== null) {
        const rawPrice = cachedPrice / Math.pow(10, decimalAdj);
        tickCurrent = Math.round(Math.log(rawPrice) / Math.log(1.0001));
      } else {
        const poolContract = new ethers.Contract(poolAddress, POOL_V3_ABI, provider);
        const slot0 = await poolContract.slot0();
        tickCurrent = Number(slot0.tick);
      }

      const price = Math.pow(1.0001, tickCurrent) * Math.pow(10, decimalAdj);
      const [amount0, amount1] = this.computeAmountsFromTicks(liquidity, tickCurrent, tickLower, tickUpper);

      const rangeStatus = tickCurrent < tickLower ? 'below-range'
        : tickCurrent >= tickUpper ? 'above-range'
        : 'in-range';

      return {
        token0: { address: cached?.token0Address ?? '', symbol: token0Info.symbol, decimals: token0Info.decimals, amount: amount0, amountFormatted: Number(ethers.formatUnits(amount0, token0Info.decimals)) },
        token1: { address: cached?.token1Address ?? '', symbol: token1Info.symbol, decimals: token1Info.decimals, amount: amount1, amountFormatted: Number(ethers.formatUnits(amount1, token1Info.decimals)) },
        price, rangeStatus, tickLower, tickUpper, tickCurrent,
        tokensOwed0, tokensOwed1, liquidity,
      };
    });
  }

  invalidateCache(id: PositionId): void {
    this.positionDataCache.delete(Number(id));
  }

  async getBlockOrSlot(): Promise<number> {
    return getChainProvider(this.chain).call(p => p.getBlockNumber());
  }

  private async getTokenInfo(provider: ethers.Provider, address: string): Promise<TokenMeta> {
    const addr = address.toLowerCase();
    const cache = getTokenCache(this.chain);
    const cached = cache.get(addr);
    if (cached) return cached;

    const token = new ethers.Contract(address, ERC20_ABI, provider);
    for (let i = 0; i < 3; i++) {
      try {
        const [decimals, symbol] = await Promise.all([token.decimals(), token.symbol()]);
        const info: TokenMeta = { symbol: String(symbol), decimals: Number(decimals) };
        cache.set(addr, info);
        return info;
      } catch (err) {
        if (i === 2) logger.warn(`Failed to get token info for ${address}: ${err}`);
        await new Promise(r => setTimeout(r, 500 * (i + 1)));
      }
    }
    return { symbol: 'UNKNOWN', decimals: 18 };
  }

  private computeAmountsFromTicks(
    liquidity: bigint, tickCurrent: number, tickLower: number, tickUpper: number,
  ): [bigint, bigint] {
    const sqrtPriceCurrent = Math.sqrt(Math.pow(1.0001, tickCurrent));
    const sqrtPriceLower   = Math.sqrt(Math.pow(1.0001, tickLower));
    const sqrtPriceUpper   = Math.sqrt(Math.pow(1.0001, tickUpper));
    const liq = Number(liquidity);
    let amount0 = 0, amount1 = 0;

    if (tickCurrent < tickLower) {
      amount0 = liq * (1 / sqrtPriceLower - 1 / sqrtPriceUpper);
    } else if (tickCurrent >= tickUpper) {
      amount1 = liq * (sqrtPriceUpper - sqrtPriceLower);
    } else {
      amount0 = liq * (1 / sqrtPriceCurrent - 1 / sqrtPriceUpper);
      amount1 = liq * (sqrtPriceCurrent - sqrtPriceLower);
    }

    return [BigInt(Math.floor(amount0)), BigInt(Math.floor(amount1))];
  }
}
```

**Step 2: Compile check + commit**

```bash
npx tsc --noEmit
git add src/lp/readers/evmClReader.ts
git commit -m "feat(multi-chain): EvmClReader — parameterized V3-compatible LP reader (Uniswap V3, PancakeSwap V3, Aerodrome CL)"
```

---

## Task 7: EvmV4Reader — base class for Uniswap V4-compatible DEXes

**Files:**
- Create: `src/lp/readers/evmV4Reader.ts`

**Step 1: Create the reader**

Same pattern as Task 6 but for V4 logic (from existing `readV4Position` + `computeV4Fees`):

```typescript
import { ethers } from 'ethers';
import { LPPosition } from '../../types';
import { logger } from '../../utils/logger';
import { getCachedPrice } from '../../utils/priceApi';
import { ChainId, DexId, ILPReader, PositionId } from '../types';
import { ChainDexAddresses, getChainDexAddresses } from '../chainRegistry';
import { getChainProvider } from '../chainProviders';
import { getTokenCache, TokenMeta, KNOWN_TOKENS_BY_CHAIN, seedTokenCache } from '../tokenCache';
import { config } from '../../config';

const POSITION_MANAGER_V4_ABI = [
  'function getPoolAndPositionInfo(uint256 tokenId) view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bytes32 info)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)',
];

const STATE_VIEW_V4_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getPositionInfo(bytes32 poolId, bytes32 positionId) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)',
  'function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)',
];

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

interface CachedV4PositionData {
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  token0Address: string;
  token1Address: string;
  tokensOwed0: number;
  tokensOwed1: number;
  feesCycleCount: number;
  cachedAt: number;
  poolId: string;
}

const POSITION_CACHE_TTL_MS = 30 * 60 * 1_000;

export class EvmV4Reader implements ILPReader {
  private readonly chain: ChainId;
  private readonly dex: DexId;
  private readonly addresses: ChainDexAddresses;
  private readonly positionDataCache: Map<number, CachedV4PositionData> = new Map();

  constructor(chain: ChainId, dex: DexId) {
    this.chain = chain;
    this.dex = dex;
    this.addresses = getChainDexAddresses(chain, dex);

    if (!this.addresses.positionManagerV4 || !this.addresses.stateViewV4) {
      throw new Error(`EvmV4Reader: missing positionManagerV4 or stateViewV4 for ${chain}:${dex}`);
    }

    const known = KNOWN_TOKENS_BY_CHAIN[chain];
    if (known) seedTokenCache(chain, known);
  }

  async readPosition(id: PositionId, _poolAddress: string): Promise<LPPosition> {
    const tokenId = Number(id);
    const fallback = getChainProvider(this.chain);

    return fallback.call(async (provider) => {
      const pmAddress = this.addresses.positionManagerV4!;
      const svAddress = this.addresses.stateViewV4!;
      const pm = new ethers.Contract(pmAddress, POSITION_MANAGER_V4_ABI, provider);
      const stateView = new ethers.Contract(svAddress, STATE_VIEW_V4_ABI, provider);
      const now = Date.now();
      const cached = this.positionDataCache.get(tokenId);
      const needsFullRefresh = !cached || (now - cached.cachedAt > POSITION_CACHE_TTL_MS);

      let liquidity: bigint, tickLower: number, tickUpper: number;
      let token0Info: TokenMeta, token1Info: TokenMeta;
      let tokensOwed0: number, tokensOwed1: number;
      let poolId: string;

      if (needsFullRefresh) {
        logger.info(`[Cache][${this.chain}:${this.dex}] Full refresh for V4 NFT #${tokenId}`);
        const { poolKey, info } = await pm.getPoolAndPositionInfo(tokenId);

        const infoBig = BigInt(info as string);
        const rawTickLower = Number((infoBig >> 8n) & 0xFFFFFFn);
        tickLower = rawTickLower > 0x7FFFFFn ? rawTickLower - 0x1000000 : rawTickLower;
        const rawTickUpper = Number((infoBig >> 32n) & 0xFFFFFFn);
        tickUpper = rawTickUpper > 0x7FFFFFn ? rawTickUpper - 0x1000000 : rawTickUpper;

        liquidity = BigInt(await pm.getPositionLiquidity(tokenId));

        [token0Info, token1Info] = await Promise.all([
          this.getTokenInfo(provider, poolKey.currency0),
          this.getTokenInfo(provider, poolKey.currency1),
        ]);

        poolId = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ['address', 'address', 'uint24', 'int24', 'address'],
            [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
          )
        );

        tokensOwed0 = 0;
        tokensOwed1 = 0;
        try {
          const fees = await this.computeV4Fees(stateView, pmAddress, poolId, tokenId, tickLower, tickUpper, liquidity);
          tokensOwed0 = Number(ethers.formatUnits(fees.fees0, token0Info.decimals));
          tokensOwed1 = Number(ethers.formatUnits(fees.fees1, token1Info.decimals));
        } catch (err) {
          logger.warn(`[V4][${this.chain}] Failed to compute fees for NFT #${tokenId}: ${err}`);
        }

        this.positionDataCache.set(tokenId, {
          liquidity, tickLower, tickUpper,
          token0Address: poolKey.currency0,
          token1Address: poolKey.currency1,
          tokensOwed0, tokensOwed1,
          feesCycleCount: 0,
          cachedAt: now,
          poolId,
        });
      } else {
        cached.feesCycleCount++;
        liquidity = cached.liquidity;
        tickLower = cached.tickLower;
        tickUpper = cached.tickUpper;
        poolId = cached.poolId;

        [token0Info, token1Info] = await Promise.all([
          this.getTokenInfo(provider, cached.token0Address),
          this.getTokenInfo(provider, cached.token1Address),
        ]);

        if (cached.feesCycleCount >= config.positionCacheRefreshCycles) {
          try {
            const fees = await this.computeV4Fees(stateView, pmAddress, poolId, tokenId, tickLower, tickUpper, liquidity);
            cached.tokensOwed0 = Number(ethers.formatUnits(fees.fees0, token0Info.decimals));
            cached.tokensOwed1 = Number(ethers.formatUnits(fees.fees1, token1Info.decimals));
          } catch (err) {
            logger.warn(`[V4][${this.chain}] Failed to refresh fees for NFT #${tokenId}: ${err}`);
          }
          cached.feesCycleCount = 0;
        }

        tokensOwed0 = cached.tokensOwed0;
        tokensOwed1 = cached.tokensOwed1;
      }

      const decimalAdj = token0Info.decimals - token1Info.decimals;
      let tickCurrent: number;
      const cachedPrice = getCachedPrice(tokenId);
      if (cachedPrice !== null) {
        const rawPrice = cachedPrice / Math.pow(10, decimalAdj);
        tickCurrent = Math.round(Math.log(rawPrice) / Math.log(1.0001));
      } else {
        const slot0 = await stateView.getSlot0(poolId);
        tickCurrent = Number(slot0.tick);
      }

      const price = Math.pow(1.0001, tickCurrent) * Math.pow(10, decimalAdj);
      const [amount0, amount1] = this.computeAmountsFromTicks(liquidity, tickCurrent, tickLower, tickUpper);
      const t0Addr = this.positionDataCache.get(tokenId)?.token0Address ?? '';
      const t1Addr = this.positionDataCache.get(tokenId)?.token1Address ?? '';
      const rangeStatus = tickCurrent < tickLower ? 'below-range' : tickCurrent >= tickUpper ? 'above-range' : 'in-range';

      return {
        token0: { address: t0Addr, symbol: token0Info.symbol, decimals: token0Info.decimals, amount: amount0, amountFormatted: Number(ethers.formatUnits(amount0, token0Info.decimals)) },
        token1: { address: t1Addr, symbol: token1Info.symbol, decimals: token1Info.decimals, amount: amount1, amountFormatted: Number(ethers.formatUnits(amount1, token1Info.decimals)) },
        price, rangeStatus, tickLower, tickUpper, tickCurrent, tokensOwed0, tokensOwed1, liquidity,
      };
    });
  }

  invalidateCache(id: PositionId): void {
    this.positionDataCache.delete(Number(id));
  }

  async getBlockOrSlot(): Promise<number> {
    return getChainProvider(this.chain).call(p => p.getBlockNumber());
  }

  getV4PoolId(tokenId: number): string | null {
    return this.positionDataCache.get(tokenId)?.poolId ?? null;
  }

  private async computeV4Fees(
    stateView: ethers.Contract, pmAddress: string, poolId: string,
    tokenId: number, tickLower: number, tickUpper: number, liquidity: bigint,
  ): Promise<{ fees0: bigint; fees1: bigint }> {
    const tokenIdBytes32 = ethers.zeroPadValue(ethers.toBeHex(tokenId), 32);
    const positionId = ethers.keccak256(
      ethers.solidityPacked(
        ['address', 'int24', 'int24', 'bytes32'],
        [pmAddress, tickLower, tickUpper, tokenIdBytes32],
      )
    );
    const [posInfo, growthInside] = await Promise.all([
      stateView.getPositionInfo(poolId, positionId),
      stateView.getFeeGrowthInside(poolId, tickLower, tickUpper),
    ]);
    const delta0 = BigInt.asUintN(256, BigInt(growthInside.feeGrowthInside0X128) - BigInt(posInfo.feeGrowthInside0LastX128));
    const delta1 = BigInt.asUintN(256, BigInt(growthInside.feeGrowthInside1X128) - BigInt(posInfo.feeGrowthInside1LastX128));
    return { fees0: (liquidity * delta0) >> 128n, fees1: (liquidity * delta1) >> 128n };
  }

  private async getTokenInfo(provider: ethers.Provider, address: string): Promise<TokenMeta> {
    const addr = address.toLowerCase();
    const cache = getTokenCache(this.chain);
    const cached = cache.get(addr);
    if (cached) return cached;
    try {
      const erc20 = new ethers.Contract(address, ERC20_ABI, provider);
      const [decimals, symbol] = await Promise.all([erc20.decimals(), erc20.symbol()]);
      const info: TokenMeta = { symbol: String(symbol), decimals: Number(decimals) };
      cache.set(addr, info);
      return info;
    } catch {
      return { symbol: 'UNKNOWN', decimals: 18 };
    }
  }

  private computeAmountsFromTicks(
    liquidity: bigint, tickCurrent: number, tickLower: number, tickUpper: number,
  ): [bigint, bigint] {
    const sqrtPriceCurrent = Math.sqrt(Math.pow(1.0001, tickCurrent));
    const sqrtPriceLower   = Math.sqrt(Math.pow(1.0001, tickLower));
    const sqrtPriceUpper   = Math.sqrt(Math.pow(1.0001, tickUpper));
    const liq = Number(liquidity);
    let amount0 = 0, amount1 = 0;
    if (tickCurrent < tickLower) {
      amount0 = liq * (1 / sqrtPriceLower - 1 / sqrtPriceUpper);
    } else if (tickCurrent >= tickUpper) {
      amount1 = liq * (sqrtPriceUpper - sqrtPriceLower);
    } else {
      amount0 = liq * (1 / sqrtPriceCurrent - 1 / sqrtPriceUpper);
      amount1 = liq * (sqrtPriceCurrent - sqrtPriceLower);
    }
    return [BigInt(Math.floor(amount0)), BigInt(Math.floor(amount1))];
  }
}
```

**Step 2: Compile check + commit**

```bash
npx tsc --noEmit
git add src/lp/readers/evmV4Reader.ts
git commit -m "feat(multi-chain): EvmV4Reader — parameterized V4-compatible LP reader (Uniswap V4, PancakeSwap V4)"
```

---

## Task 8: LP Reader Factory

**Files:**
- Create: `src/lp/lpReaderFactory.ts`
- Create: `src/lp/readers/solanaReader.ts` (stub)

**Step 1: Create the Solana stub**

```typescript
// src/lp/readers/solanaReader.ts
import { LPPosition } from '../../types';
import { ILPReader, PositionId } from '../types';

/**
 * Phase 2 stub — Solana LP reader (Orca, Raydium, Meteora).
 * Throws NotYetImplementedError until Phase 2 is implemented.
 */
export class SolanaReader implements ILPReader {
  readPosition(_id: PositionId, _poolAddress: string): Promise<LPPosition> {
    throw new Error('SolanaReader: not yet implemented (Phase 2)');
  }
  invalidateCache(_id: PositionId): void { /* noop */ }
  getBlockOrSlot(): Promise<number> {
    throw new Error('SolanaReader: not yet implemented (Phase 2)');
  }
}
```

**Step 2: Create `src/lp/lpReaderFactory.ts`**

```typescript
import { ChainId, DexId, ILPReader } from './types';
import { EvmClReader } from './readers/evmClReader';
import { EvmV4Reader } from './readers/evmV4Reader';
import { SolanaReader } from './readers/solanaReader';
import { isChainDexSupported } from './chainRegistry';

const V4_DEXES = new Set<DexId>(['uniswap-v4', 'pancake-v4']);
const SOLANA_CHAINS = new Set<ChainId>(['solana']);

/**
 * Returns an ILPReader for the given chain/dex combination.
 * Throws if the combination is not in the chain registry.
 */
export function createLPReader(chain: ChainId, dex: DexId): ILPReader {
  if (SOLANA_CHAINS.has(chain)) {
    return new SolanaReader();
  }

  if (!isChainDexSupported(chain, dex)) {
    throw new Error(`Unsupported chain/dex combination: ${chain}:${dex}. Check chainRegistry.ts.`);
  }

  if (V4_DEXES.has(dex)) {
    return new EvmV4Reader(chain, dex);
  }

  return new EvmClReader(chain, dex);
}
```

**Step 3: Compile check + commit**

```bash
npx tsc --noEmit
git add src/lp/lpReaderFactory.ts src/lp/readers/solanaReader.ts
git commit -m "feat(multi-chain): LP reader factory — routes (chain, dex) to correct reader implementation"
```

---

## Task 9: EvmScanner — parameterized EVM wallet scanner

This refactors the existing `WalletScanner` logic into `EvmScanner` parameterized by chain/dex.

**Files:**
- Create: `src/lp/scanners/evmScanner.ts`

**Step 1: Create the scanner**

Copy the logic from `src/lp/walletScanner.ts` but:
- Replace hardcoded addresses with `getChainDexAddresses(chain, dex)`
- Replace `this.fallback` with `getChainProvider(chain)`
- Add `chain` and `dex` to returned `DiscoveredPosition`s
- Make `scanWallet` call `scanV3` for V3-like DEXes and `scanV4` for V4

The file mirrors walletScanner.ts but accepts `chain: ChainId` and `dex: DexId` in constructor. Keep the same chunking, fallback, and error handling patterns. Add `chain` and `dex` to the `buildDiscoveredPosition` output.

```typescript
import { ethers } from 'ethers';
import { DiscoveredPosition } from '../../types';
import { logger } from '../../utils/logger';
import { ChainId, DexId, IWalletScanner, PositionId } from '../types';
import { getChainDexAddresses } from '../chainRegistry';
import { getChainProvider } from '../chainProviders';
import { getTokenCache, KNOWN_TOKENS_BY_CHAIN, seedTokenCache, TokenMeta } from '../tokenCache';

const POSITION_MANAGER_V3_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
];

const FACTORY_V3_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
];

const POOL_V3_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'USDbC', 'DAI', 'USDS', 'crvUSD', 'BUSD']);

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

export class EvmScanner implements IWalletScanner {
  private readonly chain: ChainId;
  private readonly dex: DexId;

  constructor(chain: ChainId, dex: DexId) {
    this.chain = chain;
    this.dex = dex;
    const known = KNOWN_TOKENS_BY_CHAIN[chain];
    if (known) seedTokenCache(chain, known);
  }

  async scanWallet(walletAddress: string): Promise<DiscoveredPosition[]> {
    return this.scanV3(walletAddress);
  }

  async lookupById(id: PositionId): Promise<DiscoveredPosition | null> {
    return this.lookupByTokenId(Number(id));
  }

  private async lookupByTokenId(tokenId: number): Promise<DiscoveredPosition | null> {
    const addresses = getChainDexAddresses(this.chain, this.dex);
    if (!addresses.positionManagerV3) return null;

    try {
      const pos = await getChainProvider(this.chain).call(async (provider) => {
        const pm = new ethers.Contract(addresses.positionManagerV3!, POSITION_MANAGER_V3_ABI, provider);
        return pm.positions(tokenId);
      });

      if (BigInt(pos.liquidity) === 0n) return null;

      const t0Addr = pos.token0.toLowerCase();
      const t1Addr = pos.token1.toLowerCase();
      const fee = Number(pos.fee);

      const { t0, t1, poolAddr, tickCurrent } = await getChainProvider(this.chain).call(async (provider) => {
        const [t0Info, t1Info] = await Promise.all([
          this.getTokenInfo(provider, t0Addr),
          this.getTokenInfo(provider, t1Addr),
        ]);
        const poolAddr = await this.resolvePoolAddress(provider, addresses, pos.token0, pos.token1, fee, t0Info, t1Info);
        const pool = new ethers.Contract(poolAddr, POOL_V3_ABI, provider);
        const slot0 = await pool.slot0();
        return { t0: t0Info, t1: t1Info, poolAddr, tickCurrent: Number(slot0.tick) };
      });

      const dp = this.buildDiscoveredPosition(
        tokenId, pos.token0, t0, pos.token1, t1, fee,
        Number(pos.tickLower), Number(pos.tickUpper), tickCurrent,
        BigInt(pos.liquidity), poolAddr,
      );
      logger.info(`[EvmScanner][${this.chain}:${this.dex}] lookupById #${tokenId}: ${t0.symbol}/${t1.symbol} ~$${dp.estimatedUsd.toFixed(2)}`);
      return dp;
    } catch (err) {
      logger.info(`[EvmScanner][${this.chain}:${this.dex}] lookupById #${tokenId} failed: ${err}`);
      return null;
    }
  }

  private async scanV3(walletAddress: string): Promise<DiscoveredPosition[]> {
    const addresses = getChainDexAddresses(this.chain, this.dex);
    if (!addresses.positionManagerV3) return [];
    const fallback = getChainProvider(this.chain);

    const balance: bigint = await fallback.call(async (p) => {
      const pm = new ethers.Contract(addresses.positionManagerV3!, POSITION_MANAGER_V3_ABI, p);
      return pm.balanceOf(walletAddress);
    });
    const count = Number(balance);
    if (count === 0) return [];

    logger.info(`[EvmScanner][${this.chain}:${this.dex}] ${walletAddress} owns ${count} NFTs`);

    const tokenIds: bigint[] = [];
    const indexChunks = chunk(Array.from({ length: count }, (_, i) => i), 5);
    for (const batch of indexChunks) {
      const results = await Promise.allSettled(
        batch.map(i => fallback.call(async (p) => {
          const pm = new ethers.Contract(addresses.positionManagerV3!, POSITION_MANAGER_V3_ABI, p);
          return pm.tokenOfOwnerByIndex(walletAddress, i);
        }))
      );
      for (const r of results) {
        if (r.status === 'fulfilled') tokenIds.push(r.value as bigint);
        else logger.warn(`[EvmScanner] tokenOfOwnerByIndex failed: ${r.reason}`);
      }
      await new Promise(r => setTimeout(r, 100));
    }

    const discovered: DiscoveredPosition[] = [];
    for (const batch of chunk(tokenIds, 2)) {
      const posResults = await Promise.allSettled(
        batch.map(id => fallback.call(async (p) => {
          const pm = new ethers.Contract(addresses.positionManagerV3!, POSITION_MANAGER_V3_ABI, p);
          return pm.positions(id);
        }))
      );

      for (let i = 0; i < batch.length; i++) {
        const tokenId = Number(batch[i]);
        const r = posResults[i];
        if (r.status === 'rejected') { logger.warn(`[EvmScanner] NFT #${tokenId}: positions() failed`); continue; }
        const pos = r.value;
        if (BigInt(pos.liquidity) === 0n) continue;

        const t0Addr = pos.token0.toLowerCase();
        const t1Addr = pos.token1.toLowerCase();
        const fee = Number(pos.fee);

        try {
          const { t0, t1, poolAddr, tickCurrent } = await fallback.call(async (provider) => {
            const [t0Info, t1Info] = await Promise.all([
              this.getTokenInfo(provider, t0Addr),
              this.getTokenInfo(provider, t1Addr),
            ]);
            const addr = await this.resolvePoolAddress(provider, addresses, pos.token0, pos.token1, fee, t0Info, t1Info);
            const pool = new ethers.Contract(addr, POOL_V3_ABI, provider);
            const slot0 = await pool.slot0();
            return { t0: t0Info, t1: t1Info, poolAddr: addr, tickCurrent: Number(slot0.tick) };
          });

          const dp = this.buildDiscoveredPosition(
            tokenId, pos.token0, t0, pos.token1, t1, fee,
            Number(pos.tickLower), Number(pos.tickUpper), tickCurrent,
            BigInt(pos.liquidity), poolAddr,
          );
          if (dp.estimatedUsd >= 10 || dp.estimatedUsd === 0) discovered.push(dp);
        } catch (err) {
          logger.info(`[EvmScanner] NFT #${tokenId}: skipped (${err})`);
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }

    return discovered;
  }

  private async resolvePoolAddress(
    provider: ethers.Provider,
    addresses: ReturnType<typeof getChainDexAddresses>,
    token0: string, token1: string, fee: number,
    _t0: TokenMeta, _t1: TokenMeta,
  ): Promise<string> {
    if (addresses.factoryV3) {
      try {
        const factory = new ethers.Contract(addresses.factoryV3, FACTORY_V3_ABI, provider);
        const addr = await factory.getPool(token0, token1, fee);
        if (addr !== ethers.ZeroAddress) return addr;
      } catch { /* fall through to CREATE2 */ }
    }

    if (addresses.initCodeHashV3) {
      const [tA, tB] = token0.toLowerCase() < token1.toLowerCase() ? [token0, token1] : [token1, token0];
      const salt = ethers.solidityPackedKeccak256(['address', 'address', 'uint24'], [tA, tB, fee]);
      return ethers.getCreate2Address(addresses.factoryV3 ?? ethers.ZeroAddress, salt, addresses.initCodeHashV3);
    }

    throw new Error('Cannot resolve pool address: no factory or initCodeHash configured');
  }

  private async getTokenInfo(provider: ethers.Provider, address: string): Promise<TokenMeta> {
    const addr = address.toLowerCase();
    const cache = getTokenCache(this.chain);
    const cached = cache.get(addr);
    if (cached) return cached;
    try {
      const erc20 = new ethers.Contract(address, ERC20_ABI, provider);
      const [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
      const info: TokenMeta = { symbol: String(symbol), decimals: Number(decimals) };
      cache.set(addr, info);
      return info;
    } catch {
      return { symbol: 'UNKNOWN', decimals: 18 };
    }
  }

  private buildDiscoveredPosition(
    tokenId: number,
    t0Addr: string, t0: TokenMeta,
    t1Addr: string, t1: TokenMeta,
    fee: number,
    tickLower: number, tickUpper: number, tickCurrent: number,
    liquidity: bigint, poolAddress: string,
  ): DiscoveredPosition {
    const [amount0, amount1] = this.computeAmountsFromTicks(liquidity, tickCurrent, tickLower, tickUpper);
    const t0Amount = Number(ethers.formatUnits(amount0, t0.decimals));
    const t1Amount = Number(ethers.formatUnits(amount1, t1.decimals));
    const decimalAdj = t0.decimals - t1.decimals;
    const price = Math.pow(1.0001, tickCurrent) * Math.pow(10, decimalAdj);

    const t0Stable = STABLE_SYMBOLS.has(t0.symbol);
    const t1Stable = STABLE_SYMBOLS.has(t1.symbol);
    const estimatedUsd = t0Stable
      ? t0Amount + t1Amount * (1 / price)
      : t1Stable
        ? t0Amount * price + t1Amount
        : 0;

    const rangeStatus = tickCurrent < tickLower ? 'below-range'
      : tickCurrent >= tickUpper ? 'above-range'
      : 'in-range';

    // 'v3' for all CL DEXes (Uniswap V3, PancakeSwap V3, Aerodrome CL)
    const protocolVersion = (this.dex === 'uniswap-v4' || this.dex === 'pancake-v4') ? 'v4' : 'v3';

    return {
      tokenId,
      protocolVersion,
      token0Address: t0Addr,
      token0Symbol: t0.symbol,
      token0Decimals: t0.decimals,
      token1Address: t1Addr,
      token1Symbol: t1.symbol,
      token1Decimals: t1.decimals,
      fee,
      tickLower, tickUpper, tickCurrent,
      liquidity: liquidity.toString(),
      poolAddress,
      rangeStatus,
      token0AmountFormatted: t0Amount,
      token1AmountFormatted: t1Amount,
      price,
      estimatedUsd,
      chain: this.chain,
      dex: this.dex,
    };
  }

  private computeAmountsFromTicks(liquidity: bigint, tickCurrent: number, tickLower: number, tickUpper: number): [bigint, bigint] {
    const sqrtPriceCurrent = Math.sqrt(Math.pow(1.0001, tickCurrent));
    const sqrtPriceLower   = Math.sqrt(Math.pow(1.0001, tickLower));
    const sqrtPriceUpper   = Math.sqrt(Math.pow(1.0001, tickUpper));
    const liq = Number(liquidity);
    let amount0 = 0, amount1 = 0;
    if (tickCurrent < tickLower) { amount0 = liq * (1 / sqrtPriceLower - 1 / sqrtPriceUpper); }
    else if (tickCurrent >= tickUpper) { amount1 = liq * (sqrtPriceUpper - sqrtPriceLower); }
    else { amount0 = liq * (1 / sqrtPriceCurrent - 1 / sqrtPriceUpper); amount1 = liq * (sqrtPriceCurrent - sqrtPriceLower); }
    return [BigInt(Math.floor(amount0)), BigInt(Math.floor(amount1))];
  }
}
```

**Step 2: Compile check + commit**

```bash
npx tsc --noEmit
git add src/lp/scanners/evmScanner.ts
git commit -m "feat(multi-chain): EvmScanner — parameterized EVM wallet scanner for any V3-compatible DEX"
```

---

## Task 10: Wallet Scanner Factory + Solana stub

**Files:**
- Create: `src/lp/walletScannerFactory.ts`
- Create: `src/lp/scanners/solanaScanner.ts`

**Step 1: Solana scanner stub**

```typescript
// src/lp/scanners/solanaScanner.ts
import { DiscoveredPosition } from '../../types';
import { IWalletScanner, PositionId } from '../types';

export class SolanaScanner implements IWalletScanner {
  scanWallet(_address: string): Promise<DiscoveredPosition[]> {
    throw new Error('SolanaScanner: not yet implemented (Phase 2)');
  }
  lookupById(_id: PositionId): Promise<DiscoveredPosition | null> {
    throw new Error('SolanaScanner: not yet implemented (Phase 2)');
  }
}
```

**Step 2: Wallet scanner factory**

```typescript
// src/lp/walletScannerFactory.ts
import { ChainId, DexId, IWalletScanner } from './types';
import { EvmScanner } from './scanners/evmScanner';
import { SolanaScanner } from './scanners/solanaScanner';

const SOLANA_CHAINS = new Set<ChainId>(['solana']);

/**
 * Returns an IWalletScanner for the given chain/dex combination.
 */
export function createWalletScanner(chain: ChainId, dex: DexId): IWalletScanner {
  if (SOLANA_CHAINS.has(chain)) {
    return new SolanaScanner();
  }
  return new EvmScanner(chain, dex);
}
```

**Step 3: Compile check + commit**

```bash
npx tsc --noEmit
git add src/lp/walletScannerFactory.ts src/lp/scanners/solanaScanner.ts
git commit -m "feat(multi-chain): wallet scanner factory + Solana stubs for phase 2"
```

---

## Task 11: Backwards-compat re-exports

Preserve the existing `src/lp/uniswapReader.ts` and `src/lp/walletScanner.ts` as thin wrappers so no existing import paths break.

**Files:**
- Modify: `src/lp/uniswapReader.ts` (add re-exports alongside existing class)
- Modify: `src/lp/walletScanner.ts` (add re-exports alongside existing class)

**Step 1: At the bottom of `src/lp/uniswapReader.ts`, add:**

```typescript
// Multi-chain exports — import from here for backwards compat
export { EvmClReader } from './readers/evmClReader';
export { EvmV4Reader } from './readers/evmV4Reader';
export { createLPReader } from './lpReaderFactory';
```

**Step 2: At the bottom of `src/lp/walletScanner.ts`, add:**

```typescript
// Multi-chain exports
export { EvmScanner } from './scanners/evmScanner';
export { createWalletScanner } from './walletScannerFactory';
```

**Step 3: Compile check + commit**

```bash
npx tsc --noEmit
git add src/lp/uniswapReader.ts src/lp/walletScanner.ts
git commit -m "feat(multi-chain): backwards-compat re-exports from existing uniswapReader + walletScanner"
```

---

## Task 12: State migration in Rebalancer

Add `chain`, `dex`, and `positionId` defaults to existing positions that pre-date multi-chain.

**Files:**
- Modify: `src/engine/rebalancer.ts`

**Step 1: In `loadState()`, inside the `for (const tokenId in loaded.positions)` loop, add after the existing `protocolVersion` migration:**

```typescript
// Multi-chain migration: default to base:uniswap-v3 for pre-existing positions
if (!loaded.positions[tokenId].config.chain) {
  loaded.positions[tokenId].config.chain = 'base';
}
if (!loaded.positions[tokenId].config.dex) {
  const proto = loaded.positions[tokenId].config.protocolVersion;
  loaded.positions[tokenId].config.dex = proto === 'v4' ? 'uniswap-v4' : 'uniswap-v3';
}
if (loaded.positions[tokenId].config.positionId === undefined) {
  loaded.positions[tokenId].config.positionId = loaded.positions[tokenId].config.tokenId;
}
```

**Step 2: Compile check + commit**

```bash
npx tsc --noEmit
git add src/engine/rebalancer.ts
git commit -m "feat(multi-chain): state migration — add chain/dex/positionId defaults for existing positions"
```

---

## Task 13: Dashboard UI — chain/dex selectors

**Files:**
- Modify: `src/dashboard/public/index.html`

**Step 1: Find the Scan section** (look for the wallet scan input area, roughly near `scanWallet` or `walletAddress` in the HTML).

Add a chain + dex selector row **before** the wallet address input:

```html
<!-- Chain + DEX selectors (multi-chain) -->
<div class="input-row" id="chain-dex-row">
  <select id="chain-select" onchange="onChainChange()">
    <option value="base">Base</option>
    <option value="eth">Ethereum</option>
    <option value="bsc">BSC</option>
    <option value="arbitrum">Arbitrum</option>
    <option value="polygon">Polygon</option>
    <option value="avalanche">Avalanche</option>
    <option value="hyperliquid-l1">Hyperliquid L1</option>
  </select>
  <select id="dex-select">
    <!-- Populated dynamically by onChainChange() -->
  </select>
</div>
```

**Step 2: Find the Token ID lookup input** and add the same selectors above it (a second copy with IDs `chain-select-lookup` and `dex-select-lookup`):

```html
<div class="input-row" id="chain-dex-row-lookup">
  <select id="chain-select-lookup" onchange="onChainChangeLookup()">
    <!-- same options as above -->
  </select>
  <select id="dex-select-lookup">
    <!-- Populated by onChainChangeLookup() -->
  </select>
</div>
```

**Step 3: Add JavaScript for dynamic DEX options** (inside a `<script>` block in the HTML):

```javascript
const DEX_OPTIONS_BY_CHAIN = {
  base:           ['uniswap-v3', 'uniswap-v4', 'aerodrome-cl'],
  eth:            ['uniswap-v3', 'uniswap-v4', 'pancake-v3'],
  bsc:            ['pancake-v3'],
  arbitrum:       ['uniswap-v3', 'pancake-v3'],
  polygon:        ['uniswap-v3', 'pancake-v3'],
  avalanche:      ['uniswap-v3'],
  'hyperliquid-l1': ['project-x'],
};

const DEX_LABELS = {
  'uniswap-v3':   'Uniswap V3',
  'uniswap-v4':   'Uniswap V4',
  'pancake-v3':   'PancakeSwap V3',
  'pancake-v4':   'PancakeSwap V4',
  'aerodrome-cl': 'Aerodrome CL',
  'project-x':    'ProjectX',
};

function populateDexSelect(selectEl, chain) {
  const options = DEX_OPTIONS_BY_CHAIN[chain] || [];
  selectEl.innerHTML = options
    .map(d => `<option value="${d}">${DEX_LABELS[d] || d}</option>`)
    .join('');
}

function onChainChange() {
  const chain = document.getElementById('chain-select').value;
  populateDexSelect(document.getElementById('dex-select'), chain);
}

function onChainChangeLookup() {
  const chain = document.getElementById('chain-select-lookup').value;
  populateDexSelect(document.getElementById('dex-select-lookup'), chain);
}

// Init on page load
window.addEventListener('DOMContentLoaded', () => {
  onChainChange();
  onChainChangeLookup();
});
```

**Step 4: Update the scan and lookup API calls** to include `chain` and `dex`:

- In the `scanWallet()` JS function, add to the fetch body:
  ```javascript
  chain: document.getElementById('chain-select').value,
  dex:   document.getElementById('dex-select').value,
  ```

- In the `lookupPosition()` JS function, add:
  ```javascript
  chain: document.getElementById('chain-select-lookup').value,
  dex:   document.getElementById('dex-select-lookup').value,
  ```

**Step 5: Add badge to position card** — in `positionMetricsHtml()` or equivalent card render function, add:

```javascript
const chainDexBadge = cfg.chain && cfg.dex
  ? `<span class="badge">${cfg.chain} • ${DEX_LABELS[cfg.dex] || cfg.dex}</span>`
  : '';
```

**Step 6: Commit**

```bash
git add src/dashboard/public/index.html
git commit -m "feat(multi-chain): dashboard UI — chain/dex selectors for scan and lookup"
```

---

## Task 14: Server routes — pass chain/dex to scan/lookup handlers

**Files:**
- Modify: `src/dashboard/server.ts`

**Step 1: Update `POST /api/scan-wallet`** handler to read `chain` and `dex` from request body and pass to `createWalletScanner`:

```typescript
// In the /api/scan-wallet handler:
const { walletAddress, chain = 'base', dex = 'uniswap-v3' } = req.body as {
  walletAddress: string;
  chain?: ChainId;
  dex?: DexId;
};
const scanner = createWalletScanner(chain, dex);
const positions = await scanner.scanWallet(walletAddress);
```

Add import at top of server.ts:
```typescript
import { createWalletScanner } from '../lp/walletScannerFactory';
import { ChainId, DexId } from '../lp/types';
```

**Step 2: Update `POST /api/lookup-position`** handler similarly:

```typescript
const { tokenId, chain = 'base', dex = 'uniswap-v3' } = req.body as {
  tokenId: number;
  chain?: ChainId;
  dex?: DexId;
};
const scanner = createWalletScanner(chain, dex);
const position = await scanner.lookupById(tokenId);
```

**Step 3: Update `POST /api/activate`** handler to persist `chain` and `dex` in the `ActivePositionConfig`:

```typescript
// In the activate handler, when building the config:
config.chain = req.body.chain ?? 'base';
config.dex   = req.body.dex   ?? 'uniswap-v3';
config.positionId = req.body.tokenId ?? req.body.positionId;
```

**Step 4: Compile check + commit**

```bash
npx tsc --noEmit
git add src/dashboard/server.ts
git commit -m "feat(multi-chain): server routes — chain/dex params in scan, lookup, and activate handlers"
```

---

## Task 15: index.ts — use correct LP reader per position

**Files:**
- Modify: `src/index.ts`

**Step 1: Find where `UniswapReader` is instantiated** in `index.ts` (typically in `getOrCreateEngineContext`).

Replace the hardcoded `new UniswapReader()` with `createLPReader(chain, dex)`:

```typescript
import { createLPReader } from './lp/lpReaderFactory';
import { ChainId, DexId } from './lp/types';

// Inside getOrCreateEngineContext or similar:
const chain: ChainId = posConfig.chain ?? 'base';
const dex: DexId     = posConfig.dex   ?? (posConfig.protocolVersion === 'v4' ? 'uniswap-v4' : 'uniswap-v3');
const lpReader = createLPReader(chain, dex);
```

**Step 2: Update calls to `lpReader.readPosition()`** — signature is now `(id: PositionId, poolAddress: string)` which is the same as before, just typed via `ILPReader`.

**Step 3: Update calls to `lpReader.invalidateCache()`** — same signature, no change needed.

**Step 4: Verify the Rebalancer receives the correct reader** — `Rebalancer` already accepts `IHedgeExchange`; it does not hold a reference to the LP reader (the reader is called from `index.ts` loop). Confirm the loop passes the read position to `rebalancer.runCycle(tokenId, position, ...)`.

**Step 5: Compile check + commit**

```bash
npx tsc --noEmit
git add src/index.ts
git commit -m "feat(multi-chain): index.ts — create LP reader from position's chain/dex config"
```

---

## Task 16: Final compile + smoke test

**Step 1: Full type check**

```bash
npx tsc --noEmit
```
Expected: zero errors.

**Step 2: Build**

```bash
npm run build
```
Expected: compiles to `dist/` without errors.

**Step 3: Smoke test dry-run** (optional, if you have `.env` configured)

```bash
DRY_RUN=true npx ts-node src/index.ts
```
Expected: starts without errors, logs `chain=base dex=uniswap-v3` (or v4) for existing positions.

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat(multi-chain): full EVM multi-chain + multi-DEX expansion — phase 1 complete"
```

---

## Known Gaps (require follow-up)

1. **ProjectX (HL L1)** — Contract addresses unknown. Research at https://www.prjx.com before adding to `chainRegistry.ts`. The reader will be an `EvmClReader` if V3-compatible, or a new reader if they use a custom model.

2. **Pancakeswap V4 addresses** — BSC and ETH V4 PositionManager addresses need to be verified. Add to `chainRegistry.ts` once confirmed.

3. **Uniswap V4 on non-Base chains** — StateView addresses for ETH/Arb/Polygon need verification before enabling in the registry.

4. **Aerodrome CL init code hash** — Verify the init code hash in `chainRegistry.ts` is correct for CREATE2 pool resolution.

5. **Phase 2: Solana** — Requires `@solana/web3.js`, new `SolanaReader` and `SolanaScanner` implementations for Orca (Whirlpool), Raydium (CLMM), Meteora (DLMM).
