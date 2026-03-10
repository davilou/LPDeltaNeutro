# Simplify Cycles — Remove WebSocket Trigger, Add HL PnL to LP Cycle

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remover o WebSocket/block-mode como trigger de ciclo, mover chamadas HL API para o ciclo LP de 5min (P&L em tempo real), e deixar Alchemy apenas como fallback HTTP RPC em todas as chains.

**Architecture:** O bot passa a ter dois ciclos: (1) LP+PnL a cada 5min via RPCs gratuitos + HL API, atualiza dashboard completo; (2) Rebalance via timer (default 720min) + price poller (30s) para decisões de hedge. WebSocket e block-mode removidos. EvmV4Reader migrado para getLpProvider().

**Tech Stack:** Node.js + TypeScript strict + ethers.js v6 + Hyperliquid SDK

---

### Task 1: EvmV4Reader — usar getLpProvider() em vez de getChainProvider()

**Files:**
- Modify: `src/lp/readers/evmV4Reader.ts`

**Step 1: Trocar import e uso de provider**

Em `src/lp/readers/evmV4Reader.ts`, linha 7:
```typescript
// ANTES:
import { getChainProvider } from '../chainProviders';

// DEPOIS:
import { getLpProvider } from '../chainProviders';
```

Linha 63 (dentro de `readPosition`):
```typescript
// ANTES:
const fallback = getChainProvider(this.chain);

// DEPOIS:
const fallback = getLpProvider(this.chain);
```

Linha 198 (dentro de `getBlockOrSlot`):
```typescript
// ANTES:
return getChainProvider(this.chain).call(p => p.getBlockNumber());

// DEPOIS:
return getLpProvider(this.chain).call(p => p.getBlockNumber());
```

**Step 2: Verificar build**

```bash
npx tsc --noEmit
```
Expected: zero erros.

**Step 3: Commit**

```bash
git add src/lp/readers/evmV4Reader.ts
git commit -m "fix(lp): EvmV4Reader usa getLpProvider() — sem Alchemy para leituras V4"
```

---

### Task 2: config.ts — remover blockThrottle e cycleMode

**Files:**
- Modify: `src/config.ts`

**Step 1: Remover os dois campos**

Remover as linhas:
```typescript
blockThrottle: numEnv('BLOCK_THROTTLE', 10),
/** 'block' = dispara ciclo a cada blockThrottle blocos | 'timer' = dispara a cada cycleIntervalMin minutos */
cycleMode: optionalEnv('CYCLE_MODE', 'block') as 'block' | 'timer',
```

**Step 2: Verificar build**

```bash
npx tsc --noEmit
```
Expected: erros de "Property 'blockThrottle' does not exist" e "Property 'cycleMode' does not exist" — são exatamente os usos a remover na Task 3.

**Step 3: Commit parcial não aplicável** — continuar para Task 3 antes de commitar.

---

### Task 3: index.ts — remover WebSocket, block-mode e watchdog

**Files:**
- Modify: `src/index.ts`

**Step 1: Remover constantes de topo que não são mais usadas**

Remover as linhas:
```typescript
const BLOCK_TIMEOUT_MS = 5 * 60_000;    // 5min
const WATCHDOG_INTERVAL_MS = 15_000;   // 15s
```

**Step 2: Remover variáveis de estado de bloco**

No início de `main()`, remover:
```typescript
let blockCount = 0;
let lastBlockTime = Date.now();
let activeWs: ethers.WebSocketProvider | null = null;
```

**Step 3: Remover a função connectWebSocket() inteira**

Remover o bloco completo de `let wsReconnectDelay = 5_000;` até o fechamento de `connectWebSocket()` (linhas 656–724).

**Step 4: Remover o watchdog inteiro**

Remover o bloco completo:
```typescript
// Watchdog & Polling Fallback
let lastPolledBlock = 0;
const reader0 = createLPReader('base', 'uniswap-v3'); // shared reader for block polling only
const watchdog = setInterval(async () => {
  ...
}, WATCHDOG_INTERVAL_MS);
```

**Step 5: Remover import de ethers (se não usado em mais nada)**

Verificar se `ethers` ainda é usado em outro lugar no arquivo. Se não, remover:
```typescript
import { ethers } from 'ethers';
```

**Step 6: Substituir bloco final de setup de ciclos**

Substituir:
```typescript
connectWebSocket();

if (config.cycleMode === 'timer') {
  const intervalMs = config.cycleIntervalMin * 60_000;
  logger.info(`[Cycle] Timer mode: heavy cycle every ${config.cycleIntervalMin}min (price poller handles out-of-range + emergency)`);
  setInterval(runCycleForAllUsers, intervalMs);
} else {
  logger.info(`[Cycle] Block mode: heavy cycle every ${config.blockThrottle} blocks`);
}
```

Por:
```typescript
const rebalanceIntervalMs = config.cycleIntervalMin * 60_000;
logger.info(`[Cycle] Rebalance cycle every ${config.cycleIntervalMin}min (price poller handles out-of-range + emergency)`);
setInterval(runCycleForAllUsers, rebalanceIntervalMs);
```

**Step 7: Verificar build**

```bash
npx tsc --noEmit
```
Expected: zero erros.

**Step 8: Commit**

```bash
git add src/config.ts src/index.ts
git commit -m "refactor(cycle): remove WebSocket/block-mode — rebalance via timer + price poller apenas"
```

---

### Task 4: index.ts — adicionar HL PnL ao ciclo LP

**Files:**
- Modify: `src/index.ts`

**Step 1: Verificar imports necessários**

No topo de `index.ts`, confirmar que já existem:
```typescript
import { IHedgeExchange, HlIsolatedPnl } from './hedge/types';
```
Se não existir `HlIsolatedPnl`, adicioná-lo ao import existente de `./hedge/types`.

**Step 2: Adicionar detecção de liquidity=0 no início de runLpReadForToken**

Logo após a linha `const position = await reader.readPosition(tokenId, cfg.poolAddress);`, adicionar:

```typescript
if (position.liquidity === 0n) {
  logger.warn(`[LpRead] NFT #${tokenId} liquidity is 0 — LP position closed. Auto-deactivating...`);
  reader.invalidateCache(tokenId);
  if (!ctx.deactivationsInProgress.has(tokenId)) {
    store.requestDeactivation(tokenId);
  }
  return;
}
```

**Step 3: Expandir store.update com chamadas HL API**

Substituir o bloco `store.update({...})` atual + `logger.info` ao final de `runLpReadForToken` por:

```typescript
const totalLpUsd = token0Usd + token1Usd;

if (cfg.hedgeSymbol) {
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

  logger.info(
    `[LpRead] NFT #${tokenId} lp=$${totalLpUsd.toFixed(2)} fees=$${netLpFees.toFixed(4)} ` +
    `unrealized=$${pnl.unrealizedVirtualPnlUsd.toFixed(2)} realized=$${pnl.realizedVirtualPnlUsd.toFixed(2)}`
  );
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

  logger.info(`[LpRead] NFT #${tokenId} lp=$${totalLpUsd.toFixed(2)} fees=$${netLpFees.toFixed(4)}`);
}
```

**Step 4: Renomear variável intermediária**

A variável `token0Usd + token1Usd` era usada diretamente no `store.update`. Agora está em `totalLpUsd`. Verificar que não há mais referência solta a `token0Usd + token1Usd` no body da função.

**Step 5: Verificar build**

```bash
npx tsc --noEmit
```
Expected: zero erros.

**Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat(lp-cycle): adicionar HL PnL (getPosition + equity + isolatedPnl) ao ciclo LP de 5min"
```

---

### Task 5: Atualizar CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Atualizar seção "Ciclos de Execução"**

Substituir a seção inteira `## Ciclos de Execução` por:

```markdown
## Ciclos de Execução

Três loops independentes rodam em paralelo:

### Ciclo LP+PnL (RPCs Gratuitos + HL API)
Roda a cada `LP_READ_INTERVAL_MIN` minutos (default 5), staggerado `LP_READ_INTER_USER_DELAY_MS` ms entre usuários.

Operações: `refreshFees()` + `readPosition()` via `getLpProvider()` → `getPosition()` + `getAccountEquity()` + `getIsolatedPnl()` via HL API → `pnlTracker.compute()` → atualiza dashboard completo (LP amounts, fees, range status, P&L, unrealized/realized).

Se `liquidity === 0n`: detecta posição fechada → dispara deactivation.

### Ciclo de Rebalance (Timer)
Roda a cada `CYCLE_INTERVAL_MIN` minutos (default 720 = 12h).

Operações: `readPosition()` + decisão de hedge via `rebalancer.cycle()`. Chama HL API para ajuste de posição perp se necessário.

### Price Poller (DexScreener)
Roda a cada 30s via DexScreener (sem RPC).

Detecta out-of-range (via tick) ou emergency price movement → dispara `rebalancer.cycle()` imediato, bypassando o timer de 12h.

### RPCs
- **LP reads**: sempre via `getLpProvider(chain)` → usa `LP_FREE_*_RPC_URL` se configurado, senão faz fallback para o provider principal da chain (ex: Alchemy para Base, outros para demais chains).
- **WebSocket**: removido. Alchemy permanece apenas como fallback HTTP RPC.
- Cada chain tem seu próprio pool de RPCs configurável.
```

**Step 2: Atualizar seção "Projeto" para reforçar multichain**

Substituir a primeira linha da seção `## Projeto`:
```markdown
Bot de hedging delta-neutro para posições de liquidez concentrada em múltiplas blockchains (Base, Ethereum, BSC, Arbitrum, Polygon, Avalanche, HyperEVM). Lê LP positions on-chain (Uniswap V3/V4, PancakeSwap V3/V4, Aerodrome CL e outros) e executa hedges em perpétuos na Hyperliquid. Inclui dashboard de monitoramento e módulo de backtesting.
```

**Step 3: Remover variáveis obsoletas de "Gatilhos de Rebalance"**

A seção `## Gatilhos de Rebalance` menciona `CYCLE_MODE` e `BLOCK_THROTTLE` — remover essas referências, manter apenas as variáveis ainda válidas:
- `REBALANCE_INTERVAL_MIN` → renomeado conceitualmente para `CYCLE_INTERVAL_MIN` no código
- `EMERGENCY_PRICE_MOVEMENT_THRESHOLD`
- `LP_READ_INTERVAL_MIN`

**Step 4: Atualizar seção "Comandos"**

Verificar se há menção a `CYCLE_MODE=block` ou `BLOCK_THROTTLE` e remover.

**Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: atualizar CLAUDE.md — multichain explícito, ciclos simplificados, remover WebSocket/block-mode"
```

---

### Task 6: Verificação final

**Step 1: Build limpo**

```bash
npm run build
```
Expected: compilação sem erros em `dist/`.

**Step 2: Verificar .env.example**

Abrir `.env.example` e remover as variáveis obsoletas se presentes:
- `CYCLE_MODE`
- `BLOCK_THROTTLE`
- `ALCHEMY_WS_URL` (agora sem uso ativo — pode manter como comentário informando que foi descontinuado)

**Step 3: Commit final**

```bash
git add .env.example
git commit -m "chore: remover CYCLE_MODE e BLOCK_THROTTLE do .env.example"
```
