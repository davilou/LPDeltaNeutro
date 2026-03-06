# Multi-Chain + Multi-DEX Expansion — Design Doc

**Date**: 2026-03-06
**Status**: Approved
**Approach**: Thin Adapter (A)

---

## Scope

### Phase 1 — EVM (this plan)
- **Chains**: Base (existing), ETH, BSC, Arbitrum, Polygon, Avalanche, Hyperliquid L1
- **DEXes**: Uniswap V3/V4, Pancakeswap V3/V4 (BSC/ETH/Arb/Polygon), Aerodrome CL (Base), ProjectX (HL L1)
- **Hedge**: All positions hedged via Hyperliquid perps (unchanged)

### Phase 2 — Solana (future)
- Orca (Whirlpool), Raydium (CLMM), Meteora (DLMM)
- Architecture is Solana-aware: `PositionId = number | string`

---

## Architecture: LP Layer

### New directory structure

```
src/lp/
├── types.ts                  # ILPReader, IWalletScanner, PositionId, ChainId, DexId
├── chainRegistry.ts          # Contract addresses per (chain, dex)
├── tokenCache.ts             # Global token info cache per chain
├── readers/
│   ├── evmClReader.ts        # Base class: Uniswap V3-compatible logic, parameterised by addresses
│   ├── evmV4Reader.ts        # Base class: Uniswap V4-compatible logic, parameterised by addresses
│   └── solanaReader.ts       # Phase 2 stub — throws NotYetImplementedError
├── scanners/
│   ├── evmScanner.ts         # WalletScanner refactored, parameterised by chain/dex
│   └── solanaScanner.ts      # Phase 2 stub
├── lpReaderFactory.ts        # Factory: (chain, dex) → ILPReader
├── walletScannerFactory.ts   # Factory: (chain) → IWalletScanner
├── uniswapReader.ts          # Re-export for backwards compat (no breaking change)
└── walletScanner.ts          # Re-export for backwards compat
```

### Core interfaces

```typescript
type ChainId = 'base' | 'eth' | 'bsc' | 'arbitrum' | 'polygon' | 'avalanche' | 'hyperliquid-l1';
type DexId   = 'uniswap-v3' | 'uniswap-v4' | 'pancake-v3' | 'pancake-v4' | 'aerodrome-cl' | 'project-x';
type PositionId = number | string; // EVM: NFT tokenId (number), Solana: pubkey (string)

interface ILPReader {
  readPosition(id: PositionId, poolAddress: string): Promise<LPPosition>;
  invalidateCache(id: PositionId): void;
  getBlockOrSlot(): Promise<number>;
}

interface IWalletScanner {
  scanWallet(address: string): Promise<DiscoveredPosition[]>;
  lookupById(id: PositionId): Promise<DiscoveredPosition | null>;
}
```

### `evmClReader.ts` — base class for V3-compatible DEXes

All Uniswap V3-style DEXes (Uniswap V3 on all chains, Pancakeswap V3, Aerodrome CL) share the same
tick/liquidity math. `EvmClReader` takes a `ChainDexConfig` with contract addresses and reuses the
existing `readV3Position` / `readV4Position` logic verbatim (no duplicate code).

### `chainRegistry.ts` — address table

| Chain | DEX | PositionManager V3 | Factory V3 | Init Hash |
|-------|-----|-------------------|------------|-----------|
| Base | Uniswap V3 | 0x03a520... | 0x33128a... | e34f19... |
| Base | Uniswap V4 | 0x7c5f5a... | — | — |
| Base | Aerodrome CL | 0x827922... | 0x5e7BB1... | — |
| ETH | Uniswap V3 | 0xC36442... | 0x1F9843... | — |
| ETH | Uniswap V4 | 0x7C0f70... | — | — |
| ETH | Pancakeswap V3 | 0x46A15B... | 0x0BFbCF... | — |
| BSC | Pancakeswap V3 | 0x46A15B... | 0x0BFbCF... | — |
| BSC | Pancakeswap V4 | TBD | — | — |
| Arbitrum | Uniswap V3 | 0xC36442... | 0x1F9843... | — |
| Arbitrum | Pancakeswap V3 | 0x46A15B... | 0x0BFbCF... | — |
| Polygon | Uniswap V3 | 0xC36442... | 0x1F9843... | — |
| Avalanche | Uniswap V3 | 0x655C40... | 0x740b1c... | — |
| HL L1 | ProjectX | TBD (research needed) | — | — |

---

## RPC Optimization

### 1. Multicall3 batching
- Address: `0xcA11bde05977b3631167028862bE2a173976CA11` (universal, all EVMs)
- Batch `eth_call`s: `positions()`, `slot0()`, `getTokenInfo()` for multiple positions → 1 RPC call
- New `src/utils/multicall.ts` helper wrapping `Multicall3.aggregate3()`
- Opt-in via `MULTICALL3_ENABLED=true` (default true)

### 2. Per-chain FallbackProvider pool
- Each chain has its own `FallbackProvider` instance with its RPC list
- Shared across all readers/scanners for the same chain
- `src/lp/chainProviders.ts` — lazy-init provider pool, one instance per ChainId

### 3. Global token info cache per chain
- `src/lp/tokenCache.ts` — `Map<ChainId, Map<address, TokenInfo>>`
- Shared across all reader instances for the same chain
- Eliminates duplicate `decimals()` + `symbol()` calls when multiple positions share tokens (e.g. USDC)

---

## Type Changes

### `src/types.ts` additions

```typescript
// New top-level types (also exported from src/lp/types.ts)
type ChainId    = 'base' | 'eth' | 'bsc' | 'arbitrum' | 'polygon' | 'avalanche' | 'hyperliquid-l1';
type DexId      = 'uniswap-v3' | 'uniswap-v4' | 'pancake-v3' | 'pancake-v4' | 'aerodrome-cl' | 'project-x';
type PositionId = number | string;

// ActivePositionConfig — 3 new fields
interface ActivePositionConfig {
  // ...existing fields...
  chain: ChainId;           // default: 'base' (state migration)
  dex: DexId;               // default: 'uniswap-v3' (state migration)
  positionId: PositionId;   // alias for tokenId; number for EVM, string for Solana
}

// DiscoveredPosition — 2 new fields
interface DiscoveredPosition {
  // ...existing fields...
  chain: ChainId;
  dex: DexId;
}
```

### `src/config.ts` additions

```
# Per-chain RPC URLs (HTTP)
ETH_HTTP_RPC_URL=
BSC_HTTP_RPC_URL=
ARB_HTTP_RPC_URL=
POLYGON_HTTP_RPC_URL=
AVAX_HTTP_RPC_URL=
HL_L1_HTTP_RPC_URL=

# Multicall3
MULTICALL3_ENABLED=true    # batch eth_calls, default true
```

---

## Dashboard Changes

### Scan + Lookup UI

```
Scan:   [ Chain ▼ ] [ DEX ▼ ] [ Wallet Address _____________ ] [SCAN]
Lookup: [ Chain ▼ ] [ DEX ▼ ] [ Token ID / Position ID ______ ] [LOOKUP]
```

- Chain dropdown: Base (default), ETH, BSC, Arbitrum, Polygon, Avalanche, HL L1
- DEX dropdown: populated dynamically based on selected chain
- RPCs remain in `.env` only — no RPC settings in the dashboard UI

### Position card
- Badge shows `chain • dex` (e.g. `BSC • PancakeSwap V3`)

### Activation flow (`POST /api/activate`)
```
1. Frontend sends: { positionId, chain, dex, ... }
2. server.ts → lpReaderFactory.create(chain, dex) → ILPReader
3. walletScannerFactory.create(chain) → IWalletScanner
4. Engine context created with correct reader
5. Rebalancer uses ILPReader interface (no internal changes)
```

---

## State Migration

`Rebalancer.loadState()` already has migration logic. Add defaults for existing positions:
```typescript
if (!pos.config.chain) pos.config.chain = 'base';
if (!pos.config.dex)   pos.config.dex = 'uniswap-v3';
if (pos.config.positionId === undefined) pos.config.positionId = pos.config.tokenId;
```

---

## Phase 2 Stubs (Solana-awareness)

- `src/lp/readers/solanaReader.ts` — implements `ILPReader`, throws `NotYetImplementedError`
- `src/lp/scanners/solanaScanner.ts` — implements `IWalletScanner`, throws `NotYetImplementedError`
- ChainId `'solana'` already reserved in type union
- `PositionId = string` for Solana pubkeys (no numeric tokenId)

---

## Out of Scope

- Backtest module: no changes (uses mock data, not chain-specific)
- Hedge execution: no changes (always Hyperliquid perps)
- Auth/Supabase: no changes
- PnL tracking: no changes (HL API, chain-agnostic)
