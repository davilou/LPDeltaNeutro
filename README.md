# APRDeltaNeuto

Bot de hedging delta-neutro para posições Uniswap V3 na Base Chain. Lê LP positions on-chain, calcula delta mismatch e executa hedges em perpétuos na Hyperliquid.

---

## Configuração

Copie `.env.example` (ou edite `.env` diretamente) com as variáveis necessárias:

```env
# RPC
ALCHEMY_API_KEY=...
ALCHEMY_WS_URL=wss://base-mainnet.g.alchemy.com/v2/

# Posição
POOL_ADDRESS=0x...
POSITION_NFT_ID=123456

# Hedge
HEDGE_TOKEN=token0
HEDGE_SYMBOL=VIRTUAL-PERP

# Hyperliquid
HL_PRIVATE_KEY=0x...
HL_WALLET_ADDRESS=0x...

# Modo
DRY_RUN=true
```

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

> Os logs do Winston continuam em `logs/bot-YYYY-MM-DD.log`. Os logs do PM2 (stdout/stderr) ficam em `logs/pm2-out.log` e `logs/pm2-error.log`.

---

## Auto-start no Windows

O arquivo `start-bot.bat` foi adicionado à pasta Startup do Windows (`AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup`). O PM2 sobe automaticamente no login e retoma o bot.

Para reiniciar manualmente após reboot sem logar novamente:

```bash
npx pm2 resurrect
```

---

## Dashboard

Acesse em `http://localhost:3000` enquanto o bot estiver rodando.

Porta configurável via `DASHBOARD_PORT` no `.env`.

---

## Estratégia

### Threshold adaptativo por gamma

Ranges estreitos têm gamma alto (delta muda rapidamente com o preço), causando rebalances excessivos. O threshold se ajusta automaticamente:

```
effectiveThreshold = DELTA_MISMATCH_THRESHOLD × (ADAPTIVE_REFERENCE_TICK_RANGE / tickRange)
```

Ativar no `.env`:

```env
ADAPTIVE_THRESHOLD=true
ADAPTIVE_REFERENCE_TICK_RANGE=2040   # tick range da sua posição atual
ADAPTIVE_MAX_THRESHOLD=0.35          # teto máximo do threshold
```

### Guia de Parâmetros (Configuração Individual por Posição)

Ao clicar em **CONFIGURE** no Dashboard para uma posição descoberta, você pode ajustar os seguintes parâmetros:

*   **Hedge Ratio (head-ratio)**: Define a porcentagem de proteção da sua exposição ao ativo volátil. 
    *   *Exemplo:* Se você tem $1000 em ETH no par ETH/USDC e o Hedge Ratio é **0.80**, o bot abrirá uma posição vendida (short) de **$800** na Hyperliquid. Isso significa que você está 80% protegido contra quedas.
*   **Rebalance Interval (rebal-int)**: É um intervalo forçado (em minutos) para o bot ajustar o hedge por tempo, independente da mudança de preço.
    *   *Uso:* Se definido como **60**, a cada 1 hora o bot fará um ajuste fino na posição para corrigir pequenos desvios ("drift") que o threshold normal de preço não pegou. (Use **0** para desativar).
*   **Delta Threshold (delta-thrash)**: A sensibilidade do bot para rebalancear conforme o preço muda.
    *   *Uso:* Se definido como **0.08**, o bot só enviará uma ordem de ajuste se a diferença entre o hedge atual e o hedge necessário for maior que **8%**. Valores menores (ex: 0.03) tornam o bot mais sensível e ativo, mas podem gastar mais taxas.
*   **Emergency Threshold (emergence-thrash)**: Um "gatilho de pânico" para movimentos violentos do mercado.
    *   *Uso:* Se o desvio (mismatch) ultrapassar esse valor (ex: **0.60** ou 60%), o bot considera uma emergência. Ele **ignora o tempo de espera (cooldown)** e rebalanceia a posição imediatamente para evitar perdas maiores.
*   **Emergency Hedge Ratio (emergence-head-ratio)**: Define o tamanho do ajuste durante uma emergência.
    *   *Uso:* Em movimentos muito rápidos, fechar 100% do desvio pode ser ineficiente por causa do slippage. Se definido como **0.50**, em uma emergência o bot fechará **metade** do buraco (gap) em uma única ordem rápida, repetindo o ciclo conforme necessário.

### Parâmetros Globais (.env)

| Variável | Descrição | Padrão |
|---|---|---|
| `DELTA_MISMATCH_THRESHOLD` | % de mismatch padrão para acionar rebalance | `0.08` |
| `COOLDOWN_SECONDS` | Tempo mínimo obrigatório entre rebalances normais | `14400` (4h) |
| `MAX_DAILY_REBALANCES` | Limite de segurança de ordens por dia | `150` |
| `MAX_HOURLY_REBALANCES` | Limite de segurança de ordens por hora | `7` |
| `EMERGENCY_MISMATCH_THRESHOLD` | Threshold para bypass do cooldown (Emergência) | `0.75` |
| `TIME_REBALANCE_INTERVAL_MIN` | Rebalance periódico por tempo (minutos) | `240` |
| `TIME_REBALANCE_MIN_MISMATCH` | Mismatch mínimo ignorado pelo rebalance por tempo | `0.03` |

---

## Arquitetura

```
src/
├── index.ts          # Entry point, WebSocket + watchdog de reconexão
├── config.ts         # Env vars
├── types.ts          # Interfaces globais
├── lp/               # Leitura on-chain (Uniswap V3)
├── hedge/            # Cálculo de hedge + execução (Hyperliquid / Mock)
├── engine/           # Orquestração (rebalancer, threshold adaptativo)
├── pnl/              # Rastreamento de P&L
├── backtest/         # Simulação histórica
├── dashboard/        # Express server + SSE + store de estado
└── utils/            # logger, fallbackProvider, safety
```
