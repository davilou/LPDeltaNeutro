# APRDeltaNeuto

Bot de hedging delta-neutro para posições Uniswap V3/V4 na Base Chain. Lê LP positions on-chain e executa hedges em perpétuos na Hyperliquid, disparado por movimento de preço do ativo volátil. Inclui dashboard de monitoramento e persistência no Supabase.

---

## Configuração

Copie `.env.example` para `.env` e preencha as variáveis:

```bash
cp .env.example .env
```

Variáveis principais:

```env
# RPC (use QuickNode, Alchemy ou outro provider)
WS_URL=wss://your-node.base-mainnet.example.com/your-key
HTTP_RPC_URL=https://mainnet.base.org
HTTP_RPC_URL_2=https://your-node.base-mainnet.example.com/your-key
HTTP_RPC_URL_3=https://base-rpc.publicnode.com

# Hedge
HEDGE_TOKEN=token0
HEDGE_SYMBOL=VIRTUAL-PERP

# Hyperliquid
HL_PRIVATE_KEY=0x...
HL_WALLET_ADDRESS=0x...

# Modo (true = sem ordens reais)
DRY_RUN=true

# Supabase (opcional — deixar em branco para desativar)
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_KEY=sb_secret_...
```

> Posições são ativadas pelo **dashboard** — não é necessário configurar `POOL_ADDRESS` ou `POSITION_NFT_ID` no `.env`.

---

## Rodando o bot

O bot é gerenciado via **PM2** — roda em background e reinicia automaticamente se cair.

### Primeira vez

```bash
npm install
npm run build
npx pm2 start ecosystem.config.js
npx pm2 save
```

### Após mudar código ou `.env`

```bash
npm run build && npx pm2 restart apr-delta-neuto
```

---

## Comandos PM2

```bash
npx pm2 status                           # ver se está online / quantos restarts
npx pm2 logs apr-delta-neuto             # logs em tempo real (Ctrl+C para sair)
npx pm2 logs apr-delta-neuto --lines 50  # últimas 50 linhas
npx pm2 restart apr-delta-neuto          # reiniciar
npx pm2 stop apr-delta-neuto             # parar
npx pm2 start ecosystem.config.js        # iniciar
```

> Os logs do Winston ficam em `logs/bot-YYYY-MM-DD.log`. Os logs do PM2 em `logs/pm2-out.log` e `logs/pm2-error.log`.

---

## Auto-start no Windows

O arquivo `start-bot.bat` pode ser adicionado à pasta Startup do Windows (`AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup`). O PM2 sobe automaticamente no login e retoma o bot.

Para reiniciar manualmente após reboot:

```bash
npx pm2 resurrect
```

---

## Dashboard

Acesse em `http://localhost:3001` enquanto o bot estiver rodando.

Porta configurável via `DASHBOARD_PORT` no `.env`.

Pelo dashboard é possível:
- Escanear carteira e descobrir posições Uniswap V3
- Ativar/desativar proteção por posição
- Ajustar parâmetros de estratégia em tempo real
- Resetar a base de P&L manualmente
- Acompanhar P&L virtual, funding acumulado e histórico de rebalances

---

## Estratégia

### Gatilhos de rebalance

O bot usa dois gatilhos para decidir quando rebalancear:

| Gatilho | Condição | Comportamento |
|---|---|---|
| **Price movement** | `\|preço atual − preço ref\| / preço ref > PRICE_MOVEMENT_THRESHOLD` | Rebalance normal, respeita cooldown |
| **Emergency** | Mesmo critério com `EMERGENCY_PRICE_MOVEMENT_THRESHOLD` | Bypassa cooldown |
| **Timer** | `TIME_REBALANCE_INTERVAL_MIN` minutos desde o último rebalance | Rebalance periódico |
| **Forced close** | LP saiu do range (`rangeStatus != 'in-range'`) | Fecha o hedge imediatamente |

O `preço ref` é o preço no momento do último rebalance executado (`lastRebalancePrice`), visível no dashboard em **Ref Price**.

### Parâmetros por posição (dashboard)

| Campo | Descrição |
|---|---|
| **Hedge Ratio** | Fração da exposição protegida. `0.8` = protege 80% dos tokens voláteis |
| **Cooldown (m)** | Tempo mínimo entre rebalances em minutos |
| **Price Move %** | % de variação de preço para acionar rebalance normal (ex: `0.05` = 5%) |
| **Emerg Price %** | % de variação de preço para emergency — bypassa cooldown (ex: `0.15` = 15%) |

### Parâmetros globais (`.env`)

| Variável | Descrição | Padrão |
|---|---|---|
| `COOLDOWN_SECONDS` | Cooldown mínimo entre rebalances | `14400` (4h) |
| `PRICE_MOVEMENT_THRESHOLD` | % de movimento de preço para rebalance normal | `0.05` (5%) |
| `EMERGENCY_PRICE_MOVEMENT_THRESHOLD` | % de movimento para emergency (bypassa cooldown) | `0.15` (15%) |
| `TIME_REBALANCE_INTERVAL_MIN` | Rebalance periódico por tempo (minutos, `0` = off) | `0` |
| `MAX_DAILY_REBALANCES` | Limite de ordens por dia | `150` |
| `MAX_HOURLY_REBALANCES` | Limite de ordens por hora | `7` |

---

## Supabase

Cada rebalance é gravado na tabela `rebalances` do Supabase (opcional). Para ativar:

1. Crie um projeto em [supabase.com](https://supabase.com)
2. Execute o schema SQL abaixo no **SQL Editor**
3. Preencha `SUPABASE_URL` e `SUPABASE_KEY` (secret key) no `.env`
4. Reinicie o bot

```sql
create table rebalances (
  id                  bigint generated always as identity primary key,
  created_at          timestamptz default now(),
  token_id            integer      not null,
  timestamp           timestamptz  not null,
  coin                text,
  action              text,
  avg_px              numeric,
  executed_sz         numeric,
  trade_value_usd     numeric,
  fee_usd             numeric,
  trade_pnl_usd       numeric,
  trigger_reason      text,
  is_emergency        boolean,
  from_size           numeric,
  to_size             numeric,
  from_notional       numeric,
  to_notional         numeric,
  token0_symbol       text,
  token0_amount       numeric,
  token1_symbol       text,
  token1_amount       numeric,
  range_status        text,
  total_pos_usd       numeric,
  price               numeric,
  funding_rate        numeric,
  net_delta           numeric,
  hl_equity           numeric,
  pnl_virtual_usd     numeric,
  pnl_virtual_pct     numeric,
  pnl_realized_usd    numeric,
  pnl_lp_fees_usd     numeric,
  pnl_funding_usd     numeric,
  pnl_hl_fees_usd     numeric,
  daily_count         integer,
  hedge_ratio         numeric
);
```

---

## Arquitetura

```
src/
├── index.ts          # Entry point, WebSocket + watchdog de reconexão
├── config.ts         # Env vars
├── types.ts          # Interfaces globais
├── lp/               # Leitura on-chain (Uniswap V3 + V4)
├── hedge/            # Cálculo de hedge + execução (Hyperliquid / Mock)
├── engine/           # Orquestração (rebalancer, threshold adaptativo)
├── pnl/              # Rastreamento de P&L virtual
├── db/               # Persistência Supabase
├── backtest/         # Simulação histórica com estratégias
├── dashboard/        # Express server + SSE + store de estado
└── utils/            # logger, fallbackProvider, safety
```
