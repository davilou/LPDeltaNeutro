# CLAUDE.md — APRDeltaNeuto

## Projeto
Bot de hedging delta-neutro para posições de liquidez concentrada em múltiplas blockchains (Base, Ethereum, BSC, Arbitrum, Polygon, Avalanche, HyperEVM). Lê LP positions on-chain (Uniswap V3/V4, PancakeSwap V3/V4, Aerodrome CL e outros) e executa hedges em perpétuos na Hyperliquid. Inclui dashboard de monitoramento e módulo de backtesting.

## Stack
- **Runtime**: Node.js + TypeScript (strict, ES2022, CommonJS)
- **Blockchain**: Base, ETH, BSC, Arbitrum, Polygon, Avalanche · ethers.js v6
- **DEXes**: Uniswap V3/V4, PancakeSwap V3/V4, Aerodrome CL (V3-compat)
- **Exchange**: Hyperliquid SDK v1.7.7 (perpétuos — hedge para todas as chains)
- **Server**: Express v5 (dashboard)
- **Logging**: Winston + daily rotation
- **Package manager**: npm
- **Build**: tsc → `dist/` | Dev: ts-node

## Arquitetura
```
src/
├── index.ts          # Entry point, loop principal, UserEngineContext map (multi-user)
├── config.ts         # Env vars
├── types.ts          # Interfaces globais (LPPosition, HedgeState, BotState, PnlState)
├── auth/             # Google OAuth, sessões, AES-256-GCM encrypt/decrypt de credenciais HL
│   ├── types.ts      # AuthUser, express-session augmentation
│   ├── encrypt.ts    # encrypt/decrypt (Node crypto)
│   ├── userStore.ts  # CRUD Supabase (findOrCreate, loadCredentials, saveCredentials)
│   ├── passport.ts   # Google Strategy + serialize/deserialize
│   └── middleware.ts # requireAuth (protege rotas /api/)
├── lp/               # Leitura on-chain — multi-chain, multi-DEX
│   ├── types.ts               # ILPReader, IWalletScanner, ChainId, DexId, PositionId
│   ├── chainRegistry.ts       # Endereços de contrato por (ChainId, DexId)
│   ├── chainProviders.ts      # FallbackProvider pool por chain (lazy singleton)
│   ├── tokenCache.ts          # Cache global de symbol/decimals por chain
│   ├── lpReaderFactory.ts     # createLPReader(chain, dex) → ILPReader
│   ├── walletScannerFactory.ts # createWalletScanner(chain, dex) → IWalletScanner
│   ├── readers/
│   │   ├── evmClReader.ts     # Base class V3-compat (Uniswap V3, PancakeSwap V3, Aerodrome CL)
│   │   ├── evmV4Reader.ts     # Base class V4-compat
│   │   └── solanaReader.ts    # Stub Phase 2
│   ├── scanners/
│   │   ├── evmScanner.ts      # IWalletScanner parametrizado por chain/dex
│   │   └── solanaScanner.ts   # Stub Phase 2
│   ├── uniswapReader.ts       # Re-exports backwards-compat
│   └── walletScanner.ts       # Re-exports backwards-compat
├── hedge/            # Cálculo de hedge + execução (Hyperliquid / Mock)
│   ├── types.ts      # IHedgeExchange, FillResult, HlIsolatedPnl
│   ├── hyperliquidExchange.ts
│   └── mockExchange.ts
├── engine/           # Orquestração (rebalancer)
├── pnl/              # Rastreamento de P&L (dados reais da HL API)
├── backtest/         # Simulação histórica com estratégias
├── db/               # Persistência Supabase (rebalances, closed_positions, protection_activations)
├── dashboard/        # Express server + store de estado
│   └── public/
│       ├── index.html   # Dashboard principal (MONITOR, HISTORY, CALCULATOR, SETTINGS)
│       └── login.html   # Página de login Google
└── utils/            # logger, fallbackProvider, safety, multicall
```

**Padrão**: feature-based, separação clara lp → engine → hedge. Factory pattern para Mock vs. Live exchange (dry-run) e para readers/scanners por chain/dex. Strategy pattern no backtest. Multi-user via `UserEngineContext` map em `index.ts`.

## Padrões de Código
- TypeScript strict sempre. Sem `any` explícito.
- Importações com caminho relativo explícito (`./`, `../`).
- Interfaces em `types.ts` global ou `types.ts` local do módulo.
- Funções assíncronas com `async/await`. Sem `.then()` encadeado.
- Erros com `try/catch` e log via Winston (`logger.error`).
- BigInt para valores on-chain (ethers v6). Nunca `Number()` em valores de token.
- Constantes de configuração via `config.ts`, nunca hardcoded.

## Regras de Estilo
- camelCase para variáveis/funções, PascalCase para interfaces/classes.
- Sem comentários óbvios. Comentar apenas lógica de domínio complexa (ex: cálculo de tick, delta).
- Imports organizados: Node built-ins → third-party → internos.
- Sem console.log. Sempre `logger.*`.

## O que Evitar
- Não usar ethers v5 API (`.BigNumber`, `.utils.*` depreciados).
- Não fazer chamadas RPC sem o `fallbackProvider`.
- Não expor chaves privadas ou seeds em logs.
- Não modificar estado global fora do `store.ts` (dashboard).
- Não adicionar dependências sem necessidade clara.
- Não criar testes unitários — usar backtesting do módulo `src/backtest/`.

## Boas Práticas do Projeto
- Checar `dryRun` antes de qualquer execução real na Hyperliquid.
- Usar `safety.ts` para validações de sanidade antes de ordens.
- Toda iteração do bot passa pelo `rebalancer.ts` — não executar hedge direto do `index.ts`.
- RPC: sempre via `fallbackProvider` (multi-RPC com fallback automático).
- Configurações de estratégia (thresholds, bands) vêm do `.env` via `config.ts`.

## Gatilhos de Rebalance
O sistema usa os seguintes gatilhos (sem delta mismatch percentual):
1. **Timer/Cooldown** — `REBALANCE_INTERVAL_MIN` serve como intervalo periódico **e** como cooldown mínimo entre rebalances. Default: 720 min (12h).
2. **Emergency** — `|preço atual − lastRebalancePrice| / lastRebalancePrice > EMERGENCY_PRICE_MOVEMENT_THRESHOLD`, bypassa cooldown. Default: 15%.
3. **Forced close** — LP acima do range (100% stablecoin), fecha hedge imediatamente independente de cooldown.
4. **Forced hedge** — LP abaixo do range (100% token volátil), aumenta hedge ao target imediatamente independente de cooldown.

`lastRebalancePrice` é persistido em `state.json` e atualizado a cada rebalance executado. Se for `0` (posição nova ou migrada), o gatilho emergency não dispara — aguarda timer ou forced.

Variáveis relevantes: `REBALANCE_INTERVAL_MIN` (default 720), `EMERGENCY_PRICE_MOVEMENT_THRESHOLD` (default 0.15).

Cooldown por posição pode ser sobrescrito via dashboard (campo **Cooldown (m)**) — persiste em `ActivePositionConfig.cooldownSeconds`.

## PnL Tracking
PnL é calculado com dados **reais da HL API**, filtrados por coin e por `initialTimestamp` da posição. Não há virtual accounting local.

**Fluxo por ciclo:**
```
getPosition(sym)           → HedgeState (inclui unrealizedPnlUsd da clearinghouse)
getIsolatedPnl(sym, ts)    → { realizedPnlUsd, cumulativeFundingUsd, cumulativeFeesUsd }
hlPnl = { unrealizedPnlUsd: currentHedge.unrealizedPnlUsd, ...apiResult }
pnlTracker.compute(lpUsd, hlEquity, lpFees, hlPnl)  → PnlSnapshot
```

**Endpoints HL:**
- `getUserFillsByTime(wallet, sinceTs)` → `closedPnl` + `fee` por fill
- `getUserFunding(wallet, sinceTs)` → `usdc` por período de funding
- `getClearinghouseState` → `unrealizedPnl` por coin (já chamado em `getPosition()`)

**`PnlState`** (persistida em `state.json`) contém apenas: `initialLpUsd`, `initialHlUsd`, `initialLpFeesUsd`, `initialTimestamp`. O `initialTimestamp` é o parâmetro `sinceTs` usado nos endpoints acima — isola os dados àquela proteção específica.

**Em dry-run** (`MockExchange`): `getIsolatedPnl()` retorna zeros — nenhuma chamada à HL é feita.

## Auth (Multi-tenancy)
O dashboard requer login via **Google OAuth**. Cada conta Google tem espaço isolado.

- Estado por usuário: `state-{userId}.json` + registros Supabase filtrados por `user_id`
- Credenciais HL armazenadas criptografadas na tabela `users` (AES-256-GCM, chave em `CREDENTIAL_ENCRYPTION_KEY`)
- `requireAuth` middleware protege todas as rotas `/api/`
- `getOrCreateEngineContext(userId)` retorna ou cria um engine context isolado por usuário
- `getStoreForUser(userId)` retorna o DashboardStore isolado por usuário

## Dashboard
O dashboard (`src/dashboard/`) é um servidor Express com SSE para atualizações em tempo real. Páginas: MONITOR, HISTORY, CALCULATOR, SETTINGS.

- **Multi-posição**: cada posição ativa tem seu próprio bloco de cards gerado dinamicamente (`positionMetricsHtml(tokenId, cfg)` → `renderAllMetrics()`). IDs dos elementos são prefixados por `${tokenId}-`.
- **Lookup por token ID**: `POST /api/lookup-position` permite buscar qualquer NFT sem precisar do endereço da carteira.
- **P&L Isolado**: exibe LP P&L, LP Fees, Unrealized, Realized, Funding e HL Fees — todos com dados reais da HL API.
- **Strategy Config**: cada card de posição tem seus próprios inputs de configuração e botões de ação (UPDATE STRATEGY, RESET P&L BASE, DEACTIVATE PROTECTION) — funções globais `updatePositionConfig(tokenId)`, `deactivatePosition(tokenId)`, `resetPositionPnl(tokenId)`.
- **Hedge Calculator** (aba CALCULATOR): simulador client-side de cenários LP + hedge. Inputs: Pool Value, Current Price, Range Min/Max (USD ou % do preço), Hedge Size (% da exposição volátil), APR. Tabela de 9 linhas ordenada de +15% a −15% com range boundaries inseridos dinamicamente. Toggle `MANUAL | AUTO` no campo Hedge Size: modo AUTO calcula analiticamente o % que iguala P&L nos extremos do range (`H = (lpPnlUp − lpPnlDown) × P / (Pb − Pa)`); estado em `hedgeModeState` dentro do IIFE da calculadora.
- **HISTORY tab**: tabela de closed positions usa `HistoricalPosition` (inclui `priceLowerUsd?`/`priceUpperUsd?` calculados em `archivePosition()` via fórmula de tick). Posições ativas exibidas via `renderActivePositionsInHistory()`. `/api/rebalances?tokenId=N` retorna rebalances filtrados por NFT (Supabase ou in-memory).
- **`HistoricalPosition`** (`src/types.ts`): campos `priceLowerUsd?`/`priceUpperUsd?` — calculados em `archivePosition()` se `token0Decimals`/`token1Decimals`/`hedgeToken` estiverem no config. Fórmula: `raw = 1.0001^tick × 10^(dec0-dec1)`; invertido se `hedgeToken='token1'`.
- **`RebalanceEvent`** (`src/dashboard/store.ts`): campos `fundingUsd?`/`realizedPnlUsd?` — populados do `PnlSnapshot` do ciclo no momento do rebalance.
- **`fetchRebalances`** (`src/db/supabase.ts`): assinatura `(userId?, tokenId?, limit)` — filtra Supabase por ambos.

## Multi-Chain LP Layer

A camada LP usa o **Thin Adapter Pattern**: classes base parametrizadas por endereços de contrato, sem duplicação de lógica de tick/liquidez.

### Interfaces centrais (`src/lp/types.ts`)
```typescript
type ChainId    = 'base' | 'eth' | 'bsc' | 'arbitrum' | 'polygon' | 'avalanche' | 'hyperliquid-l1' | 'solana';
type DexId      = 'uniswap-v3' | 'uniswap-v4' | 'pancake-v3' | 'pancake-v4' | 'aerodrome-cl' | 'project-x';
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

### Factories (ponto de entrada)
- `createLPReader(chain, dex)` — roteamento: solana → SolanaReader (stub), V4 dexes → EvmV4Reader, demais → EvmClReader
- `createWalletScanner(chain, dex)` — roteamento: solana → SolanaScanner (stub), demais → EvmScanner

### Chain Registry (`src/lp/chainRegistry.ts`)
Mapa `ChainId:DexId` → `{ positionManagerV3, factoryV3, initCodeHash, positionManagerV4, poolManagerV4, stateViewV4 }`. Usar `getChainDexAddresses(chain, dex)` e `isChainDexSupported(chain, dex)` — nunca hardcodar endereços fora deste arquivo.

### RPC por chain
- `src/lp/chainProviders.ts` — `getChainProvider(chain)`: retorna `FallbackProvider` singleton por chain
- Cada chain lê sua lista de RPC URLs do `config` (ex: `config.ethHttpRpcUrls`, `config.bscHttpRpcUrls`)
- Nunca criar `JsonRpcProvider` diretamente — sempre via `getChainProvider()`

### Token cache (`src/lp/tokenCache.ts`)
- `getTokenCache(chain)` — `Map<address, TokenMeta>` compartilhado por todos os readers da mesma chain
- `seedTokenCache(chain, tokens)` — pré-popula tokens conhecidos (USDC, WETH, WBTC, etc.)
- Elimina chamadas duplicadas de `symbol()` e `decimals()` quando múltiplas posições compartilham tokens

### Multicall3 (`src/utils/multicall.ts`)
- Helper para batching de `eth_call`s via contrato `0xcA11bde05977b3631167028862bE2a173976CA11` (universal em todas as EVMs)
- Controlado por `config.multicall3Enabled` (default `true`)
- Atualmente scaffolded — não usado internamente ainda

### State migration
`rebalancer.loadState()` aplica defaults automaticamente para posições sem `chain`/`dex`:
```typescript
if (!pos.config.chain) pos.config.chain = 'base';
if (!pos.config.dex)   pos.config.dex = proto === 'v4' ? 'uniswap-v4' : 'uniswap-v3';
if (pos.config.positionId === undefined) pos.config.positionId = pos.config.tokenId;
```

### Phase 2 (Solana — stubs)
`SolanaReader` e `SolanaScanner` implementam as interfaces mas lançam `Error` com mensagem "Phase 2 not yet implemented". `ChainId` já inclui `'solana'`; `PositionId = string` para pubkeys Solana.

## Uniswap V4 — LP Fees
Fees V4 são lidas via contrato StateView (`0xa3c0c9b65bad0b08107aa264b0f3db444b867a71` na Base).

- `getPositionInfo(poolId, positionId)` — overload de 2 args (funciona com ETH nativo). `positionId = keccak256(encodePacked(pmAddress, tickLower, tickUpper, bytes32(tokenId)))`
- `getFeeGrowthInside(poolId, tickLower, tickUpper)` — retorna fee growth inside diretamente
- `fees = liquidity × (feeGrowthInside − feeGrowthInsideLast) >> 128`

## Comandos
```bash
npm run build          # compila TypeScript → dist/
npx tsc --noEmit       # type-check sem gerar arquivos
npx pm2 restart apr-delta-neuto  # reiniciar após build
npx pm2 logs apr-delta-neuto     # logs em tempo real
```

## Como adicionar nova Chain/DEX
1. `src/lp/chainRegistry.ts` — adicionar `'chain:dex': { positionManagerV3, factoryV3, ... }`
2. `src/lp/chainProviders.ts` — adicionar chain ID em `CHAIN_IDS` (obrigatório para staticNetwork) + entry em `getRpcUrls` e `getLpFreeRpcUrls`
3. `.env` — adicionar `CHAIN_HTTP_RPC_URL=url1,url2,...` e `LP_FREE_CHAIN_RPC_URL=url1,url2,...`
4. `src/dashboard/public/index.html` — adicionar dex em `DEX_OPTIONS_BY_CHAIN`
5. `src/utils/priceApi.ts` — adicionar chain em `DEX_SCREENER_CHAIN`, `COINGECKO_PLATFORM` e `WRAPPED_NATIVE`
6. `src/config.ts` — adicionar `lpFreeChainRpcUrls` getter

Sem `initCodeHashV3`? Pool resolvido via `factory.getPool()` — CREATE2 é fallback opcional.

## Ciclos de Execução

Três loops independentes rodam em paralelo:

### Ciclo LP+PnL (RPCs Gratuitos + HL API)
Roda a cada `LP_READ_INTERVAL_MIN` minutos (default 5), staggerado `LP_READ_INTER_USER_DELAY_MS` ms entre usuários.

Operações: `refreshFees()` + `readPosition()` via `getLpProvider()` → `getPosition()` + `getAccountEquity()` + `getIsolatedPnl()` via HL API → `pnlTracker.compute()` → atualiza dashboard completo (LP amounts, fees, range status, P&L, unrealized/realized).

Se `liquidity === 0n`: detecta posição fechada → dispara deactivation.

### Ciclo de Rebalance (Timer)
Roda a cada `CYCLE_INTERVAL_MIN` minutos (default 720 = 12h) via `setInterval`.

Operações: `readPosition()` + decisão de hedge via `rebalancer.cycle()`. Chama HL API para ajuste de posição perp se necessário.

### Price Poller (DexScreener)
Roda a cada 30s via DexScreener (sem RPC).

Detecta out-of-range (via tick) ou emergency price movement → dispara `rebalancer.cycle()` imediato, bypassando o timer de 12h.

### RPCs
- **LP reads**: sempre via `getLpProvider(chain)` → usa `LP_FREE_*_RPC_URL` se configurado para a chain, senão faz fallback para o provider principal daquela chain (ex: `HTTP_RPC_URL` para Base, `ETH_HTTP_RPC_URL` para ETH, etc.).
- **WebSocket**: removido. Alchemy permanece apenas como fallback HTTP RPC (configurado em `HTTP_RPC_URL`).
- Cada chain tem seu próprio pool de RPCs configurável via `*_HTTP_RPC_URL` e `LP_FREE_*_RPC_URL`.

## RPCs Públicos Gratuitos (LP_FREE_*_RPC_URL)

A plataforma é multichain. Configurar RPCs gratuitos para cada chain ativa reduz dependência do provider principal (Alchemy ou similar) e aumenta resiliência.

```env
# Base
LP_FREE_BASE_RPC_URL=https://base.publicnode.com,https://base.drpc.org,https://1rpc.io/base

# Ethereum
LP_FREE_ETH_RPC_URL=https://eth.publicnode.com,https://ethereum.drpc.org,https://1rpc.io/eth

# BNB Chain
LP_FREE_BSC_RPC_URL=https://bsc.publicnode.com,https://bsc.drpc.org,https://1rpc.io/bnb

# Arbitrum
LP_FREE_ARB_RPC_URL=https://arbitrum.publicnode.com,https://arbitrum.drpc.org,https://1rpc.io/arb

# Polygon
LP_FREE_POLYGON_RPC_URL=https://polygon.publicnode.com,https://polygon.drpc.org,https://1rpc.io/matic

# Avalanche C-Chain
LP_FREE_AVAX_RPC_URL=https://avalanche.publicnode.com/ext/bc/C/rpc,https://avalanche.drpc.org

# HyperEVM (Hyperliquid L1)
LP_FREE_HL_L1_RPC_URL=https://rpc.hyperliquid.xyz/evm
```

Provedores de referência (sem API key):
- **PublicNode** — `*.publicnode.com` — alta disponibilidade, sem rate limit agressivo
- **DRPC** — `*.drpc.org` — suporte amplo de chains
- **1RPC** — `1rpc.io/*` — privacy-focused, sem logs

## Gotchas
- **ethers v6 staticNetwork**: sempre passar `chainId` ao `new FallbackProvider(urls, chainId)`. Sem isso: spam "JsonRpcProvider failed to detect network; retry in 1s" em RPCs lentos. Chain IDs ficam em `CHAIN_IDS` em `src/lp/chainProviders.ts`.
- **Circular import em `lp/types.ts`**: usar `import type { LPPosition }` (não value import). Value import cria circular CommonJS require em runtime. Nunca mudar para import de valor.
- **Supabase `rebalances` table**: requer colunas `pnl_realized_usd NUMERIC` e `pnl_funding_usd NUMERIC` (adicionadas em 2026-03-09). Sem elas, `fetchRebalances()` retorna zeros nesses campos.
- **`DiscoveredPosition` em `src/types.ts`**: definida localmente em `src/types.ts` (não em `src/lp/types.ts`). Não requer import adicional em módulos que já importam de `../types`.
- **Dashboard nav sidebar**: usa `<div class="sidebar-item" onclick="showPage('page')">` — não `<li><button>`. `showPage()` mantém um array de nomes de páginas para show/hide; adicionar nova aba requer incluir o nome no array.
- **`setHedgeMode` reservado pela CALCULATOR**: a aba CALCULATOR usa `window.setHedgeMode(mode, el)` em seu próprio IIFE. Novas abas que precisam de toggle AUTO/MANUAL devem usar nome diferente (ex: `setScannerHedgeMode`).
- **Scanner tab estado isolado**: `scannerPositions`, `protectModalData`, `calcAutoHedge()` pertencem exclusivamente ao Scanner — nunca compartilhar com código do Monitor. Scanner usa IDs prefixados `scanner-*`. `DEX_LABELS` é compartilhado (usado em Scanner e no header de métricas de posições ativas); `DEX_OPTIONS_BY_CHAIN` pertence apenas ao Scanner.
- **`dryRun` é flag global**: `/api/activate-position` não aceita `dryRun` por posição — é controlado pelo `.env` (`DRY_RUN=true`). Não expor como opção por posição no UI.
- **`DashboardStore` é apenas memória**: não persiste em disco. Persistência de dados do usuário é feita via `rebalancer.saveState()` → `state-{userId}.json`. Dados que precisam sobreviver a page reload devem ser salvos via Rebalancer.
- **`DashboardCallbacks` é a interface server↔index**: `server.ts` acessa engine contexts via `callbacks.getEngineContext(userId)`, não via import direto de `index.ts`. Ao adicionar novos acessos ao Rebalancer em `server.ts`, adicionar o método ao `DashboardCallbacks` e implementar em `index.ts`.
- **V4 `info bytes32` tick offset**: bits 0-7 = `hasSubscriber` flag. tickLower em bits 8-31 (`>> 8n`), tickUpper em bits 32-55 (`>> 32n`). `evmV4Reader.ts` é a referência correta — sempre sincronizar com ele ao ler ticks em `evmScanner.ts`.
- **`DiscoveredPosition` não tem `priceLowerUsd`/`priceUpperUsd`**: esses campos só existem em `HistoricalPosition`. Range bounds do scanner devem ser calculados dos ticks: `raw = 1.0001^tick * 10^(dec0-dec1)`.
- **Concurrency guards em `UserEngineContext`**: `setupUserEventHandlers` é definida fora de `main()` e não acessa variáveis locais dela. Guards de concorrência (ex: `cycleInProgress`) devem estar no `UserEngineContext`, nunca como `Set`/variável local de `main()`.
- **Modais async com fetch**: desabilitar o botão de submit (`disabled = true`) antes do `await fetch(...)` e re-habilitar após — senão o usuário submete com `input.value = ''` → `parseFloat('') = NaN` → JSON envia `null` → servidor usa default.

## Limitações conhecidas (multi-chain)
- `EvmScanner.scanV3()` usa Multicall3 — ≤5 RPC round trips independente do número de NFTs
- `EvmScanner.scanV4()` usa eventos ERC721 Transfer no PositionManager + Multicall3 (3 rounds: logs → liquidity+ownerOf+poolInfo → tokenInfo+slot0)
- `V4_DEPLOY_BLOCKS` em `evmScanner.ts` define o bloco inicial de scan por chain — atualizar se novos contratos V4 forem adicionados
- `EvmScanner.scanV3()` só escaneia V3 (ERC721Enumerable) — compatível com NonfungiblePositionManager V3-compat
- `walletScannerFactory` não valida `isChainDexSupported` antes de construir `EvmScanner`

## Price API (`src/utils/priceApi.ts`)
Busca preço externo por pool (DexScreener + CoinGecko fallback), com suporte multi-chain.

- **Endpoint correto**: `/latest/dex/pairs/{chain}/{address}` (não `/pools/`)
- **V4 pool IDs** são hashes de 32 bytes (66 chars) — DexScreener não os indexa; skip direto para fallback por token
- **DexScreener slugs**: base→`base`, eth→`ethereum`, bsc→`bsc`, arbitrum→`arbitrum`, polygon→`polygon`, avalanche→`avalanche`, hyperliquid-l1→`hyperevm`
- **Rate limit DexScreener**: 300 req/min para `/pairs/` e `/tokens/`
- `fetchPoolPrice()` retorna ratio Uniswap (token1/token0) — para USD do hedge token: `hedgeToken='token0'` e token1 stable → USD = price; `hedgeToken='token1'` e token0 stable → USD = 1/price
- `isChainPriceSupported(chain)` — checar antes de fetch (evita requests para chains não mapeadas)
- Price poller agrupa por `chain:poolAddress` — 1 fetch por pool única, independente de quantos tokenIds compartilham

## Auto-restore de Engine Contexts
`autoRestoreEngineContexts()` em `index.ts` — chamada no startup (modo multi-user apenas).
Escaneia `state-{userId}.json` no root, cria contexto para cada usuário com posições ativas.
**Falha explícita** (log error + skip) se Supabase não configurado ou credenciais ausentes — nunca cai para MockExchange.
Posições são monitoradas e rebalanceadas independente de login ativo no dashboard.

## Reader Lifecycle
`UserEngineContext.readers` é um `Map<"chain:dex", ILPReader>` — usar `getOrCreateReader(ctx, chain, dex)` para obter ou criar readers.
Nunca chamar `createLPReader()` diretamente no loop de ciclo — destrói o cache TTL interno do reader.

## Diretrizes para Respostas
- Responder diretamente com código quando a solicitação for clara.
- Sem explicações longas. Contexto mínimo necessário.
- Ao modificar arquivos existentes, mostrar apenas o diff relevante.
- Priorizar soluções que usem as libs já instaladas.
- Não sugerir refatorações não solicitadas.
- Ao adicionar features, seguir o padrão modular existente (novo diretório em `src/` se for domínio novo).
