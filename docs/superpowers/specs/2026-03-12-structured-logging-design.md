# Structured Logging com Loki + Prometheus + Grafana + Telegram

**Data:** 2026-03-12
**Status:** Aprovado
**Stack:** Winston + winston-loki + prom-client + node-telegram-bot-api + AsyncLocalStorage

---

## Objetivo

Implementar logging estruturado (JSON) com contexto automático por operação, métricas Prometheus operacionais, envio de logs para Grafana Cloud (Loki), e alertas críticos via Telegram.

## Decisões de Design

| Decisão | Escolha | Alternativas descartadas |
|---------|---------|--------------------------|
| Infra | Grafana Cloud (free tier) | Railway services, self-hosted |
| Métricas | Só operacionais (cat. A) | + negócio (B), + infra (C) |
| Migração | Incremental (hot paths) | Big bang (todos os 275 calls) |
| Alertas | Telegram | Discord, Slack |
| Async context | AsyncLocalStorage nativo | async-local-storage npm, cls-hooked |
| Loki transport | winston-loki | HTTP push direto |
| Prometheus | prom-client | OpenTelemetry |

## Arquitetura de Arquivos

```
src/utils/
├── logger.ts           # Reescrito: JSON estruturado + Loki transport + async context auto-inject
├── correlation.ts      # NOVO: AsyncLocalStorage + withContext() + generateCorrelationId()
├── alerts.ts           # NOVO: Telegram bot + rate limiting
└── metrics.ts          # NOVO: prom-client counters/gauges/histograms + endpoint /metrics
```

### Fluxo de Dados

```
Bot (logger.info/warn/error)
  → Winston format (JSON estruturado)
    → injeta campos do AsyncLocalStorage (userId, correlationId, tokenId, chain, dex)
    → Console transport (colorido em dev, JSON em prod)
    → DailyRotateFile transport (JSON)
    → Loki transport (push HTTP para Grafana Cloud)

Bot (operações chave)
  → prom-client (counters, histograms, gauges)
    → Express endpoint GET /metrics
    → Grafana Cloud Prometheus scrape

Bot (erro severity: critical)
  → alerts.ts
    → Telegram Bot API (com rate limit)
```

### Arquivos Existentes Modificados

- `src/config.ts` — novas env vars (Loki, Telegram, log level)
- `src/engine/rebalancer.ts` — withContext() no cycle(), logs estruturados nas etapas chave
- `src/index.ts` — withContext() nos loops principais, métricas nos pontos de medição
- `src/dashboard/server.ts` — endpoint /metrics para Prometheus

---

## 1. Logger (`src/utils/logger.ts`)

### Formato de Saída

**Antes:**
```
[2026-03-12 14:30:45] INFO: [Activation] NFT #1998122 activated
```

**Depois:**
```json
{
  "timestamp": "2026-03-12T14:30:45.123Z",
  "level": "info",
  "message": "[Activation] NFT #1998122 activated",
  "userId": "google_123",
  "correlationId": "act_a1b2c3d4",
  "tokenId": 1998122,
  "chain": "base",
  "dex": "uniswap-v3",
  "service": "lpdeltaneutro"
}
```

### Comportamento

- Format do Winston injeta automaticamente campos do AsyncLocalStorage em todo log
- Logs fora de um withContext() continuam funcionando — sem campos extras
- Prefixos `[Activation]`, `[Cycle]` permanecem na message (migração incremental)
- `LOG_LEVEL` env var controla nível (default `info`)

### Transports

1. **Console** — JSON em prod (NODE_ENV=production), texto colorido em dev
2. **DailyRotateFile** — JSON estruturado (`logs/bot-%DATE%.log`, 14d retention, 20MB max)
3. **DailyRotateFile error** — só level error (`logs/error-%DATE%.log`, 14d retention)
4. **Loki** — winston-loki, ativado se LOKI_ENABLED=true. Labels: `{job: "lpdeltaneutro", environment: NODE_ENV}`

### priceLogger

Mantém separado, mesma lógica. Sem Loki (volume alto demais para free tier).

### logCycle()

Mantém assinatura, emite JSON e herda contexto do AsyncLocalStorage.

---

## 2. Correlation Context (`src/utils/correlation.ts`)

Baseado em AsyncLocalStorage nativo (Node.js 16+).

### Interface

```typescript
interface LogContext {
  userId?: string;
  correlationId?: string;
  tokenId?: number | string;
  chain?: string;
  dex?: string;
}
```

### API Exportada

| Função | Descrição |
|--------|-----------|
| `withContext(ctx, fn)` | Executa fn dentro de um contexto. Merge com contexto pai |
| `getLogContext()` | Retorna contexto atual ou {} |
| `generateCorrelationId(prefix?)` | Retorna `prefix_8chars` (ex: `reb_a1b2c3d4`) |

### Nesting

withContext({ userId }) → withContext({ tokenId }) → contexto final tem ambos. Campos internos sobrescrevem se conflitarem. Cleanup automático via AsyncLocalStorage.run().

---

## 3. Métricas Prometheus (`src/utils/metrics.ts`)

Lib: prom-client — registro default + coleta automática de métricas do processo.

### Métricas Operacionais (Categoria A)

| Métrica | Tipo | Labels | Descrição |
|---------|------|--------|-----------|
| `rebalances_total` | Counter | userId, chain, dex, trigger | Total de rebalances executados |
| `rebalance_errors_total` | Counter | userId, chain, dex, severity | Erros em rebalances |
| `lp_read_duration_seconds` | Histogram | chain, dex | Tempo de leitura de posição LP |
| `hedge_execution_duration_seconds` | Histogram | chain, dex | Tempo de execução do hedge na HL |
| `active_positions_count` | Gauge | userId | Posições ativas por usuário |

Labels trigger: timer, emergency, forced_close, forced_hedge, price_poller
Labels severity: warning, critical

### Endpoint

GET /metrics no Express (server.ts). Formato Prometheus text. Sem autenticação.

---

## 4. Alertas Telegram (`src/utils/alerts.ts`)

Lib: node-telegram-bot-api — só envio (polling desativado).

### API

| Função | Descrição |
|--------|-----------|
| `sendAlert(level, message, context?)` | Envia mensagem formatada |
| `notifyCriticalError(correlationId, error, context?)` | Atalho para erros críticos |

### Formato da Mensagem

```
🔴 CRITICAL — lpdeltaneutro

Rebalance falhou
User: google_123
Position: NFT #1998122 (base/uniswap-v3)
Correlation: reb_a1b2c3d4

Error: Insufficient margin
Stack: (primeiras 3 linhas)

2026-03-12 14:30:45 UTC
```

### Rate Limiting

- Máximo 1 alerta por minuto por chave (deduplica por message + userId + tokenId)
- Se exceder, agrupa e envia resumo
- Rate limit em memória (Map simples)

### Sem Configuração

Alertas silenciosamente ignorados (log warning uma vez no startup).

---

## 5. Config (`src/config.ts`)

### Novas Variáveis

```typescript
// Logging
logLevel: optionalEnv('LOG_LEVEL', 'info'),

// Loki
lokiEnabled: optionalEnv('LOKI_ENABLED', 'false').toLowerCase() === 'true',
lokiUrl: optionalEnv('LOKI_URL', 'http://localhost:3100'),
lokiTenantId: optionalEnv('LOKI_TENANT_ID', ''),
lokiUsername: optionalEnv('LOKI_USERNAME', ''),
lokiPassword: optionalEnv('LOKI_PASSWORD', ''),

// Telegram Alerts
telegramBotToken: optionalEnv('TELEGRAM_BOT_TOKEN', ''),
telegramChatId: optionalEnv('TELEGRAM_CHAT_ID', ''),
```

---

## 6. Integração nos Hot Paths

Apenas 4 arquivos recebem withContext() e métricas. Os demais ~20 arquivos continuam como estão — só ganham formato JSON automaticamente.

### src/index.ts

- `runCycleForUser()` — envolve com withContext({ userId })
- Loop de posições — withContext({ tokenId, chain, dex })
- LP reads — timer metricsLpReadDuration
- Ativação/desativação — atualiza gauge metricsActivePositions

### src/engine/rebalancer.ts

- `cycle()` — generateCorrelationId('reb') + withContext({ correlationId })
- Logs estruturados em cada etapa: start, LP read, hedge calc, execute, success/error
- Métricas: rebalancesTotal.inc(), rebalanceErrorsTotal.inc()
- Hedge execution — timer metricsHedgeDuration
- Catch — notifyCriticalError()

### src/hedge/hyperliquidExchange.ts

Sem withContext() — herda automaticamente do caller.

### src/dashboard/server.ts

Endpoint GET /metrics expondo prom-client register.

---

## 7. Dependências Novas

```json
{
  "winston-loki": "^6.1.3",
  "prom-client": "^15.1.0",
  "node-telegram-bot-api": "^0.66.0",
  "@types/node-telegram-bot-api": "^0.64.0"
}
```

---

## 8. Instruções Telegram Bot Setup

1. Abrir Telegram → buscar @BotFather → /newbot
2. Escolher nome e username para o bot
3. Copiar o token retornado → TELEGRAM_BOT_TOKEN
4. Enviar qualquer mensagem para o bot criado
5. Acessar https://api.telegram.org/bot<TOKEN>/getUpdates
6. Copiar chat.id do resultado → TELEGRAM_CHAT_ID

---

## 9. Grafana Cloud Setup

1. Criar conta em https://grafana.com (free tier)
2. Ir em Connections → Hosted Logs (Loki) → copiar URL, tenant ID, user ID
3. Criar API key com role Editor
4. Configurar .env:
   ```
   LOKI_ENABLED=true
   LOKI_URL=https://logs-prod-xxx.grafana.net
   LOKI_TENANT_ID=seu_tenant_id
   LOKI_USERNAME=seu_user_id_numerico
   LOKI_PASSWORD=sua_api_key
   ```
5. Para Prometheus: Connections → Hosted Metrics → configurar remote write ou scrape externo
6. Criar dashboards com queries LogQL:
   - Todos os logs: `{job="lpdeltaneutro"} | json`
   - Por usuário: `{job="lpdeltaneutro"} | json | userId="google_123"`
   - Jornada de rebalance: `{job="lpdeltaneutro"} | json | correlationId="reb_abc123xy"`
   - Só erros: `{job="lpdeltaneutro", level="error"} | json`
