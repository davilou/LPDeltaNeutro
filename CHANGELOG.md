# Changelog

## [Unreleased] — 2026-03-11

### Bug Fix — HL Funding always zero

`getIsolatedPnl()` em `hyperliquidExchange.ts` acessava `f.coin` / `f.usdc` diretamente na resposta de `userFunding`, mas a API do HL retorna com wrapper `delta`: `{ delta: { coin, usdc, ... }, hash, time }`. O filtro por `f.coin` dava `undefined` → nenhuma entry passava → funding cumulativo sempre zero para todas as posições ativas.

**Correção**: acessa `f.delta?.coin ?? f.coin` e `f.delta?.usdc ?? f.usdc` para suportar ambos os formatos (SDK `getUserFunding` e raw API `hlInfo` para HIP-3 dexes).

**Arquivo**: `src/hedge/hyperliquidExchange.ts` (linhas 429-443)

---

## [Unreleased] — 2026-03-07

### Multi-Chain + Multi-DEX Expansion (Phase 1 — EVM)

Expansão da camada LP para suportar múltiplas blockchains EVM e DEXes além de Uniswap na Base Chain, com arquitetura Thin Adapter e stubs Solana-aware para Phase 2.

#### Chains suportadas
| Chain | ChainId |
|---|---|
| Base (existente) | `base` |
| Ethereum Mainnet | `eth` |
| BNB Smart Chain | `bsc` |
| Arbitrum One | `arbitrum` |
| Polygon | `polygon` |
| Avalanche C-Chain | `avalanche` |
| Hyperliquid L1 *(stub)* | `hyperliquid-l1` |

#### DEXes suportados
| DEX | DexId | Chains |
|---|---|---|
| Uniswap V3 | `uniswap-v3` | Base, ETH, Arbitrum, Polygon, Avalanche |
| Uniswap V4 | `uniswap-v4` | Base, ETH |
| PancakeSwap V3 | `pancake-v3` | BSC, ETH, Arbitrum, Polygon |
| PancakeSwap V4 | `pancake-v4` | BSC *(TBD)* |
| Aerodrome CL | `aerodrome-cl` | Base |
| ProjectX | `project-x` | Hyperliquid L1 *(stub)* |

#### Arquitetura — Thin Adapter Pattern

A lógica de leitura V3/V4 existente foi extraída em classes base parametrizadas por endereços de contrato:

- `src/lp/types.ts` — `ILPReader`, `IWalletScanner`, `ChainId`, `DexId`, `PositionId = number | string`
- `src/lp/chainRegistry.ts` — mapa `(ChainId, DexId)` → endereços de contratos (13 pares chain/dex)
- `src/lp/readers/evmClReader.ts` — `EvmClReader`: base class para DEXes V3-compatíveis (Uniswap V3, PancakeSwap V3, Aerodrome CL)
- `src/lp/readers/evmV4Reader.ts` — `EvmV4Reader`: base class para DEXes V4-compatíveis
- `src/lp/readers/solanaReader.ts` — stub Phase 2; lança `Error` com mensagem explicativa
- `src/lp/scanners/evmScanner.ts` — `EvmScanner`: `IWalletScanner` parametrizado por chain/dex
- `src/lp/scanners/solanaScanner.ts` — stub Phase 2
- `src/lp/lpReaderFactory.ts` — `createLPReader(chain, dex): ILPReader`
- `src/lp/walletScannerFactory.ts` — `createWalletScanner(chain, dex): IWalletScanner`

Backwards-compat: `uniswapReader.ts` e `walletScanner.ts` continuam exportando as classes originais + novos exports.

#### Otimização de RPC

- **Per-chain FallbackProvider pool** (`src/lp/chainProviders.ts`): instância única por chain, lazy-init, compartilhada entre todos os readers/scanners da mesma chain.
- **Global token cache per chain** (`src/lp/tokenCache.ts`): elimina chamadas duplicadas a `symbol()` e `decimals()` quando múltiplas posições compartilham tokens (ex: USDC).
- **Multicall3 utility** (`src/utils/multicall.ts`): helper para batching de `eth_call`s via `0xcA11bde05977b3631167028862bE2a173976CA11` (universal em todas as EVMs), controlado por `MULTICALL3_ENABLED`.

#### Dashboard — Scan/Lookup com chain/dex

- Scan e Lookup agora exibem selectors `Chain` e `DEX` antes dos campos de endereço/token ID
- DEX dropdown popula dinamicamente baseado na chain selecionada
- Card de posição exibe badge `chain • dex` (ex: `BSC • PancakeSwap V3`)

#### State migration

Posições existentes (sem `chain`/`dex`) recebem defaults automáticos no `loadState()`:
```
chain = 'base'
dex = 'uniswap-v3' ou 'uniswap-v4' (baseado em protocolVersion)
positionId = tokenId
```

#### Novas variáveis de ambiente

```env
# RPCs por chain (aceita múltiplas URLs separadas por vírgula)
ETH_HTTP_RPC_URL=
BSC_HTTP_RPC_URL=
ARB_HTTP_RPC_URL=
POLYGON_HTTP_RPC_URL=
AVAX_HTTP_RPC_URL=
HL_L1_HTTP_RPC_URL=

# Multicall3 (batching de eth_calls, default true)
MULTICALL3_ENABLED=true
```

#### Arquivos modificados
- `src/lp/types.ts` *(novo)*
- `src/lp/chainRegistry.ts` *(novo)*
- `src/lp/tokenCache.ts` *(novo)*
- `src/lp/chainProviders.ts` *(novo)*
- `src/lp/lpReaderFactory.ts` *(novo)*
- `src/lp/walletScannerFactory.ts` *(novo)*
- `src/lp/readers/evmClReader.ts` *(novo)*
- `src/lp/readers/evmV4Reader.ts` *(novo)*
- `src/lp/readers/solanaReader.ts` *(novo — stub Phase 2)*
- `src/lp/scanners/evmScanner.ts` *(novo)*
- `src/lp/scanners/solanaScanner.ts` *(novo — stub Phase 2)*
- `src/utils/multicall.ts` *(novo)*
- `src/lp/uniswapReader.ts` — re-exports adicionados
- `src/lp/walletScanner.ts` — re-exports adicionados
- `src/engine/rebalancer.ts` — state migration
- `src/types.ts` — novos campos opcionais + re-exports
- `src/config.ts` — novos getters de RPC por chain
- `src/dashboard/store.ts` — `ActivatePositionRequest` com chain/dex/positionId
- `src/dashboard/server.ts` — rotas scan/lookup/activate usam factories
- `src/dashboard/public/index.html` — selectors chain/dex, badge no card
- `src/index.ts` — usa `createLPReader` no lugar de `UniswapReader`

---

### Dashboard: Auto Hedge — Balancear extremos do range

Novo modo **AUTO** no campo Hedge Size da calculadora. Calcula automaticamente o percentual de hedge que iguala o P&L líquido nos dois extremos do range (▲ RANGE MAX e ▼ RANGE MIN), criando proteção simétrica.

#### Funcionamento

- Toggle `MANUAL | AUTO` no label do campo Hedge Size (mesmo padrão visual dos toggles `USD | %`)
- Modo AUTO: campo fica desabilitado (cinza); ao clicar CALCULATE, o % ótimo é calculado e exibido no campo
- Painel de resultados mostra badge `Cenários · AUTO HEDGE` quando o modo está ativo
- Caso `H ≤ 0` (range não requer hedge para equalizar): campo mostra `0.00` com aviso informativo; tabela ainda é exibida

#### Matemática (solução analítica)

```
lpPnl_up   = lpValue(L, Pb, Pa, Pb) − V    # P&L LP ao sair pelo topo (100% stablecoin)
lpPnl_down = lpValue(L, Pa, Pa, Pb) − V    # P&L LP ao sair pelo fundo (100% volátil)

H = (lpPnl_up − lpPnl_down) × P / (Pb − Pa)   # hedge notional USD
hedgePct = H / (xTokens × P) × 100             # converte para % da exposição volátil
```

#### Arquivos modificados
- `src/dashboard/public/index.html` — toggle HTML, CSS `.calc-field .t-in:disabled`, `hedgeModeState`, `window.setHedgeMode`, lógica auto em `runCalc`

---

### Dashboard: Hedge Calculator

Nova aba **CALCULATOR** no dashboard — ferramenta client-side para simular o impacto de movimentos de preço em uma posição LP com hedge.

#### Funcionalidades

- **Inputs**: Pool Value (USD), Current Price, Range Min/Max, Hedge Size (%), Pool APR
- **Range Mode**: cada campo de range tem um toggle `USD | %` — no modo `%`, o preço é calculado como percentual do Current Price (ex: 10% abaixo → Pa = P × 0.90)
- **Tabela de cenários**: 7 linhas fixas (−15%, −10%, −5%, Atual, +5%, +10%, +15%) + 2 linhas dinâmicas de range (▲ RANGE MAX / ▼ RANGE MIN) inseridas na posição correta por preço, ordenadas de +15% no topo a −15% na base
- **Hedge Size em %**: representa a fração da exposição ao ativo volátil que será protegida. O notional é calculado como `xTokens × preço × hedgePct/100`, onde `xTokens = L × (1/√P − 1/√Pb)` (fórmula Uniswap V3)
- **Farm diário**: estimativa baseada no APR informado (`V × APR/100 / 365`), visível quando APR > 0
- Toda a lógica é client-side (zero backend)

#### Arquivos modificados
- `src/dashboard/public/index.html` — nova aba CALCULATOR, CSS (`.calc-layout`, `.calc-field`, `.calc-result-table`, `.range-mode-toggle`, etc.), HTML de inputs e tabela, IIFE com `computeL`, `lpValue`, `runCalc`, `setRangeMode`

---

## [Unreleased] — 2026-03-05

### Correção: LP Fees V4 para pools com ETH nativo

#### Problema
Posições V4 com ETH nativo (address(0)) retornavam LP Fees = 0. O overload de 5 argumentos `getPositionInfo(bytes32, address, int24, int24, bytes32)` do contrato StateView revertia com `missing revert data` especificamente para pools de ETH nativo.

#### Solução
Migração para o overload de 2 argumentos `getPositionInfo(bytes32 poolId, bytes32 positionId)`, onde `positionId = keccak256(abi.encodePacked(owner, tickLower, tickUpper, salt))`. Funciona para todos os pools V4 independente do tipo de moeda (ERC-20 ou ETH nativo).

Adicionado `getFeeGrowthInside(poolId, tickLower, tickUpper)` para calcular diretamente o delta de fee growth, eliminando a necessidade do slot0 e do cálculo manual com tick info.

**Fórmula:**
```
positionId = keccak256(encodePacked(pmAddress, tickLower, tickUpper, bytes32(tokenId)))
delta0 = uint256(feeGrowthInside0 - feeGrowthInsideLast0)
fees0 = (liquidity * delta0) >> 128
```

#### Arquivos modificados
- `src/lp/uniswapReader.ts` — ABI atualizado (2-arg overload), `computeV4Fees` simplificado

---

## [Unreleased] — 2026-03-04

### Supabase: tabela `protection_activations`

Ao ativar uma proteção, o sistema agora persiste um snapshot da posição LP no Supabase. Isso permite restaurar o baseline de P&L após reinícios sem depender exclusivamente do `state.json`.

#### O que é salvo

Ao chamar `activatePosition`: pool address, NFT ID, tokens, amounts (token0/token1 no momento da ativação), valor LP em USD, LP fees acumuladas, timestamp de ativação.

#### Restore automático no startup

Se o `PnlTracker` não estiver inicializado após carregar o `state.json` (ex: nova instância, migração), o sistema busca o registro em `protection_activations` no Supabase e chama `tracker.reinitialize()` automaticamente.

#### SQL (rodar manualmente no Supabase)

```sql
CREATE TABLE protection_activations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token_id INTEGER NOT NULL,
  pool_address TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  token0_symbol TEXT NOT NULL,
  token1_symbol TEXT NOT NULL,
  token0_amount NUMERIC NOT NULL DEFAULT 0,
  token1_amount NUMERIC NOT NULL DEFAULT 0,
  initial_lp_usd NUMERIC NOT NULL DEFAULT 0,
  initial_lp_fees_usd NUMERIC NOT NULL DEFAULT 0,
  initial_timestamp BIGINT NOT NULL,
  fee INTEGER,
  tick_lower INTEGER,
  tick_upper INTEGER,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, token_id)
);
CREATE INDEX idx_protection_activations_user_id ON protection_activations(user_id);
```

#### Arquivos modificados
- `src/db/types.ts` — `ProtectionActivationRecord`
- `src/db/supabase.ts` — `upsertProtectionActivation()`, `fetchProtectionActivation()`
- `src/index.ts` — upsert após ativação; restore no startup via `getOrCreateEngineContext`

---

## [Unreleased] — 2026-03-03

### Google Auth + Multi-tenancy

Autenticação via Google OAuth 2.0. Cada conta Google tem seu próprio dashboard isolado — posições, P&L e dados no Supabase separados por `user_id`.

#### Fluxo
```
GET /auth/google → Google OAuth → GET /auth/callback → findOrCreateUser() → session cookie
req.session.userId → getStoreForUser(userId) → dados isolados por usuário
GET /auth/logout → destroy session → redirect /login.html
```

#### Módulo `src/auth/`
- `types.ts` — interface `AuthUser`, augmentação de `express-session`
- `encrypt.ts` — AES-256-GCM encrypt/decrypt da chave privada HL
- `userStore.ts` — CRUD Supabase na tabela `users` (findOrCreate, loadCredentials, saveCredentials)
- `passport.ts` — Google Strategy + serialize/deserialize
- `middleware.ts` — `requireAuth` (protege todas as rotas `/api/`)

#### Isolamento por usuário
- Estado persistido em `state-{userId}.json` (um arquivo por usuário)
- `getStoreForUser(userId)` — map de userId → DashboardStore
- `getOrCreateEngineContext(userId)` — map de userId → engine context
- Inserts Supabase passam `user_id` em todas as tabelas

#### Novas variáveis de ambiente
```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=https://seudominio.com/auth/callback
SESSION_SECRET=
CREDENTIAL_ENCRYPTION_KEY=
ALLOWED_EMAILS=             # opcional; vazio = qualquer Google
SUPABASE_POSTGRES_URL=      # para connect-pg-simple (sessões no Postgres)
```

#### SQL (rodar manualmente no Supabase)
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_id TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  hl_private_key_enc TEXT,
  hl_private_key_iv TEXT,
  hl_private_key_tag TEXT,
  hl_wallet_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE rebalances ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE closed_positions ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;
```

#### Arquivos modificados
- `src/auth/` — 5 novos arquivos
- `src/config.ts` — 6 novos env vars
- `src/dashboard/server.ts` — session+passport setup, rotas `/auth/*`, `requireAuth` em todas as rotas API
- `src/dashboard/store.ts` — `getStoreForUser(userId)`
- `src/engine/rebalancer.ts` — construtor recebe `userId`, arquivo de estado usa `state-{userId}.json`
- `src/index.ts` — `UserEngineContext` map, `getOrCreateEngineContext(userId)`
- `src/dashboard/public/login.html` — página de login com botão Google
- `src/dashboard/public/index.html` — check `/api/auth/me` no load, botão LOGOUT

---

## [Unreleased] — 2026-03-03

### Dashboard: cards por posição + LP Fees em P&L Isolado

#### O que mudou

O dashboard agora exibe um bloco de cards separado para cada posição ativa simultaneamente, em vez de mostrar apenas a posição selecionada via abas.

- **Multi-posição**: a seção de métricas (`#allMetrics`) é gerada dinamicamente. `positionMetricsHtml(tokenId, cfg)` produz o HTML completo de uma posição; `renderAllMetrics()` cria/remove blocos conforme posições são ativadas/desativadas.
- **IDs prefixados**: todos os elementos de monitoramento usam `${tokenId}-` como prefixo (ex: `123-netDelta`, `123-pnlTotal`). `updateCards(d)` atualiza o bloco da posição correspondente sem depender da aba ativa.
- **Controles por posição**: cada bloco tem seus próprios inputs de Strategy Config e botões de ação — `updatePositionConfig(tokenId)`, `deactivatePosition(tokenId)`, `resetPositionPnl(tokenId)`.
- **LP Fees**: adicionado campo `LP Fees` no card P&L Isolado, exibindo `lpFeesUsd` em verde.
- **Abas**: agora visíveis apenas quando há 2+ posições ativas, usadas exclusivamente para selecionar qual posição aparece no gráfico e na tabela de rebalances.

#### Arquivos modificados
- `src/dashboard/public/index.html` — remoção do bloco `.metrics` estático; adição de `positionMetricsHtml`, `renderAllMetrics`, `updateCards` refatorado, `updatePositionConfig`, `deactivatePosition`, `resetPositionPnl`; CSS `.position-metrics-block`, `.pos-metrics-header`

---

## [Unreleased] — 2026-02-27

### Lookup por token ID, cooldown por posição, reconciliação de estado virtual

#### O que mudou

- **Lookup por token ID**: `WalletScanner.lookupByTokenId(tokenId)` busca qualquer NFT diretamente pelo ID sem verificar ownership. Endpoint `POST /api/lookup-position` exposto no dashboard — permite proteger posições sem escanear a carteira.
- **Cooldown por posição**: `ActivePositionConfig.cooldownSeconds` sobrescreve o `REBALANCE_INTERVAL_MIN` global para aquela posição específica. Configurável via campo **Cooldown (m)** no dashboard.
- **Reconciliação de estado virtual**: `rebalancer.ts` detecta drift > 10% entre o tamanho de hedge virtual e a posição real na HL e reconcilia automaticamente. `PnlTracker.reconcilePosition()` corrige o estado interno.
- **Correção forced close**: lógica considera a direção do token hedgeado para determinar corretamente acima/abaixo do range.
- **Correção hedgeRatio**: `0` tratado como não definido — fallback para `1.0`.

#### Arquivos modificados
- `src/lp/walletScanner.ts` — `lookupByTokenId()`
- `src/dashboard/server.ts` — `POST /api/lookup-position`
- `src/engine/rebalancer.ts` — cooldown por posição, reconciliação, correção forced close, correção hedgeRatio
- `src/pnl/tracker.ts` — `reconcilePosition()`
- `src/types.ts` — `cooldownSeconds` em `ActivePositionConfig`
- `src/dashboard/store.ts`, `src/index.ts` — wiring

---

## [Unreleased] — 2026-03-02

### PnL isolado via API Hyperliquid (substitui tracking virtual)

#### Motivação
O tracking de realized PnL, fees e funding era feito **localmente de forma estimada** (`PnlTracker.recordTrade`, `accumulateFunding`, `recordTradeFee`). Isso causava drift em relação aos valores reais da HL, especialmente após reinícios do bot (o tracker resetava o estado virtual enquanto a posição real permanecia aberta).

#### O que mudou

O módulo `pnl/tracker.ts` foi simplificado: todo o virtual accounting foi removido. Os dados de PnL agora vêm **diretamente da API da HL**, filtrados por coin e por `initialTimestamp` da posição.

**Fluxo por ciclo — antes:**
```
getPosition()
accumulateFunding(fundingRate, virtualNotionalUsd)
[se rebalance] recordTrade(sizeChange, fillPx) + recordTradeFee(notional)
compute(lpUsd, hlEquity, lpFees, currentMarketPrice)  →  estimativa local
```

**Fluxo por ciclo — depois:**
```
getPosition()            → currentHedge (inclui unrealizedPnlUsd da clearinghouse)
getIsolatedPnl(sym, initialTimestamp)  → fills + funding reais da HL, filtrados por coin
hlPnl = { unrealizedPnlUsd: currentHedge.unrealizedPnlUsd, ...apiResult }
compute(lpUsd, hlEquity, lpFees, hlPnl)  → valores exatos da HL
```

#### Endpoints HL usados
- `sdk.info.getUserFillsByTime(wallet, sinceTs)` → fills com `closedPnl` e `fee` por trade
- `sdk.info.perpetuals.getUserFunding(wallet, sinceTs)` → funding pago/recebido por período
- `getClearinghouseState` (já chamado em `getPosition()`) → `unrealizedPnl` por coin

#### Interfaces alteradas

**`PnlState`** (persistida em `state.json`) — simplificada:
```typescript
// antes
{ initialLpUsd, initialHlUsd, initialLpFeesUsd, initialTimestamp,
  cumulativeFundingUsd, cumulativeHlFeesUsd, lastFundingTimestamp,
  virtualSize, avgEntryPrice, realizedPnlUsd, virtualPnlUsd }

// depois
{ initialLpUsd, initialHlUsd, initialLpFeesUsd, initialTimestamp }
```

**`HedgeState`** — adicionado campo `unrealizedPnlUsd?: number`

**`HlIsolatedPnl`** — nova interface em `src/hedge/types.ts`:
```typescript
{ unrealizedPnlUsd, realizedPnlUsd, cumulativeFundingUsd, cumulativeFeesUsd }
```

**`PnlSnapshot`** — removidos `virtualSize` e `avgEntryPrice` (não mais relevantes)

#### Métodos removidos de `PnlTracker`
- `accumulateFunding()`
- `recordTrade()`
- `recordTradeFee()`
- `getVirtualState()`
- `reconcilePosition()`
- `reinitializeVirtualPrice()`

#### Métodos adicionados
- `HyperliquidExchange.getIsolatedPnl(symbol, sinceTimestamp)` — busca fills + funding na HL, retorna zeros com warning em caso de erro (não quebra o ciclo)
- `MockExchange.getIsolatedPnl()` — stub, retorna zeros

#### `tradePnlUsd` para Supabase
Antes usava `virtualStateBefore.avgPrice` (tracking local). Agora usa `currentHedge.avgEntryPrice` (entryPx real da HL):
```typescript
const entryPx = currentHedge.avgEntryPrice ?? position.price;
const closedSz = sizeChange < 0 ? Math.min(currentHedge.size, Math.abs(sizeChange)) : 0;
const tradePnlUsd = closedSz > 0 ? (entryPx - (fillResult?.avgPx ?? position.price)) * closedSz : 0;
```

#### Arquivos modificados
- `src/hedge/types.ts` — `HlIsolatedPnl`, `getIsolatedPnl` em `IHedgeExchange`
- `src/types.ts` — `HedgeState.unrealizedPnlUsd`, `PnlState` simplificada, `PnlSnapshot` simplificada
- `src/hedge/hyperliquidExchange.ts` — lê `unrealizedPnl` em `getPosition()`, novo `getIsolatedPnl()`
- `src/hedge/mockExchange.ts` — stub `getIsolatedPnl()`
- `src/pnl/tracker.ts` — reescrito, `compute()` aceita `HlIsolatedPnl`
- `src/engine/rebalancer.ts` — remove virtual accounting, adiciona `getIsolatedPnl()` call, monta `hlPnl`
- `src/index.ts` — remove referências a campos removidos de `PnlState` e `getVirtualState()`

---

## [Unreleased] — 2026-02-25

### Mudança de arquitetura: gatilhos de rebalance por movimento de preço

#### Motivação
O sistema anterior usava **delta mismatch percentual** como gatilho principal de rebalance. Perto das bordas do range de liquidez, o token hedgeado (ex: VIRTUAL) fica com quantidade mínima na pool. Pequenas oscilações de preço causavam variações percentuais enormes nesse saldo (ex: 10→20 tokens = 100% de mismatch), disparando rebalances em loop sem valor econômico real.

#### O que mudou

**Gatilhos de rebalance — antes:**
| Gatilho | Descrição |
|---|---|
| Delta mismatch % | Dispara quando `|target - hedge| / target > DELTA_MISMATCH_THRESHOLD` |
| Delta mismatch % (emergency) | Threshold maior, bypassa cooldown; fecha % parcial do gap |
| Timer | Rebalance periódico |
| Range status change | Dispara quando LP entra/sai do range |

**Gatilhos de rebalance — depois:**
| Gatilho | Descrição |
|---|---|
| Price movement | Dispara quando `|preço atual - preço no último rebalance| / preço ref > PRICE_MOVEMENT_THRESHOLD` |
| Price movement (emergency) | Threshold maior, bypassa cooldown |
| Timer | Rebalance periódico (inalterado) |
| Forced close | LP saiu do range → fecha hedge imediatamente (inalterado) |

#### Variáveis de ambiente removidas
```
DELTA_MISMATCH_THRESHOLD
MIN_REBALANCE_USD
ADAPTIVE_THRESHOLD
ADAPTIVE_REFERENCE_TICK_RANGE
ADAPTIVE_MAX_THRESHOLD
EMERGENCY_MISMATCH_THRESHOLD
EMERGENCY_HEDGE_RATIO
TIME_REBALANCE_MIN_MISMATCH
NEAR_BOUNDARY_ZONE          (era temporário, nunca chegou ao .env.example)
NEAR_BOUNDARY_THRESHOLD_MULT (idem)
```

#### Variáveis de ambiente adicionadas
```env
# % de variação de preço desde o último rebalance para disparar rebalance normal
PRICE_MOVEMENT_THRESHOLD=0.05        # default: 5%

# % de variação de preço para emergency (bypassa cooldown)
EMERGENCY_PRICE_MOVEMENT_THRESHOLD=0.15   # default: 15%
```

#### Estado persistido (`state.json`)
- Adicionado campo `lastRebalancePrice` em `PositionState` — preço no momento do último rebalance executado, usado como referência para o gatilho de movimento de preço.
- Backward-compatible: migração automática define `lastRebalancePrice: 0` para estados antigos (primeiro ciclo sem referência não dispara price movement, aguarda timer ou forced close).

#### Arquivos modificados
- `src/config.ts` — novos campos, remoção dos antigos
- `src/types.ts` — `PositionState.lastRebalancePrice`, `ActivePositionConfig` atualizado
- `src/engine/rebalancer.ts` — novos métodos `checkPriceMovement`, `checkEmergencyPriceMovement`; remoção de `checkNeedsRebalance`, `checkEmergencyRebalance`, `computeEffectiveThreshold`, `computeNearBoundaryMultiplier`; `checkTimeRebalance` simplificado
- `src/dashboard/store.ts` — `DashboardData.lastRebalancePrice`, `ActivatePositionRequest` atualizado
- `src/dashboard/server.ts` — campos de ativação atualizados
- `src/index.ts` — campos de ativação atualizados
- `src/dashboard/public/index.html` — formulários de configuração e ativação atualizados; novo campo "Ref Price" exibe `lastRebalancePrice`
- `.env` / `.env.example` — variáveis atualizadas

#### Comportamento do emergency sem referência de preço
Se `lastRebalancePrice = 0` (posição recém-ativada ou migrada), os gatilhos de price movement e emergency retornam `null` — nenhum rebalance é disparado por preço. O primeiro rebalance ocorre via timer (`TIME_REBALANCE_INTERVAL_MIN`) ou forced close (saída de range).

---

## [Unreleased] — 2026-02-25 (refactors pós-arquitetura)

### REBALANCE_INTERVAL_MIN: merge de COOLDOWN_SECONDS + TIME_REBALANCE_INTERVAL_MIN

`COOLDOWN_SECONDS` e `TIME_REBALANCE_INTERVAL_MIN` eram dois parâmetros separados que na prática serviam ao mesmo propósito. Fundidos em `REBALANCE_INTERVAL_MIN` (default: 720 min = 12h), que age simultaneamente como intervalo periódico de rebalance e como cooldown mínimo entre rebalances.

- `config.ts`: `rebalanceIntervalMin` substitui `cooldownSeconds` e `timeRebalanceIntervalMin`
- `types.ts`, `store.ts`, `server.ts`, `index.ts`: remoção de `cooldownSeconds` do `ActivePositionConfig` global (o per-position override foi adicionado depois, em b9d6693)
- `rebalancer.ts`: `cooldownSec = rebalanceIntervalMin * 60`
- `.env.example`: `REBALANCE_INTERVAL_MIN=720`

### Remoção do limite por hora (MAX_HOURLY_REBALANCES)

O limite horário adicionava complexidade sem benefício claro dado que o cooldown mínimo (`REBALANCE_INTERVAL_MIN`) já previne execuções em excesso.

- `config.ts`, `types.ts`, `safety.ts`, `rebalancer.ts`, `backtest/`: remoção de `maxHourlyRebalances` e contadores horários

### Remoção de PRICE_MOVEMENT_THRESHOLD

O gatilho normal de price movement (non-emergency) era inatingível: o cooldown `REBALANCE_INTERVAL_MIN` impede o ciclo de verificação antes que o threshold seja relevante. Apenas o `EMERGENCY_PRICE_MOVEMENT_THRESHOLD` (bypassa cooldown) permanece como gatilho de preço.

- `config.ts`, `rebalancer.ts`, `store.ts`, `server.ts`, `index.ts`, `types.ts`, `.env.example`: remoção completa

### Forced hedge quando LP sai abaixo do range

Simétrico ao forced close: quando o range fica abaixo do preço atual (LP 100% em token volátil), o hedge é imediatamente aumentado ao target (`hedgeRatio × exposição`), bypassando cooldown e limites de rate.

- `src/engine/rebalancer.ts`: nova ramificação `below-range` em `checkForcedRebalance()`
