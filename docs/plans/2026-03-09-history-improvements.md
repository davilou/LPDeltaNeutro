# History Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Melhorar a aba HISTORY com: (1) range em USD nas closed positions, (2) colunas Realized + Unrealized em active e closed positions, (3) painel expansível de rebalances por posição (NFT ID) com fee, funding e realized PnL.

**Architecture:** Três camadas: (A) backend — adicionar campos a `HistoricalPosition` e `RebalanceEvent`, corrigir `fetchRebalances` para filtrar por tokenId; (B) frontend — atualizar `renderHistory()` e `renderActivePositionsInHistory()` em `index.html`, adicionar lógica de expand/collapse com fetch lazy.

**Tech Stack:** Node.js + TypeScript strict, vanilla JS no dashboard, Supabase (opcional)

---

### Task 1: types.ts + rebalancer.ts — priceLowerUsd/priceUpperUsd em HistoricalPosition

**Files:**
- Modify: `src/types.ts`
- Modify: `src/engine/rebalancer.ts`

**Step 1: Adicionar campos opcionais a HistoricalPosition em `src/types.ts`**

Localizar a interface `HistoricalPosition` (linha 108). Após a linha `finalRealizedPnlUsd: number;`, adicionar:
```typescript
  priceLowerUsd?: number;
  priceUpperUsd?: number;
```

**Step 2: Computar USD range em `archivePosition()` em `src/engine/rebalancer.ts`**

Localizar `archivePosition()` (linha 160). Logo antes de `const record: HistoricalPosition = {`, adicionar:
```typescript
// Compute USD range from ticks (same formula as rebalancer cycle)
const token0Dec = cfg.token0Decimals ?? 18;
const token1Dec = cfg.token1Decimals ?? 6;
const decimalAdj = Math.pow(10, token0Dec - token1Dec);
const rawLo = Math.pow(1.0001, cfg.tickLower ?? 0) * decimalAdj;
const rawHi = Math.pow(1.0001, cfg.tickUpper ?? 0) * decimalAdj;
const priceLowerUsd = (cfg.token0Decimals != null && cfg.token1Decimals != null)
  ? (cfg.hedgeToken === 'token1' ? 1 / rawHi : rawLo)
  : undefined;
const priceUpperUsd = (cfg.token0Decimals != null && cfg.token1Decimals != null)
  ? (cfg.hedgeToken === 'token1' ? 1 / rawLo : rawHi)
  : undefined;
```

No objeto `record: HistoricalPosition`, após `finalRealizedPnlUsd: finalPnl.realizedVirtualPnlUsd,`, adicionar:
```typescript
      priceLowerUsd,
      priceUpperUsd,
```

**Step 3: Verificar build**
```bash
npx tsc --noEmit
```
Expected: zero erros.

**Step 4: Commit**
```bash
git add src/types.ts src/engine/rebalancer.ts
git commit -m "feat(history): adicionar priceLowerUsd/priceUpperUsd a HistoricalPosition"
```

---

### Task 2: store.ts + rebalancer.ts — funding e realized no RebalanceEvent

**Files:**
- Modify: `src/dashboard/store.ts`
- Modify: `src/engine/rebalancer.ts`

**Step 1: Adicionar campos a `RebalanceEvent` em `src/dashboard/store.ts`**

Localizar a interface `RebalanceEvent` (linha 44). Após `isEmergency?: boolean;`, adicionar:
```typescript
  fundingUsd?: number;
  realizedPnlUsd?: number;
```

**Step 2: Popular campos no evento em `src/engine/rebalancer.ts`**

Localizar o bloco de criação do evento (linha 476). O objeto `event` atualmente termina em `isEmergency,`. Adicionar após:
```typescript
      fundingUsd: pnl.cumulativeFundingUsd,
      realizedPnlUsd: pnl.realizedVirtualPnlUsd,
```

**Step 3: Verificar build**
```bash
npx tsc --noEmit
```
Expected: zero erros.

**Step 4: Commit**
```bash
git add src/dashboard/store.ts src/engine/rebalancer.ts
git commit -m "feat(history): adicionar fundingUsd e realizedPnlUsd ao RebalanceEvent"
```

---

### Task 3: supabase.ts + server.ts — filtro por tokenId em /api/rebalances

**Files:**
- Modify: `src/db/supabase.ts`
- Modify: `src/dashboard/server.ts`

**Step 1: Atualizar `fetchRebalances` em `src/db/supabase.ts`**

Substituir a assinatura atual:
```typescript
export async function fetchRebalances(userId?: string, limit = 100): Promise<RebalanceRecord[]> {
```
Por:
```typescript
export async function fetchRebalances(userId?: string, tokenId?: number, limit = 100): Promise<RebalanceRecord[]> {
```

Atualizar o select para incluir campos de PnL e tokenId:
```typescript
.select('token_id, timestamp, coin, action, avg_px, executed_sz, trade_value_usd, fee_usd, trigger_reason, is_emergency, from_size, to_size, from_notional, to_notional, token0_symbol, token1_symbol, range_status, price, pnl_realized_usd, pnl_funding_usd')
```

Após a linha `if (userId) query = query.eq('user_id', userId);`, adicionar:
```typescript
if (tokenId !== undefined) query = query.eq('token_id', tokenId);
```

**Step 2: Atualizar `/api/rebalances` em `src/dashboard/server.ts`**

Localizar o endpoint `app.get('/api/rebalances', ...)` (linha 140). No bloco Supabase, substituir:
```typescript
const records = await fetchRebalances(userId !== 'default' ? userId : undefined);
```
Por:
```typescript
const qTokenId = req.query.tokenId ? parseInt(req.query.tokenId as string) : undefined;
const records = await fetchRebalances(
  userId !== 'default' ? userId : undefined,
  !isNaN(qTokenId ?? NaN) ? qTokenId : undefined,
);
```

**Step 3: Verificar build**
```bash
npx tsc --noEmit
```
Expected: zero erros.

**Step 4: Commit**
```bash
git add src/db/supabase.ts src/dashboard/server.ts
git commit -m "feat(history): filtrar rebalances por tokenId, incluir pnl_realized_usd e pnl_funding_usd"
```

---

### Task 4: index.html — range USD, colunas Realized/Unrealized, painel expansível de rebalances

**Files:**
- Modify: `src/dashboard/public/index.html`

Esta é a maior task. Leia o arquivo antes de editar — as linhas exatas podem ter mudado.

#### Passo 1: Cache de rebalances client-side

Localizar a área de variáveis globais do IIFE principal (próximo ao início do script, onde estão `dataMap`, `positionHistory`, etc.). Adicionar:
```javascript
var rebalanceCache = {}; // tokenId -> array de rebalances (lazy loaded)
var rebalanceExpanded = {}; // tokenId -> boolean
```

#### Passo 2: Função de formatação de rebalances para o painel

Adicionar esta função junto às outras funções de render:
```javascript
function renderRebalancesPanel(tokenId, rows) {
  if (!rows || rows.length === 0) {
    return '<tr class="rebalance-panel-row" id="rp-' + tokenId + '">' +
      '<td colspan="11" style="padding:8px 12px;background:var(--bg2);color:var(--tx-dim);font-size:0.75rem;">Nenhum rebalance registrado.</td></tr>';
  }
  var header = '<tr style="background:var(--bg2);"><th style="padding:4px 8px;font-size:0.7rem;color:var(--tx-dim);">Time</th>' +
    '<th style="padding:4px 8px;font-size:0.7rem;color:var(--tx-dim);">Action</th>' +
    '<th style="padding:4px 8px;font-size:0.7rem;color:var(--tx-dim);">Size (from→to)</th>' +
    '<th style="padding:4px 8px;font-size:0.7rem;color:var(--tx-dim);">Avg Price</th>' +
    '<th style="padding:4px 8px;font-size:0.7rem;color:var(--tx-dim);">Fee</th>' +
    '<th style="padding:4px 8px;font-size:0.7rem;color:var(--tx-dim);">Funding acum.</th>' +
    '<th style="padding:4px 8px;font-size:0.7rem;color:var(--tx-dim);">Realized PnL</th>' +
    '<th style="padding:4px 8px;font-size:0.7rem;color:var(--tx-dim);">Trigger</th></tr>';
  var dataRows = rows.map(function(r) {
    // Supabase: snake_case; in-memory: camelCase
    var ts = r.timestamp || r.timestamp;
    var timeStr = ts ? new Date(typeof ts === 'number' ? ts : ts).toLocaleString() : '--';
    var action = r.action || '--';
    var fromSz = r.from_size != null ? r.from_size : (r.fromSize != null ? r.fromSize : null);
    var toSz = r.to_size != null ? r.to_size : (r.toSize != null ? r.toSize : null);
    var sizeStr = (fromSz != null && toSz != null)
      ? fmt(fromSz, 4) + ' → ' + fmt(toSz, 4)
      : '--';
    var avgPx = r.avg_px != null ? r.avg_px : (r.avgPx != null ? r.avgPx : null);
    var avgPxStr = avgPx != null ? '$' + fmt(avgPx, 4) : '--';
    var feeUsd = r.fee_usd != null ? r.fee_usd : (r.feeUsd != null ? r.feeUsd : null);
    var feeStr = feeUsd != null ? '-$' + fmt(feeUsd, 4) : '--';
    var fundUsd = r.pnl_funding_usd != null ? r.pnl_funding_usd : (r.fundingUsd != null ? r.fundingUsd : null);
    var fundColor = fundUsd == null ? 'var(--tx)' : fundUsd >= 0 ? 'var(--green)' : 'var(--red)';
    var fundStr = fundUsd != null ? (fundUsd >= 0 ? '+' : '') + '$' + fmt(Math.abs(fundUsd), 2) : '--';
    var realUsd = r.pnl_realized_usd != null ? r.pnl_realized_usd : (r.realizedPnlUsd != null ? r.realizedPnlUsd : null);
    var realColor = realUsd == null ? 'var(--tx)' : realUsd >= 0 ? 'var(--green)' : 'var(--red)';
    var realStr = realUsd != null ? (realUsd >= 0 ? '+' : '') + '$' + fmt(Math.abs(realUsd), 2) : '--';
    var trigger = r.trigger_reason || (r.triggerReason || '--');
    var isEmerg = r.is_emergency || r.isEmergency;
    var trigColor = isEmerg ? 'var(--red)' : 'var(--tx-dim)';
    return '<tr style="background:var(--bg2);border-top:1px solid var(--border);">' +
      '<td style="padding:4px 8px;font-size:0.72rem;">' + timeStr + '</td>' +
      '<td style="padding:4px 8px;font-size:0.72rem;">' + action + '</td>' +
      '<td style="padding:4px 8px;font-size:0.72rem;">' + sizeStr + '</td>' +
      '<td style="padding:4px 8px;font-size:0.72rem;">' + avgPxStr + '</td>' +
      '<td style="padding:4px 8px;font-size:0.72rem;color:var(--red);">' + feeStr + '</td>' +
      '<td style="padding:4px 8px;font-size:0.72rem;color:' + fundColor + ';">' + fundStr + '</td>' +
      '<td style="padding:4px 8px;font-size:0.72rem;color:' + realColor + ';">' + realStr + '</td>' +
      '<td style="padding:4px 8px;font-size:0.72rem;color:' + trigColor + ';">' + trigger + '</td>' +
      '</tr>';
  }).join('');
  return '<tr class="rebalance-panel-row" id="rp-' + tokenId + '">' +
    '<td colspan="11" style="padding:0;background:var(--bg2);">' +
    '<table style="width:100%;border-collapse:collapse;">' +
    '<thead>' + header + '</thead><tbody>' + dataRows + '</tbody></table>' +
    '</td></tr>';
}
```

#### Passo 3: Função toggleRebalancePanel

```javascript
function toggleRebalancePanel(tokenId, colSpan) {
  rebalanceExpanded[tokenId] = !rebalanceExpanded[tokenId];
  var existing = document.getElementById('rp-' + tokenId);
  if (!rebalanceExpanded[tokenId]) {
    if (existing) existing.parentNode.removeChild(existing);
    return;
  }
  // Find the clicked row to insert after
  var row = document.getElementById('hist-row-' + tokenId) ||
            document.getElementById('active-row-' + tokenId);
  if (!row) return;

  function insertPanel(rows) {
    var existing2 = document.getElementById('rp-' + tokenId);
    if (existing2) existing2.parentNode.removeChild(existing2);
    var tmp = document.createElement('tbody');
    tmp.innerHTML = renderRebalancesPanel(tokenId, rows);
    var panelRow = tmp.firstChild;
    // Update colspan
    if (panelRow && panelRow.firstChild) {
      panelRow.firstChild.setAttribute('colspan', String(colSpan));
    }
    row.parentNode.insertBefore(panelRow, row.nextSibling);
  }

  // Use cache if available
  if (rebalanceCache[tokenId]) {
    insertPanel(rebalanceCache[tokenId]);
    return;
  }

  // Show loading row first
  var tmp = document.createElement('tbody');
  tmp.innerHTML = '<tr class="rebalance-panel-row" id="rp-' + tokenId + '">' +
    '<td colspan="' + colSpan + '" style="padding:8px 12px;background:var(--bg2);color:var(--tx-dim);font-size:0.75rem;">Carregando rebalances...</td></tr>';
  row.parentNode.insertBefore(tmp.firstChild, row.nextSibling);

  // Fetch from API
  fetch('/api/rebalances?tokenId=' + tokenId)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      rebalanceCache[tokenId] = data;
      insertPanel(data);
    })
    .catch(function() {
      insertPanel([]);
    });
}
```

#### Passo 4: Atualizar `renderHistory()` — closed positions table

Localizar `renderHistory()`. Fazer as seguintes mudanças:

**4a) Atualizar header da tabela de fechadas** (atualmente tem 9 colunas `colspan="9"`):

Substituir a linha do `thead` das closed positions:
```javascript
// ANTES (9 colunas):
tbody.innerHTML = '<tr><td colspan="9" class="empty-msg">...</td></tr>';
// e no thead:
// NFT# | Pool | Range | Duration | Initial LP | LP Fees | Funding | HL Fees | Net P&L
```

Adicionar 2 colunas (Unrealized e Realized) após HL Fees, antes de Net P&L. A tabela de fechadas fica com **11 colunas**.

**4b) Atualizar o `colspan` do empty state de 9 para 11**.

**4c) Atualizar o `tbody.innerHTML` das closed positions** — substituir a linha que monta o `<tr>` das closed positions:

```javascript
tbody.innerHTML = positionHistory.map(function (h) {
  var dur = (h.deactivatedAt && h.activatedAt) ? fmtDuration(h.deactivatedAt - h.activatedAt) : '--';
  var pool = (h.token0Symbol || '?') + '/' + (h.token1Symbol || '?') +
    (h.fee ? ' ' + (h.fee / 10000).toFixed(2) + '%' : '');
  // Range: usar USD se disponível, senão ticks
  var range = (h.priceLowerUsd != null && h.priceUpperUsd != null)
    ? '$' + fmt(h.priceLowerUsd, 2) + ' – $' + fmt(h.priceUpperUsd, 2)
    : (h.tickLower != null && h.tickUpper != null)
      ? h.tickLower + ' / ' + h.tickUpper
      : '--';
  var netUsd = h.finalVirtualPnlUsd || 0;
  var netPct = h.finalVirtualPnlPercent || 0;
  var netColor = netUsd >= 0 ? 'var(--green)' : 'var(--red)';
  var netSign = netUsd >= 0 ? '+' : '';
  var netPctSign = netPct >= 0 ? '+' : '';
  var fundUsd = h.finalCumulativeFundingUsd || 0;
  var fundColor = fundUsd >= 0 ? 'var(--green)' : 'var(--red)';
  var fundSign = fundUsd >= 0 ? '+' : '';
  var unreal = h.finalUnrealizedPnlUsd || 0;
  var realiz = h.finalRealizedPnlUsd || 0;
  var unrealColor = unreal >= 0 ? 'var(--green)' : 'var(--red)';
  var realizColor = realiz >= 0 ? 'var(--green)' : 'var(--red)';
  var isExp = !!rebalanceExpanded[h.tokenId];
  var rowStyle = isExp ? 'background:var(--bg2);' : '';
  return '<tr id="hist-row-' + h.tokenId + '" style="cursor:pointer;' + rowStyle + '" onclick="toggleRebalancePanel(' + h.tokenId + ', 11)">' +
    '<td>' + h.tokenId + ' <span style="font-size:0.65rem;color:var(--tx-dim);">' + (isExp ? '▲' : '▼') + '</span></td>' +
    '<td>' + pool + '</td>' +
    '<td style="font-size:0.72rem;color:var(--tx-dim);">' + range + '</td>' +
    '<td>' + dur + '</td>' +
    '<td>' + fmtUsd(h.initialLpUsd) + '</td>' +
    '<td style="color:var(--green);">+' + fmtUsd(h.finalLpFeesUsd || 0) + '</td>' +
    '<td style="color:' + fundColor + ';">' + fundSign + fmtUsd(fundUsd) + '</td>' +
    '<td style="color:var(--red);">-' + fmtUsd(Math.abs(h.finalCumulativeHlFeesUsd || 0)) + '</td>' +
    '<td style="color:' + unrealColor + ';">' + (unreal >= 0 ? '+' : '') + fmtUsd(unreal) + '</td>' +
    '<td style="color:' + realizColor + ';">' + (realiz >= 0 ? '+' : '') + fmtUsd(realiz) + '</td>' +
    '<td style="color:' + netColor + ';">' + netSign + fmtUsd(netUsd) +
    ' <span style="font-size:0.72rem;">(' + netPctSign + fmt(netPct, 2) + '%)</span></td>' +
    '</tr>';
}).join('');
```

**4d) Atualizar o `<thead>` da tabela de fechadas** para incluir as 2 novas colunas (Unrealized, Realized) antes de Net P&L. Localizar o HTML do thead que monta a tabela de histórico e substituir para:
```html
<th>NFT#</th><th>Pool</th><th>Range</th><th>Duration</th>
<th>Initial LP</th><th>LP Fees</th><th>Funding</th><th>HL Fees</th>
<th>Unrealized</th><th>Realized</th><th>Net P&L</th>
```

#### Passo 5: Atualizar `renderActivePositionsInHistory()` — active positions table

A tabela de ativas atualmente tem 10 colunas. Adicionar Unrealized e Realized → **12 colunas**.

**5a) Atualizar cada `<tr>` das active positions:**

Localizar o bloco `return '<tr>' + ...` dentro de `renderActivePositionsInHistory()`. Após a célula de `hlFees` e antes de `pnlCell`, adicionar:
```javascript
var unrealUsd = d && d.unrealizedPnlUsd != null ? d.unrealizedPnlUsd : null;
var realizUsd = d && d.realizedPnlUsd != null ? d.realizedPnlUsd : null;
var unrealColor = unrealUsd == null ? 'var(--tx)' : unrealUsd >= 0 ? 'var(--green)' : 'var(--red)';
var realizColor2 = realizUsd == null ? 'var(--tx)' : realizUsd >= 0 ? 'var(--green)' : 'var(--red)';
var unrealCell = unrealUsd != null ? '<span style="color:' + unrealColor + ';">' + (unrealUsd >= 0 ? '+' : '') + fmtUsd(unrealUsd) + '</span>' : '--';
var realizCell = realizUsd != null ? '<span style="color:' + realizColor2 + ';">' + (realizUsd >= 0 ? '+' : '') + fmtUsd(realizUsd) + '</span>' : '--';
```

No `return '<tr>' + ...`, adicionar `id="active-row-' + tid + '"` e `onclick` ao `<tr>`, e inserir as duas células antes de `pnlCell`:
```javascript
return '<tr id="active-row-' + tid + '" style="cursor:pointer;" onclick="toggleRebalancePanel(' + tid + ', 12)">' +
  '<td>' + tid + ' <span style="font-size:0.65rem;color:var(--tx-dim);">▼</span></td>' +
  '<td>' + pool + '</td>' +
  '<td style="font-size:0.72rem;color:var(--tx-dim);">' + range + '</td>' +
  '<td>' + status + '</td>' +
  '<td>' + dur + '</td>' +
  '<td>' + lpVal + '</td>' +
  '<td style="color:var(--green);">' + lpFees + '</td>' +
  '<td>' + funding + '</td>' +
  '<td>' + hlFees + '</td>' +
  '<td>' + unrealCell + '</td>' +
  '<td>' + realizCell + '</td>' +
  '<td>' + pnlCell + '</td>' +
  '</tr>';
```

**5b) Atualizar o `<thead>` da tabela de ativas** para incluir Unrealized e Realized antes de P&L:
```html
<th>NFT#</th><th>Pool</th><th>Range ($)</th><th>Status</th><th>Duration</th>
<th>LP Value</th><th>LP Fees</th><th>Funding</th><th>HL Fees</th>
<th>Unrealized</th><th>Realized</th><th>P&L</th>
```

#### Passo 6: Verificar build
```bash
npx tsc --noEmit
```
Expected: zero erros (index.html não é compilado pelo tsc, mas garantir que os .ts não quebraram).

#### Passo 7: Commit
```bash
git add src/dashboard/public/index.html
git commit -m "feat(history): range USD, colunas realized/unrealized, painel expansível de rebalances"
```
