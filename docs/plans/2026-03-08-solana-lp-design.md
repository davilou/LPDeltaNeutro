# Design: Solana LP Integration (Orca, Raydium, Meteora)

**Date:** 2026-03-08
**Status:** Approved

## Objetivo

Implementar Phase 2 do módulo LP para suportar pools de liquidez concentrada na Solana:
- **Orca Whirlpool** (CLMM)
- **Raydium CLMM**
- **Meteora DLMM**

O hedge continua indo para Hyperliquid (sem alteração no módulo hedge). A integração segue o padrão thin adapter existente (idêntico ao EVM).

## Abordagem

Opção escolhida: **uma classe reader por protocolo com base comum** (`SolanaBaseReader`), espelhando o padrão `EvmClReader`/`EvmV4Reader`.

SDKs oficiais de cada protocolo + `@solana/web3.js` como base RPC. RPC gratuito via `https://api.mainnet-beta.solana.com` (configurável via `.env`).

## Mudanças de Tipos

### `src/lp/types.ts`
Adicionar ao `DexId`:
```typescript
| 'orca'     // Orca Whirlpool (CLMM)
| 'raydium'  // Raydium CLMM
| 'meteora'  // Meteora DLMM
```

### `src/types.ts`
- `DiscoveredPosition.tokenId`: `number` → `PositionId` (suporte a pubkeys string Solana)
- `ActivePositionConfig.tokenId`: `number` → `PositionId`
- `BotState.positions`: `Record<number, PositionState>` → `Record<PositionId, PositionState>`
- `HistoricalPosition.tokenId`: `number` → `PositionId`

> Posições EVM existentes no `state.json` não são afetadas — continuam com `number`.

## Estrutura de Arquivos

```
src/lp/
  readers/
    solanaBaseReader.ts          ← conexão @solana/web3.js, getSlot(), cache por pubkey
    orca/orcaReader.ts           ← ILPReader via @orca-so/whirlpools-sdk
    raydium/raydiumReader.ts     ← ILPReader via @raydium-io/raydium-sdk-v2
    meteora/meteoraReader.ts     ← ILPReader via @meteora-ag/dlmm
  scanners/
    solanaScannerImpl.ts         ← IWalletScanner unificado, roteamento por DexId
                                    (substitui o stub SolanaScanner)
```

## Mapeamento de Dados para LPPosition

| Campo | Orca Whirlpool | Raydium CLMM | Meteora DLMM |
|---|---|---|---|
| liquidity | `position.liquidity` | `personalPosition.liquidity` | bin liquidity calculada |
| tickLower | `position.tickLowerIndex` | `personalPosition.tickLowerIndex` | `lowerBinId` → tick virtual |
| tickUpper | `position.tickUpperIndex` | `personalPosition.tickUpperIndex` | `upperBinId` → tick virtual |
| tickCurrent | `whirlpool.tickCurrentIndex` | `poolState.tickCurrent` | `lbPair.activeId` → tick virtual |
| price | `sqrtPrice` via SDK | `sqrtPriceX64` via SDK | `binStep` step price |
| amounts | SDK `getAmountsFromLiquidity()` | SDK equivalente | SDK equivalente |

Meteora DLMM usa bin IDs — convertidos para ticks virtuais via `binStep` para compatibilidade com `LPPosition`.

## RPC e Config

`.env` — nova variável:
```
SOLANA_HTTP_RPC_URL=https://api.mainnet-beta.solana.com
```

`src/config.ts`:
```typescript
get solanaHttpRpcUrl(): string {
  return process.env.SOLANA_HTTP_RPC_URL || 'https://api.mainnet-beta.solana.com';
}
```

`src/lp/chainProviders.ts` — `getChainProvider('solana')` retorna wrapper sobre `@solana/web3.js Connection` com retry automático. Não usa `FallbackProvider` ethers (incompatível com Solana RPC).

## Scan de Carteira

`SolanaScannerImpl.scanWallet(address: string)`:
- Orca: `getProgramAccounts` no program Whirlpool, filtrando por owner
- Raydium: `getProgramAccounts` no program CLMM, filtrando por owner
- Meteora: `getProgramAccounts` no program LB CLMM, filtrando por owner
- Retorna `DiscoveredPosition[]` com mesmo schema do EVM

`SolanaScannerImpl.lookupById(pubkey: string)`:
- `getAccountInfo(pubkey)` + decode via SDK do dex correspondente

## Factories

`lpReaderFactory.ts` — bloco `SOLANA_CHAINS.has(chain)`, roteia por `dex`:
```typescript
if (dex === 'orca')    return new OrcaReader(connection);
if (dex === 'raydium') return new RadiumReader(connection);
if (dex === 'meteora') return new MeteoraReader(connection);
throw new Error(`Unsupported Solana dex: ${dex}`);
```

`walletScannerFactory.ts` — passa `chain` e `dex` para `SolanaScannerImpl(dex, connection)`.

## Dashboard

`src/dashboard/public/index.html`:
- Adicionar `<option value="solana">Solana</option>` nos dois `<select>` de chain
- `DEX_OPTIONS_BY_CHAIN.solana = ['orca', 'raydium', 'meteora']`
- `DEX_LABELS`: `'orca': 'Orca Whirlpool'`, `'raydium': 'Raydium CLMM'`, `'meteora': 'Meteora DLMM'`
- Placeholder do campo wallet: condicionado à chain selecionada (ex: `Sol wallet (base58)` vs `0x…`)

## Dependências a Instalar

```bash
npm install @solana/web3.js @orca-so/whirlpools-sdk @raydium-io/raydium-sdk-v2 @meteora-ag/dlmm
```

## Impacto no Engine

`rebalancer.ts` e `index.ts` — **sem alteração**. Já operam via `ILPReader`/`IWalletScanner`.
`HyperliquidExchange` — **sem alteração**. Hedge continua igual.
`state.json` — **sem quebra**. Posições EVM existentes com `number` continuam válidas.

## Fora de Escopo

- Suporte a Solana no `priceApi.ts` (DexScreener slug para Solana) — pode ser adicionado separadamente
- Backtesting com dados históricos Solana
- WebSocket de blocos Solana (bot usa polling por slot, não WS)
