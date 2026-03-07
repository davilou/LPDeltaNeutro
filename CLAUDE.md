# CLAUDE.md — APRDeltaNeuto

## Projeto
Bot de hedging delta-neutro para posições de liquidez concentrada em múltiplas blockchains EVM. Lê LP positions on-chain (Uniswap V3/V4, PancakeSwap V3/V4, Aerodrome CL, e outros) e executa hedges em perpétuos na Hyperliquid. Inclui dashboard de monitoramento e módulo de backtesting.

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

## Diretrizes para Respostas
- Responder diretamente com código quando a solicitação for clara.
- Sem explicações longas. Contexto mínimo necessário.
- Ao modificar arquivos existentes, mostrar apenas o diff relevante.
- Priorizar soluções que usem as libs já instaladas.
- Não sugerir refatorações não solicitadas.
- Ao adicionar features, seguir o padrão modular existente (novo diretório em `src/` se for domínio novo).
