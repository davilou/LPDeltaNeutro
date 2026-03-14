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
  ts: number;            // início da hora (unix timestamp, segundos)
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

`feeHistory` é adicionado como **campo opcional em `PositionState`** em `src/types.ts`, consistente com o padrão de `pnl?: PnlState`:

```typescript
interface PositionState {
  config: ActivePositionConfig;
  pnl?: PnlState;
  feeHistory?: FeeHistory;  // novo campo
}
```

Serializado em `state.json` dentro do objeto da posição:

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

Posições sem `feeHistory` (migração) inicializam com `{ snapshots: [], buckets: [] }` no primeiro acesso — sem breaking change. Sendo campo de `PositionState`, é automaticamente deletado junto com a posição em `deactivatePosition()`.

---

## Módulo `src/engine/feeHistory.ts`

Funções puras, sem efeitos colaterais:

### `pushSnapshot(history, feesUsd, nowTs?): FeeHistory`

Chamada a cada ciclo LP. `feesUsd` é a leitura de fees brutas on-chain (valor absoluto acumulado **sem** subtrair o baseline do PnL — ver seção de integração). `nowTs` é timestamp em segundos (default: `Math.floor(Date.now() / 1000)`).

**Lógica de agregação (sem sobreposição):**

1. Adiciona `{ ts: nowTs, feesUsd }` ao array `snapshots`
2. Identifica snapshots com `ts < nowTs - 86400` (mais de 24h atrás)
3. Para cada hora `H` nos snapshots expirados: agrega em bucket **somente se todos os snapshots daquela hora estiverem fora da janela de 24h** (ou seja, a hora inteira expirou). Snapshots de uma hora que ainda tem registros dentro das 24h permanecem em `snapshots[]` até a hora completar.
4. Para cada hora elegível: `deltaFeesUsd = ultimo.feesUsd - primeiro.feesUsd` dentro do grupo; se bucket para essa hora já existe, substitui (idempotente)
5. Remove os snapshots expirados e elegíveis de `snapshots[]`
6. Remove buckets com `ts < nowTs - 604800` (mais de 7 dias)
7. Retorna nova `FeeHistory` imutável

### `computeApr(history, initialLpUsd, initialTimestamp, currentFeesUsd): AprMetrics`

`initialTimestamp` é passado em **milissegundos** (como está em `PnlState`) e convertido para segundos internamente: `const activationTs = Math.floor(initialTimestamp / 1000)`.

`initialLpUsd` deve ser > 0 antes de chamar; se for 0 ou null, retornar `{ aprAllTime: null, apr7d: null, apr24h: null, dailyFeesUsd: null }`.

#### APR All-time
```
nowTs = Math.floor(Date.now() / 1000)
daysSince = (nowTs - activationTs) / 86400
// requer daysSince >= 1
aprAllTime = (currentFeesUsd / initialLpUsd) × (365 / daysSince) × 100
```

#### APR 24h
```
// Usa apenas snapshots[] — janela das últimas 24h
oldestSnapshot = snapshot mais antigo em snapshots[] (menor ts)
delta24h = currentFeesUsd - oldestSnapshot.feesUsd
horasDecorridas = (nowTs - oldestSnapshot.ts) / 3600
// requer horasDecorridas >= 1
apr24h = (delta24h / initialLpUsd) × (8760 / horasDecorridas) × 100
```

#### APR 7d
```
// Combina buckets (>24h) + contribuição dos snapshots atuais (últimas 24h)
// Os dois conjuntos cobrem janelas adjacentes sem sobreposição
// pois a regra de agregação garante separação limpa

bucketsTotal = soma(buckets.deltaFeesUsd) para buckets com ts >= nowTs - 604800
snapshotsDelta = currentFeesUsd - oldestSnapshot.feesUsd   // contribuição das últimas 24h
delta7d = bucketsTotal + snapshotsDelta

// Ponto inicial = início do bucket mais antigo OU ts do snapshot mais antigo
oldestTs = min(oldest bucket ts, oldest snapshot ts)
horasDecorridas = (nowTs - oldestTs) / 3600
// requer horasDecorridas >= 6

apr7d = (delta7d / initialLpUsd) × (8760 / horasDecorridas) × 100
```

#### Daily Fees (USD)
```
dailyFeesUsd = (aprAllTime / 100) × initialLpUsd / 365
// apenas se aprAllTime não for null
```

**Denominador fixo:** `initialLpUsd` em todos os cálculos (capital investido na ativação).

---

## Integração com o Ciclo LP

### Ponto de integração: ciclo LP em `index.ts`

`pushSnapshot` é chamado no **ciclo LP** (a cada `LP_READ_INTERVAL_MIN` ≈ 5 min), não dentro de `rebalancer.cycle()`. Isso garante a granularidade necessária para APR 24h. O Rebalancer expõe um método público:

```typescript
// src/engine/rebalancer.ts
pushFeeSnapshot(tokenId: PositionId, rawFeesUsd: number): void {
  const ps = this.state.positions[String(tokenId)];
  if (!ps) return;
  ps.feeHistory = pushSnapshot(ps.feeHistory ?? { snapshots: [], buckets: [] }, rawFeesUsd);
}
```

Em `index.ts`, após calcular `lpFeesUsd` no ciclo LP:

```typescript
// rawFeesUsd = fees brutas on-chain em USD (SEM subtrair initialLpFeesUsd)
// Calculado antes do pnlTracker.compute():
const rawFeesUsd = hedgeToken === 'token0'
  ? position.tokensOwed0 * position.price + position.tokensOwed1
  : position.tokensOwed0 + position.tokensOwed1 * volatilePriceUsd;

rebalancer.pushFeeSnapshot(tokenId, rawFeesUsd);
```

### Por que usar fees brutas (raw), não `pnl.lpFeesUsd`

`pnl.lpFeesUsd` (resultado de `pnlTracker.compute()`) é um delta relativo ao baseline: `Math.max(0, rawFees - initialLpFeesUsd)`. Quando o usuário executa **RESET P&L BASE**, `initialLpFeesUsd` é atualizado para o valor atual, fazendo `pnl.lpFeesUsd` retornar a zero. Isso tornaria todos os snapshots históricos incoerentes (valores maiores que o atual).

Usando fees brutas on-chain (`tokensOwed0/tokensOwed1` convertidos para USD), os snapshots refletem o valor real lido do contrato — independente de resets de P&L. Os deltas entre snapshots permanecem válidos mesmo após reset.

### RESET P&L BASE

Quando o usuário executa reset via dashboard, **`feeHistory` é limpo junto**:

```typescript
// em resetPnl() no Rebalancer
ps.feeHistory = { snapshots: [], buckets: [] };
```

O card APR mostrará `--` temporariamente após o reset, retomando após acumular dados suficientes. Isso é comportamento esperado e correto.

### `computeApr` chamado no ciclo LP

Após `pushFeeSnapshot`, calcular métricas e incluir em `DashboardData`:

```typescript
const ps = this.state.positions[String(tokenId)];
const aprMetrics = ps?.pnl?.initialLpUsd && ps.pnl.initialLpUsd > 0
  ? computeApr(
      ps.feeHistory ?? { snapshots: [], buckets: [] },
      ps.pnl.initialLpUsd,
      ps.pnl.initialTimestamp,  // em ms — convertido internamente
      rawFeesUsd
    )
  : { aprAllTime: null, apr7d: null, apr24h: null, dailyFeesUsd: null };
```

### Extensão de `DashboardData` em `src/dashboard/store.ts`

```typescript
aprAllTime?: number | null;
apr7d?: number | null;
apr24h?: number | null;
aprDailyFeesUsd?: number | null;
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
- Dados insuficientes (`null`) → `--` em cinza
- Posição com < 1h ativa → todos os campos `--`
- Valores positivos em verde (padrão do projeto)

---

## Arquivos Modificados

| Arquivo | Mudança |
|---------|---------|
| `src/engine/feeHistory.ts` | **Novo** — tipos `FeeSnapshot`, `HourlyFeeBucket`, `FeeHistory`, `AprMetrics` + funções `pushSnapshot` e `computeApr` |
| `src/types.ts` | Adicionar `feeHistory?: FeeHistory` em `PositionState`; importar tipos de `feeHistory.ts` |
| `src/dashboard/store.ts` | Adicionar campos `aprAllTime`, `apr7d`, `apr24h`, `aprDailyFeesUsd` em `DashboardData` |
| `src/engine/rebalancer.ts` | Adicionar método `pushFeeSnapshot(tokenId, rawFeesUsd)`; limpar `feeHistory` em `resetPnl()` |
| `src/index.ts` | Chamar `rebalancer.pushFeeSnapshot()` e `computeApr()` no ciclo LP; popular campos APR em `DashboardData` |
| `src/dashboard/public/index.html` | Novo card em `positionMetricsHtml()`; atualização dos 4 elementos em `updateCards()` |

---

## Restrições e Gotchas

- `feeHistory` em `PositionState` → deletado automaticamente em `deactivatePosition()` junto com a posição
- Todos os timestamps internos em **segundos**; `initialTimestamp` (de `PnlState`) está em ms — converter com `Math.floor(ts / 1000)` em `computeApr`
- `initialLpUsd` pode ser 0 ou undefined em posições antigas migradas — checar antes de dividir; retornar todos `null`
- Em dry-run (`MockExchange`), fees on-chain podem ser 0 se posição nunca teve fees — APR permanece `null` (exibe `--`); isso é correto
- `rawFeesUsd` pode ser 0 nas primeiras leituras (fees ainda não acumuladas) — snapshot é adicionado normalmente, APR ficará `null` até threshold mínimo
- `dailyFeesUsd` com `daysSince` próximo de 1 (1–2 dias) pode ser ruidoso — comportamento correto por design; não adicionar suavização não especificada
- Nunca usar `pnl.lpFeesUsd` (delta relativo) como input de `pushSnapshot` — sempre usar fees brutas calculadas diretamente de `tokensOwed0/tokensOwed1`
