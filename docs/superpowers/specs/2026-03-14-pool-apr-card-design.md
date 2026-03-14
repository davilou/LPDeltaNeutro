# Pool APR Card — Design Spec

**Data:** 2026-03-14
**Status:** Aprovado pelo usuário

---

## Objetivo

Adicionar um novo card na aba MONITOR do dashboard que exibe o APR da pool e fees diárias estimadas, calculados a partir de dados reais de fees on-chain acumuladas desde a ativação da posição.

---

## Métricas exibidas

| Campo | Descrição |
|-------|-----------|
| APR All-time | Rentabilidade anualizada desde a ativação da posição |
| APR 7d | Rentabilidade anualizada baseada nos últimos 7 dias |
| APR 24h | Rentabilidade anualizada baseada nas últimas 24 horas |
| Daily Fees | Estimativa de fees diárias em USD, baseada no APR all-time |

**Ordem de exibição no card:** All-time → 7d → 24h → Daily Fees

---

## Estrutura de Dados

### Tipos (`src/engine/feeHistory.ts`)

```typescript
interface FeeSnapshot {
  ts: number;       // unix timestamp em segundos
  feesUsd: number;  // fees acumuladas desde ativação neste momento
}

interface HourlyFeeBucket {
  ts: number;            // início da hora (unix timestamp)
  deltaFeesUsd: number;  // fees geradas durante essa hora
}

interface FeeHistory {
  snapshots: FeeSnapshot[];    // últimas 24h — granularidade por ciclo (~5 min)
  buckets: HourlyFeeBucket[];  // janela 24h–7d — agregados por hora
}

interface AprMetrics {
  aprAllTime: number | null;   // null se < 1 dia de dados
  apr7d: number | null;        // null se < 6h de dados disponíveis
  apr24h: number | null;       // null se < 1h de snapshots
  dailyFeesUsd: number | null; // null se aprAllTime for null
}
```

### Capacidade máxima por posição
- `snapshots`: máx ~288 registros (últimas 24h × 12 ciclos/hora)
- `buckets`: máx ~168 registros (7 dias × 24 horas/dia)
- Total: ~456 registros por posição — impacto trivial no `state.json`

### Persistência

Campo `feeHistory` adicionado por posição em `state.json`:

```json
{
  "positions": {
    "123": {
      "config": {},
      "pnl": {},
      "feeHistory": {
        "snapshots": [{ "ts": 1710000000, "feesUsd": 45.67 }],
        "buckets": [{ "ts": 1709996400, "deltaFeesUsd": 12.34 }]
      }
    }
  }
}
```

Posições sem `feeHistory` (migração) inicializam com `{ snapshots: [], buckets: [] }` — sem breaking change.

---

## Módulo `src/engine/feeHistory.ts`

Funções puras, sem efeitos colaterais:

### `pushSnapshot(history, feesUsd, nowTs?): FeeHistory`

Chamada a cada ciclo LP. Lógica:
1. Adiciona `{ ts: now, feesUsd }` ao array `snapshots`
2. Separa snapshots com `ts < now - 24h`
3. Agrupa os separados por hora → calcula delta entre primeiro e último de cada hora → cria `HourlyFeeBucket`
4. Remove buckets com `ts < now - 7d`
5. Retorna nova `FeeHistory` (imutável)

### `computeApr(history, initialLpUsd, initialTimestamp, currentFeesUsd): AprMetrics`

#### APR All-time
```
daysSince = (now - initialTimestamp) / 86400
aprAllTime = (currentFeesUsd / initialLpUsd) × (365 / daysSince) × 100
// requer daysSince >= 1
```

#### APR 24h
```
snapshot24h = snapshot mais antigo em snapshots[]
delta24h = currentFeesUsd - snapshot24h.feesUsd
horasDecorridas = (now - snapshot24h.ts) / 3600
apr24h = (delta24h / initialLpUsd) × (8760 / horasDecorridas) × 100
// requer horasDecorridas >= 1
```

#### APR 7d
```
// Combina buckets (>24h) + snapshots atuais (últimas 24h)
delta7d = soma(buckets.deltaFeesUsd) + (currentFeesUsd - snapshot_mais_antigo.feesUsd)
horasDecorridas = (now - ts_mais_antigo_disponivel) / 3600
apr7d = (delta7d / initialLpUsd) × (8760 / horasDecorridas) × 100
// requer horasDecorridas >= 6
```

#### Daily Fees (USD)
```
dailyFeesUsd = (aprAllTime / 100) × initialLpUsd / 365
```

**Denominador fixo:** `initialLpUsd` em todos os cálculos (capital investido na ativação).

---

## Integração com Rebalancer

Em `src/engine/rebalancer.ts`, no ciclo LP (após calcular `lpFeesUsd`):

```typescript
// Atualiza histórico de fees e calcula APR
ctx.feeHistory[tokenId] = pushSnapshot(
  ctx.feeHistory[tokenId] ?? { snapshots: [], buckets: [] },
  pnl.lpFeesUsd
);
const aprMetrics = computeApr(
  ctx.feeHistory[tokenId],
  pos.pnl.initialLpUsd,
  pos.pnl.initialTimestamp,
  pnl.lpFeesUsd
);
```

`feeHistory` fica como `Map<tokenId, FeeHistory>` no `UserEngineContext`, persistido via `saveState()`.

### Extensão de `DashboardData`

```typescript
aprAllTime?: number | null;
apr7d?: number | null;
apr24h?: number | null;
dailyFeesUsd?: number | null;
```

---

## Card no Dashboard

### Posição
Inserido após "LP Position" e antes de "Hedge · HL Perp" em `positionMetricsHtml()`.

### Layout

```
┌─────────────────────────────────────────┐
│  POOL APR                               │
│                                         │
│  All-time      7d          24h          │
│   18.4%       19.8%       22.1%        │
│                                         │
│  ≈ $12.34 / dia  (baseado no all-time)  │
└─────────────────────────────────────────┘
```

### IDs dos elementos (prefixados por `tokenId`)

| ID | Conteúdo |
|----|----------|
| `{tid}-aprAllTime` | ex: `18.4%` |
| `{tid}-apr7d` | ex: `19.8%` |
| `{tid}-apr24h` | ex: `22.1%` |
| `{tid}-aprDailyFees` | ex: `$12.34 / dia` |

### Estados visuais
- Dados insuficientes → `--` em cinza
- Posição com < 1h ativa → todos os campos `--`
- Valores positivos em verde (padrão do projeto)

---

## Arquivos Modificados

| Arquivo | Mudança |
|---------|---------|
| `src/engine/feeHistory.ts` | **Novo** — tipos + funções puras |
| `src/engine/rebalancer.ts` | Chamar `pushSnapshot` + `computeApr` no ciclo LP; persistir `feeHistory`; popular `DashboardData` |
| `src/types.ts` ou `src/dashboard/store.ts` | Adicionar campos APR em `DashboardData` |
| `src/dashboard/public/index.html` | Novo card em `positionMetricsHtml()`; atualização em `updateCards()` |

---

## Restrições e Gotchas

- `feeHistory` deve ser inicializado com `{ snapshots: [], buckets: [] }` se ausente no `state.json` (migração silenciosa)
- `lpFeesUsd` nunca decresce (é `Math.max(0, currentFees - initialFees)`) — não há risco de APR negativo
- Em dry-run (`MockExchange`), `lpFeesUsd` pode ser 0 — APR permanece `null` (exibe `--`)
- Nunca comparar `ts` em milissegundos com `Date.now() / 1000` — usar segundos consistentemente
- `initialLpUsd` pode ser 0 em posições antigas migradas — checar antes de dividir (retorna `null`)
