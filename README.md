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

# Modo (true = sem ordens reais)
DRY_RUN=true

# Supabase (obrigatório para multi-usuário)
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_KEY=sb_secret_...
SUPABASE_POSTGRES_URL=postgresql://postgres:[senha]@[host]:5432/postgres

# Google OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=https://seudominio.com/auth/callback
SESSION_SECRET=<openssl rand -hex 32>
CREDENTIAL_ENCRYPTION_KEY=<openssl rand -hex 32>
ALLOWED_EMAILS=               # opcional; vazio = qualquer conta Google
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

O dashboard requer **login via Google**. Cada conta Google tem seu próprio espaço isolado — posições, P&L e histórico separados por usuário.

### Páginas

| Aba | Descrição |
|---|---|
| **MONITOR** | Posições ativas, métricas de P&L em tempo real, gráfico de net delta e tabela de rebalances |
| **HISTORY** | Histórico de posições encerradas com P&L consolidado |
| **CALCULATOR** | Simulador de cenários: calcula P&L da LP + hedge para movimentos de ±5/10/15% e saídas de range |
| **SETTINGS** | Configuração das credenciais da Hyperliquid |

### Funcionalidades

- Escanear carteira ou buscar posição diretamente pelo NFT token ID
- Ativar/desativar proteção por posição
- Monitorar múltiplas posições simultaneamente — cada posição tem seu próprio card de métricas
- Ajustar parâmetros de estratégia por posição em tempo real (Hedge Ratio, Cooldown, Emergency threshold)
- Resetar a base de P&L manualmente
- Acompanhar P&L isolado (dados reais da HL API): LP P&L, LP Fees, Unrealized, Realized, Funding, HL Fees
- **Hedge Calculator**: simular posições antes de ativar — define range em USD ou em % do preço atual, hedge size como % da exposição volátil, APR para estimativa de farm diário

---

## Estratégia

### Gatilhos de rebalance

| Gatilho | Condição | Comportamento |
|---|---|---|
| **Timer/Cooldown** | `REBALANCE_INTERVAL_MIN` minutos desde o último rebalance | Rebalance periódico; também age como cooldown mínimo |
| **Emergency** | `\|preço atual − preço ref\| / preço ref > EMERGENCY_PRICE_MOVEMENT_THRESHOLD` | Bypassa cooldown |
| **Forced close** | LP acima do range (100% stablecoin) | Fecha o hedge imediatamente |
| **Forced hedge** | LP abaixo do range (100% token volátil) | Aumenta hedge ao target imediatamente |

O `preço ref` é o preço no momento do último rebalance (`lastRebalancePrice`), visível no dashboard em **Ref Price**. Se for `0` (posição recém-ativada), o gatilho emergency não dispara — aguarda timer ou forced.

### Parâmetros por posição (dashboard)

| Campo | Descrição |
|---|---|
| **Hedge Ratio** | Fração da exposição protegida. `0.8` = protege 80% dos tokens voláteis |
| **Cooldown (m)** | Cooldown mínimo entre rebalances em minutos (sobrescreve `REBALANCE_INTERVAL_MIN` para essa posição) |
| **Price Move %** | % de variação de preço para acionar emergency — bypassa cooldown (ex: `0.15` = 15%) |

### Parâmetros globais (`.env`)

| Variável | Descrição | Padrão |
|---|---|---|
| `REBALANCE_INTERVAL_MIN` | Intervalo de rebalance periódico **e** cooldown mínimo entre rebalances (minutos) | `720` (12h) |
| `EMERGENCY_PRICE_MOVEMENT_THRESHOLD` | % de movimento de preço para emergency (bypassa cooldown) | `0.15` (15%) |
| `MAX_DAILY_REBALANCES` | Limite de ordens por dia | `10` |

---

## Supabase

O Supabase é **obrigatório** para o modo multi-usuário. Cada rebalance, posição encerrada e ativação de proteção são persistidos por `user_id`.

### Setup

1. Crie um projeto em [supabase.com](https://supabase.com)
2. Execute o schema SQL abaixo no **SQL Editor**
3. Preencha `SUPABASE_URL`, `SUPABASE_KEY` e `SUPABASE_POSTGRES_URL` no `.env`
4. Reinicie o bot

### Schema SQL

```sql
-- Usuários (Google OAuth)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_id TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  hl_private_key_enc TEXT,
  hl_private_key_iv TEXT,
  hl_private_key_tag TEXT,
  hl_wallet_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Snapshot de ativação de proteção
CREATE TABLE protection_activations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token_id INTEGER NOT NULL,
  pool_address TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  token0_symbol TEXT NOT NULL,
  token1_symbol TEXT NOT NULL,
  token0_amount NUMERIC NOT NULL DEFAULT 0,
  token1_amount NUMERIC NOT NULL DEFAULT 0,
  initial_lp_usd NUMERIC NOT NULL DEFAULT 0,
  initial_lp_fees_usd NUMERIC NOT NULL DEFAULT 0,
  initial_timestamp BIGINT NOT NULL,
  fee INTEGER,
  tick_lower INTEGER,
  tick_upper INTEGER,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, token_id)
);
CREATE INDEX idx_protection_activations_user_id ON protection_activations(user_id);

-- Posições encerradas
CREATE TABLE closed_positions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  token_id INTEGER NOT NULL,
  pool_address TEXT,
  protocol_version TEXT,
  token0_symbol TEXT,
  token1_symbol TEXT,
  fee INTEGER,
  tick_lower INTEGER,
  tick_upper INTEGER,
  hedge_symbol TEXT,
  activated_at TIMESTAMPTZ NOT NULL,
  deactivated_at TIMESTAMPTZ NOT NULL,
  initial_lp_usd NUMERIC,
  initial_hl_usd NUMERIC,
  final_lp_fees_usd NUMERIC,
  final_cumulative_funding_usd NUMERIC,
  final_cumulative_hl_fees_usd NUMERIC,
  final_virtual_pnl_usd NUMERIC,
  final_virtual_pnl_pct NUMERIC,
  final_unrealized_pnl_usd NUMERIC,
  final_realized_pnl_usd NUMERIC
);
CREATE INDEX idx_closed_positions_user_id ON closed_positions(user_id);

-- Rebalances
CREATE TABLE rebalances (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  token_id INTEGER NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  coin TEXT,
  action TEXT,
  avg_px NUMERIC,
  executed_sz NUMERIC,
  trade_value_usd NUMERIC,
  fee_usd NUMERIC,
  trade_pnl_usd NUMERIC,
  trigger_reason TEXT,
  is_emergency BOOLEAN,
  from_size NUMERIC,
  to_size NUMERIC,
  from_notional NUMERIC,
  to_notional NUMERIC,
  token0_symbol TEXT,
  token0_amount NUMERIC,
  token1_symbol TEXT,
  token1_amount NUMERIC,
  range_status TEXT,
  total_pos_usd NUMERIC,
  price NUMERIC,
  funding_rate NUMERIC,
  net_delta NUMERIC,
  hl_equity NUMERIC,
  pnl_virtual_usd NUMERIC,
  pnl_virtual_pct NUMERIC,
  pnl_realized_usd NUMERIC,
  pnl_lp_fees_usd NUMERIC,
  pnl_funding_usd NUMERIC,
  pnl_hl_fees_usd NUMERIC,
  daily_count INTEGER,
  hedge_ratio NUMERIC
);
CREATE INDEX idx_rebalances_user_id ON rebalances(user_id);
```

---

## Arquitetura

```
src/
├── index.ts          # Entry point, WebSocket + watchdog de reconexão, multi-user engine map
├── config.ts         # Env vars
├── types.ts          # Interfaces globais
├── auth/             # Google OAuth, sessões, encrypt/decrypt de credenciais HL
├── lp/               # Leitura on-chain (Uniswap V3 + V4)
├── hedge/            # Cálculo de hedge + execução (Hyperliquid / Mock)
├── engine/           # Orquestração (rebalancer)
├── pnl/              # Rastreamento de P&L (dados reais da HL API)
├── db/               # Persistência Supabase
├── backtest/         # Simulação histórica com estratégias
├── dashboard/        # Express server + SSE + store de estado
└── utils/            # logger, fallbackProvider, safety
```
