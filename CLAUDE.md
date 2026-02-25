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
├── index.ts          # Entry point, loop principal
├── config.ts         # Env vars
├── types.ts          # Interfaces globais (LPPosition, HedgeState, BotState, PnlState)
├── lp/               # Leitura on-chain (Uniswap V3)
├── hedge/            # Cálculo de hedge + execução (Hyperliquid / Mock)
├── engine/           # Orquestração (rebalancer)
├── pnl/              # Rastreamento de P&L
├── backtest/         # Simulação histórica com estratégias
├── dashboard/        # Express server + store de estado
└── utils/            # logger, fallbackProvider, safety
```

**Padrão**: feature-based, separação clara lp → engine → hedge. Factory pattern para Mock vs. Live exchange (dry-run). Strategy pattern no backtest.

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
O sistema usa **dois gatilhos** para acionar rebalances (sem delta mismatch percentual):
1. **Price movement** — `|preço atual − lastRebalancePrice| / lastRebalancePrice > PRICE_MOVEMENT_THRESHOLD`
2. **Timer** — intervalo fixo via `TIME_REBALANCE_INTERVAL_MIN`
3. **Emergency** — mesmo critério do price movement com `EMERGENCY_PRICE_MOVEMENT_THRESHOLD`, bypassa cooldown
4. **Forced close** — LP saiu do range, fecha hedge independente de outros gatilhos

`lastRebalancePrice` é persistido em `state.json` e atualizado a cada rebalance executado. Se for `0` (posição nova ou migrada), os gatilhos de preço não disparam — aguarda timer ou forced close.

Variáveis relevantes: `PRICE_MOVEMENT_THRESHOLD` (default 5%), `EMERGENCY_PRICE_MOVEMENT_THRESHOLD` (default 15%), `COOLDOWN_SECONDS`, `TIME_REBALANCE_INTERVAL_MIN`.

## Diretrizes para Respostas
- Responder diretamente com código quando a solicitação for clara.
- Sem explicações longas. Contexto mínimo necessário.
- Ao modificar arquivos existentes, mostrar apenas o diff relevante.
- Priorizar soluções que usem as libs já instaladas.
- Não sugerir refatorações não solicitadas.
- Ao adicionar features, seguir o padrão modular existente (novo diretório em `src/` se for domínio novo).
