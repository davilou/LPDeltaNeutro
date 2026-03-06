# CLAUDE.md — APRDeltaNeuto

## Projeto
Bot de hedging delta-neutro para posições Uniswap V3/V4 na Base Chain. Lê LP positions on-chain e executa hedges em perpétuos na Hyperliquid, disparado por movimento de preço do ativo volátil. Inclui dashboard de monitoramento e módulo de backtesting.

## Stack
- **Runtime**: Node.js + TypeScript (strict, ES2022, CommonJS)
- **Blockchain**: Base Chain · ethers.js v6 · Uniswap V3 (NonfungiblePositionManager)
- **Exchange**: Hyperliquid SDK v1.7.7 (perpétuos)
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
├── lp/               # Leitura on-chain (Uniswap V3 + V4)
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
└── utils/            # logger, fallbackProvider, safety
```

**Padrão**: feature-based, separação clara lp → engine → hedge. Factory pattern para Mock vs. Live exchange (dry-run). Strategy pattern no backtest. Multi-user via `UserEngineContext` map em `index.ts`.

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
