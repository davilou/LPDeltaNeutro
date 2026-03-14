# Pool APR Card Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar card "POOL APR" no MONITOR do dashboard exibindo APR all-time, 7d, 24h e fees diárias em USD, calculados a partir de snapshots reais de fees on-chain com rolling window persistido.

**Architecture:** Novo módulo puro `src/engine/feeHistory.ts` com tipos e funções `pushSnapshot`/`computeApr`. Snapshots são armazenados em `PositionState.feeHistory` e persistidos em `state.json`. Chamados no ciclo LP em `index.ts` a cada `~5min`. Card renderizado dinamicamente em `positionMetricsHtml()`.

**Tech Stack:** TypeScript strict, Node.js, Express SSE, HTML/JS vanilla (dashboard)

**Spec:** `docs/superpowers/specs/2026-03-14-pool-apr-card-design.md`

---

## Chunk 1: Backend — Módulo feeHistory + tipos

### Task 1: Criar `src/engine/feeHistory.ts`

**Files:**
- Create: `src/engine/feeHistory.ts`

- [ ] **Step 1: Criar o arquivo com tipos e função `pushSnapshot`**

```typescript
// src/engine/feeHistory.ts

export interface FeeSnapshot {
  ts: number;       // unix timestamp em segundos
  feesUsd: number;  // fees brutas acumuladas on-chain neste momento
}

export interface HourlyFeeBucket {
  ts: number;            // início da hora (unix timestamp, segundos)
  deltaFeesUsd: number;  // fees geradas durante essa hora
}

export interface FeeHistory {
  snapshots: FeeSnapshot[];    // últimas 24h, granularidade por ciclo
  buckets: HourlyFeeBucket[];  // janela 24h–7d, agregados por hora
}

export interface AprMetrics {
  aprAllTime: number | null;
  apr7d: number | null;
  apr24h: number | null;
  dailyFeesUsd: number | null;
}

const WINDOW_24H = 86400;
const WINDOW_7D  = 604800;

/**
 * Adiciona snapshot de fees e mantém o rolling window:
 * - Últimas 24h: granularidade por ciclo (~5 min)
 * - 24h–7d: agregados em buckets horários
 * - Descarta dados com mais de 7 dias
 *
 * Regra de agregação sem sobreposição: uma hora só é agregada em bucket
 * quando TODOS os seus snapshots saíram da janela de 24h (hora inteira expirou).
 */
export function pushSnapshot(history: FeeHistory, feesUsd: number, nowTs?: number): FeeHistory {
  const now = nowTs ?? Math.floor(Date.now() / 1000);
  const cutoff24h = now - WINDOW_24H;
  const cutoff7d  = now - WINDOW_7D;

  // Adiciona snapshot atual
  const newSnapshots: FeeSnapshot[] = [...history.snapshots, { ts: now, feesUsd }];

  // Separa snapshots expirados (mais de 24h)
  const freshSnapshots = newSnapshots.filter(s => s.ts > cutoff24h);
  const expiredSnapshots = newSnapshots.filter(s => s.ts <= cutoff24h);

  // Agrupa expirados por hora
  const byHour = new Map<number, FeeSnapshot[]>();
  for (const s of expiredSnapshots) {
    const hourTs = Math.floor(s.ts / 3600) * 3600;
    if (!byHour.has(hourTs)) byHour.set(hourTs, []);
    byHour.get(hourTs)!.push(s);
  }

  // Agrega em buckets somente horas completamente fora da janela de 24h
  // (todas as horas cujo horário de início + 3600s < cutoff24h)
  const newBuckets: HourlyFeeBucket[] = [...history.buckets];
  for (const [hourTs, snaps] of byHour.entries()) {
    const hourEnd = hourTs + 3600;
    if (hourEnd > cutoff24h) continue; // hora ainda tem snapshots dentro da janela — aguarda
    const sorted = snaps.slice().sort((a, b) => a.ts - b.ts);
    const delta = sorted[sorted.length - 1].feesUsd - sorted[0].feesUsd;
    const existingIdx = newBuckets.findIndex(b => b.ts === hourTs);
    if (existingIdx >= 0) {
      newBuckets[existingIdx] = { ts: hourTs, deltaFeesUsd: Math.max(0, delta) };
    } else {
      newBuckets.push({ ts: hourTs, deltaFeesUsd: Math.max(0, delta) });
    }
  }

  // Descarta buckets com mais de 7 dias
  const prunedBuckets = newBuckets.filter(b => b.ts >= cutoff7d);

  return { snapshots: freshSnapshots, buckets: prunedBuckets };
}

/**
 * Calcula APR a partir do histórico de snapshots e buckets.
 * @param initialTimestamp - em milissegundos (como em PnlState)
 * @param currentFeesUsd - fees brutas on-chain atuais em USD
 */
export function computeApr(
  history: FeeHistory,
  initialLpUsd: number,
  initialTimestamp: number,
  currentFeesUsd: number,
): AprMetrics {
  const empty: AprMetrics = { aprAllTime: null, apr7d: null, apr24h: null, dailyFeesUsd: null };

  if (!initialLpUsd || initialLpUsd <= 0) return empty;

  const nowTs = Math.floor(Date.now() / 1000);
  const activationTs = Math.floor(initialTimestamp / 1000); // ms → s

  // APR All-time
  let aprAllTime: number | null = null;
  const daysSince = (nowTs - activationTs) / 86400;
  if (daysSince >= 1 && currentFeesUsd >= 0) {
    aprAllTime = (currentFeesUsd / initialLpUsd) * (365 / daysSince) * 100;
  }

  // APR 24h — usa snapshots[]
  let apr24h: number | null = null;
  if (history.snapshots.length >= 2) {
    const oldest = history.snapshots.reduce((a, b) => a.ts < b.ts ? a : b);
    const horasDecorridas = (nowTs - oldest.ts) / 3600;
    if (horasDecorridas >= 1) {
      const delta24h = Math.max(0, currentFeesUsd - oldest.feesUsd);
      apr24h = (delta24h / initialLpUsd) * (8760 / horasDecorridas) * 100;
    }
  }

  // APR 7d — combina buckets (>24h) + snapshots atuais (últimas 24h)
  let apr7d: number | null = null;
  const cutoff7d = nowTs - WINDOW_7D;
  const bucketsTotal = history.buckets
    .filter(b => b.ts >= cutoff7d)
    .reduce((sum, b) => sum + b.deltaFeesUsd, 0);
  const snapshotsDelta = history.snapshots.length >= 2
    ? Math.max(0, currentFeesUsd - history.snapshots.reduce((a, b) => a.ts < b.ts ? a : b).feesUsd)
    : 0;
  const delta7d = bucketsTotal + snapshotsDelta;

  const allTsPoints = [
    ...history.buckets.map(b => b.ts),
    ...history.snapshots.map(s => s.ts),
  ];
  if (allTsPoints.length > 0) {
    const oldestTs = Math.min(...allTsPoints);
    const horasDecorridas7d = (nowTs - oldestTs) / 3600;
    if (horasDecorridas7d >= 6) {
      apr7d = (delta7d / initialLpUsd) * (8760 / horasDecorridas7d) * 100;
    }
  }

  // Daily fees estimada a partir do APR all-time
  const dailyFeesUsd = aprAllTime !== null
    ? (aprAllTime / 100) * initialLpUsd / 365
    : null;

  return { aprAllTime, apr7d, apr24h, dailyFeesUsd };
}
```

- [ ] **Step 2: Verificar compilação**

```bash
cd D:/Documentos/Trae/APRDeltaNeutov3 && npx tsc --noEmit
```

Esperado: 0 erros de tipo.

- [ ] **Step 3: Commit**

```bash
git add src/engine/feeHistory.ts
git commit -m "feat: add feeHistory module — pushSnapshot and computeApr pure functions"
```

---

### Task 2: Adicionar `FeeHistory` em `PositionState` e campos APR em `DashboardData`

**Files:**
- Modify: `src/types.ts`
- Modify: `src/dashboard/store.ts`

- [ ] **Step 1: Adicionar import e campo em `src/types.ts`**

Em `src/types.ts`, adicionar no topo (após os imports existentes):

```typescript
import type { FeeHistory } from './engine/feeHistory';
```

Em `PositionState`, **adicionar apenas o campo `feeHistory`** após `preExitHedge?: HedgeState` — NÃO substituir a interface inteira (para não remover campos como `preExitHedge` e `lastLiquidity`):

```typescript
  preExitHedge?: HedgeState;
  feeHistory?: FeeHistory;  // ← adicionar esta linha após preExitHedge
```

- [ ] **Step 2: Adicionar campos APR em `DashboardData` em `src/dashboard/store.ts`**

Dentro da interface `DashboardData`, após `priceUpper?`:

```typescript
  aprAllTime?: number | null;
  apr7d?: number | null;
  apr24h?: number | null;
  aprDailyFeesUsd?: number | null;
```

- [ ] **Step 3: Verificar compilação**

```bash
cd D:/Documentos/Trae/APRDeltaNeutov3 && npx tsc --noEmit
```

Esperado: 0 erros.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/dashboard/store.ts
git commit -m "feat: add feeHistory to PositionState, add APR fields to DashboardData"
```

---

### Task 3: Adicionar métodos ao Rebalancer

**Files:**
- Modify: `src/engine/rebalancer.ts`

O Rebalancer precisa de dois novos métodos públicos:
- `pushFeeSnapshot(tokenId, rawFeesUsd)` — atualiza `PositionState.feeHistory` e salva estado
- `clearFeeHistory(tokenId)` — limpa feeHistory quando PnL é resetado

- [ ] **Step 1: Adicionar import de `pushSnapshot` no topo do rebalancer**

No topo de `src/engine/rebalancer.ts`, adicionar:

```typescript
import { pushSnapshot } from './feeHistory';
```

- [ ] **Step 2: Adicionar métodos públicos na classe `Rebalancer`**

Localizar o método `public getPnlTracker(tokenId)` e adicionar após ele:

```typescript
  public pushFeeSnapshot(tokenId: PositionId, rawFeesUsd: number): void {
    const ps = this.state.positions[String(tokenId)];
    if (!ps) return;
    ps.feeHistory = pushSnapshot(
      ps.feeHistory ?? { snapshots: [], buckets: [] },
      rawFeesUsd,
    );
    this.saveState();
  }

  public clearFeeHistory(tokenId: PositionId): void {
    const ps = this.state.positions[String(tokenId)];
    if (!ps) return;
    ps.feeHistory = { snapshots: [], buckets: [] };
    this.saveState();
    logger.debug({ message: 'fee_history.cleared', tokenId: String(tokenId) });
  }
```

- [ ] **Step 3: Verificar compilação**

```bash
cd D:/Documentos/Trae/APRDeltaNeutov3 && npx tsc --noEmit
```

Esperado: 0 erros.

- [ ] **Step 4: Commit**

```bash
git add src/engine/rebalancer.ts
git commit -m "feat: add pushFeeSnapshot and clearFeeHistory methods to Rebalancer"
```

---

## Chunk 2: Integração no ciclo LP e reset de PnL

### Task 4: Integrar no ciclo LP em `index.ts`

**Files:**
- Modify: `src/index.ts`

O ciclo LP (`runLpReadForToken`) já calcula `rawFeesUsd` na linha ~741. Precisamos:
1. Chamar `pushFeeSnapshot` com esse valor
2. Chamar `computeApr` e incluir os resultados no `store.update()`
3. Limpar `feeHistory` no handler de `resetPnl`

- [ ] **Step 1: Adicionar import de `computeApr` em `src/index.ts`**

Localizar os imports no topo de `index.ts` e adicionar:

```typescript
import { computeApr } from './engine/feeHistory';
```

- [ ] **Step 2: Integrar `pushFeeSnapshot` + `computeApr` em `runLpReadForToken`**

Após a linha onde `rawFeesUsd` é calculado (linha ~741), adicionar logo em seguida:

```typescript
    // Fee history — snapshot a cada ciclo LP para cálculo de APR
    ctx.rebalancer.pushFeeSnapshot(tokenId, rawFeesUsd);
    const psForApr = ctx.rebalancer.fullState.positions[String(tokenId)];
    const aprMetrics = psForApr?.pnl?.initialLpUsd && psForApr.pnl.initialLpUsd > 0
      ? computeApr(
          psForApr.feeHistory ?? { snapshots: [], buckets: [] },
          psForApr.pnl.initialLpUsd,
          psForApr.pnl.initialTimestamp,
          rawFeesUsd,
        )
      : { aprAllTime: null, apr7d: null, apr24h: null, dailyFeesUsd: null };
```

- [ ] **Step 3: Incluir campos APR nos dois blocos de `store.update()`**

Há dois blocos de `store.update()` em `runLpReadForToken`: um quando `cfg.hedgeSymbol && ctx.exchange` (com dados HL) e outro sem dados HL. Adicionar os campos APR em **ambos**:

```typescript
        // Adicionar dentro dos objetos passados para store.update():
        aprAllTime: aprMetrics.aprAllTime,
        apr7d: aprMetrics.apr7d,
        apr24h: aprMetrics.apr24h,
        aprDailyFeesUsd: aprMetrics.dailyFeesUsd,
```

- [ ] **Step 4: Conectar `clearFeeHistory` ao handler `resetPnl` em `index.ts`**

Localizar o handler de `resetPnl` (linha ~436):

```typescript
  store.on('resetPnl', ({ tokenId, initialLpUsd, initialHlUsd }) => {
    const tracker = ctx.rebalancer.getPnlTracker(tokenId);
    tracker.reinitialize(initialLpUsd, initialHlUsd);
    ctx.rebalancer.clearFeeHistory(tokenId);  // ← adicionar esta linha
    ctx.rebalancer.saveState();
    logger.info({ ... });
  });
```

- [ ] **Step 5: Verificar compilação**

```bash
cd D:/Documentos/Trae/APRDeltaNeutov3 && npx tsc --noEmit
```

Esperado: 0 erros.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: integrate fee history snapshot and APR computation into LP read cycle"
```

---

## Chunk 3: Card no Dashboard

### Task 5: Adicionar card "POOL APR" no HTML do dashboard

**Files:**
- Modify: `src/dashboard/public/index.html`

O dashboard gera cards dinamicamente via `positionMetricsHtml(tokenId, cfg)` e atualiza via `updateCards(d)`. Os IDs dos elementos são prefixados por `tokenId`.

- [ ] **Step 1: Adicionar o card em `positionMetricsHtml()`**

Localizar a função `positionMetricsHtml` no `index.html`. Ela constrói HTML via concatenação de strings — **não existe função `mc()`**, os cards são montados com `'<div class="mc">...'` diretamente.

Encontrar o bloco do card "LP Position" (buscar pela string `LP Position` dentro da função) e inserir o trecho abaixo **após** ele e **antes** do card "Hedge" / "Hedge · HL Perp". `tid` é a variável local da função que contém o tokenId (verificar nome exato no contexto — geralmente `tid` ou `tokenId`).

```javascript
// Card POOL APR — concatenar na string de retorno da função
'<div class="mc"><div class="mc-label">POOL APR</div>' +
'<div class="drows">' +
  '<div class="dr"><span class="dr-lbl">All-time</span><span class="dr-val" id="' + tid + '-aprAllTime">--</span></div>' +
  '<div class="dr"><span class="dr-lbl">7d</span><span class="dr-val" id="' + tid + '-apr7d">--</span></div>' +
  '<div class="dr"><span class="dr-lbl">24h</span><span class="dr-val" id="' + tid + '-apr24h">--</span></div>' +
'</div>' +
'<div style="margin-top:8px;font-size:11px;color:var(--tx-muted)">' +
  '<span id="' + tid + '-aprDailyFees" style="color:var(--green)">--</span>' +
  '<span style="color:var(--tx-muted)"> / dia (est. all-time)</span>' +
'</div></div>' +
```

- [ ] **Step 2: Adicionar `fmtApr` junto às funções de formatação**

Localizar onde `fmtUsd` e `fmtPct` são definidas no script do `index.html` e adicionar `fmtApr` ao lado (fora de qualquer função — escopo global do script):

```javascript
function fmtApr(v) {
  if (v == null) return '--';
  return v.toFixed(1) + '%';
}
```

- [ ] **Step 3: Atualizar `updateCards(d)` para popular os novos elementos**

Localizar a função `updateCards(d)` no `index.html`. Encontrar onde `lpFeesUsd` é atualizado e adicionar os novos campos logo abaixo. `get(field)` é o helper que retorna `document.getElementById(tid + '-' + field)`:

```javascript
// Dentro de updateCards(d), após os campos de PnL existentes:
var aprAllTimeEl = get('aprAllTime');
if (aprAllTimeEl) {
  aprAllTimeEl.textContent = fmtApr(d.aprAllTime);
  aprAllTimeEl.style.color = d.aprAllTime != null ? 'var(--green)' : '';
}
var apr7dEl = get('apr7d');
if (apr7dEl) {
  apr7dEl.textContent = fmtApr(d.apr7d);
  apr7dEl.style.color = d.apr7d != null ? 'var(--green)' : '';
}
var apr24hEl = get('apr24h');
if (apr24hEl) {
  apr24hEl.textContent = fmtApr(d.apr24h);
  apr24hEl.style.color = d.apr24h != null ? 'var(--green)' : '';
}
var aprDailyEl = get('aprDailyFees');
if (aprDailyEl) {
  aprDailyEl.textContent = d.aprDailyFeesUsd != null
    ? '≈ ' + fmtUsd(d.aprDailyFeesUsd)
    : '--';
}
```

- [ ] **Step 3: Build e verificar no browser**

```bash
cd D:/Documentos/Trae/APRDeltaNeutov3 && npm run build
```

Abrir o dashboard e verificar:
- Card "POOL APR" aparece após "LP Position" e antes de "Hedge · HL Perp"
- Todos os campos exibem `--` inicialmente (sem dados suficientes)
- Após ~1h de ciclos LP, APR 24h começa a popular
- Após ~1 dia, APR all-time aparece

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/public/index.html
git commit -m "feat: add Pool APR card to MONITOR dashboard with all-time, 7d, 24h APR and daily fees"
```

---

## Checklist Final

- [ ] `npx tsc --noEmit` sem erros
- [ ] `npm run build` sem erros
- [ ] Card visível no MONITOR após ativar uma posição
- [ ] Campos exibem `--` nas primeiras horas (dados insuficientes)
- [ ] RESET P&L BASE limpa o histórico (card volta para `--`)
- [ ] `state.json` contém `feeHistory` na posição após alguns ciclos
