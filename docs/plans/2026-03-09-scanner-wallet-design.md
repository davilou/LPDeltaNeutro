# Scanner Wallet — Design Doc

**Data:** 2026-03-09
**Status:** Aprovado

## Objetivo

Criar a 5ª aba **SCANNER** no dashboard para que o usuário possa escanear todas as chains/DEXes suportadas de uma só vez, visualizar suas posições de liquidez (> $10 USD), e ativar proteção diretamente na tela — sem precisar re-escanear a cada reload.

---

## Arquitetura

### Backend

#### Novo endpoint: `POST /api/scan-wallet-all`

```typescript
// Request
{ walletAddress: string, network: 'evm' | 'solana' }

// Response
{ positions: DiscoveredPosition[], scannedAt: number }
```

- **EVM**: itera todas as combinações `chain+dex` suportadas em `chainRegistry` em paralelo via `Promise.allSettled`. Falhas individuais ignoradas silenciosamente (ex: chain offline).
- **Solana**: chama `SolanaScannerImpl` para Orca + Raydium + Meteora em paralelo.
- Agrega resultados, filtra `estimatedUsd > 10`, remove duplicatas por `tokenId`.
- Persiste em `state-{userId}.json` como `scannedPositions: DiscoveredPosition[]` + `scannedAt: number`.
- Requer `requireAuth` middleware.

#### Endpoint existente: `GET /api/discovered-positions`

- Passa a ler de `state-{userId}.json` (não mais só memória).
- Retorna `{ positions, scannedAt }`.

### Frontend

Nova aba **SCANNER** adicionada à navegação lateral do `index.html`.

---

## UI — Aba SCANNER

### Layout

```
[ MONITOR ] [ HISTORY ] [ CALCULATOR ] [ SETTINGS ] [ SCANNER ]

┌─────────────────────────────────────────────────────────────┐
│  ┌──────────┐ ┌─────────┐                                   │
│  │   EVM    │ │ SOLANA  │  ← sub-tabs                       │
│  └──────────┘ └─────────┘                                   │
│                                                             │
│  Wallet: [0x...________________________] [SCAN]             │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Par        │ DEX · Chain    │ Range USD   │ USD  │    │   │
│  │ ETH/USDC   │ Univ3 · Base   │ $1800–$2200 │ $420 │ ▶  │   │
│  │ BTC/USDC   │ Cake · BSC     │ $60k–$70k   │ $180 │ ✓  │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  Última atualização: 09/03/2026 14:32                       │
└─────────────────────────────────────────────────────────────┘
```

### Colunas da tabela

| Coluna | Fonte |
|--------|-------|
| Par | `token0Symbol / token1Symbol` |
| DEX · Chain | `dex` + `chain` |
| Range status | ícone colorido: ✓ in-range, ↑ above, ↓ below |
| Range USD | tick→USD calculado no frontend |
| Valor estimado | `estimatedUsd` |
| Ação | `▶ PROTECT` ou badge `✓ PROTEGIDA` |

### Estado da ação por posição

- `▶ PROTECT` — tokenId não está nas posições ativas do usuário
- `✓ PROTEGIDA` (badge verde, sem botão) — tokenId já existe em `activePositions` do `state-{userId}.json`

A verificação ocorre no backend ao retornar `GET /api/discovered-positions`: adiciona campo `isActive: boolean` em cada posição.

### Durante o scan

- Spinner + texto "Escaneando N chains..." com contador de progresso via SSE event `scanProgress`.
- Ao finalizar: tabela populada, timestamp atualizado.

---

## Modal de Proteção

Aberto ao clicar `▶ PROTECT`. Campos pré-preenchidos com dados da posição; usuário configura apenas estratégia.

```
┌─── Proteger Posição #12345 ────────────────────────┐
│                                                    │
│  Par:    ETH / USDC                                │
│  DEX:    Uniswap V3 · Base                         │
│  Range:  $1,800 — $2,200                           │
│  Valor:  $420                                      │
│                                                    │
│  Hedge Token:  [ ETH (token0) ▼ ]                  │
│  Hedge Size:   [ AUTO ▼ ] [  42  ] %               │
│                 ↑ toggle MANUAL / AUTO             │
│  Cooldown:     [ 720 ] min                         │
│  Emergency:    [  15 ] %                           │
│  Dry Run:      [ ] Sim  [✓] Não                    │
│                                                    │
│  [CANCELAR]               [ATIVAR PROTEÇÃO]        │
└────────────────────────────────────────────────────┘
```

- `chain`, `dex`, `poolAddress`, `tokenId` enviados automaticamente.
- Toggle AUTO/MANUAL: igual ao da aba CALCULATOR — em AUTO, % calculado analiticamente (`H = (lpPnlUp − lpPnlDown) × P / (Pb − Pa)`), campo read-only.
- Botão ATIVAR chama endpoint existente de ativação.

---

## Persistência

### `state-{userId}.json` — novos campos

```typescript
interface UserState {
  // ... campos existentes ...
  scannedPositions?: DiscoveredPosition[];
  scannedAt?: number;          // Unix timestamp ms
  scannedNetwork?: 'evm' | 'solana';
  scannedWallet?: string;      // último endereço escaneado
}
```

Sem nova tabela Supabase. Posições escaneadas são dados voláteis (re-scan a qualquer hora).

---

## Fluxo Completo

```
Usuário abre aba SCANNER
  → GET /api/discovered-positions
    → retorna scannedPositions do state-{userId}.json (ou lista vazia)
    → cada posição tem isActive: boolean

Usuário insere wallet + clica SCAN
  → POST /api/scan-wallet-all { walletAddress, network }
    → SSE: scanProgress events
    → Promise.allSettled em todos os chain+dex
    → filtra estimatedUsd > 10
    → persiste em state-{userId}.json
    → retorna DiscoveredPosition[]

Usuário clica ▶ PROTECT
  → Modal abre com dados pré-preenchidos
  → Usuário configura hedge token, size (AUTO/MANUAL), cooldown, emergency, dry-run
  → Clica ATIVAR → POST /api/activate (endpoint existente)
  → Modal fecha, posição muda para ✓ PROTEGIDA
```

---

## Arquivos Afetados

### Backend
- `src/dashboard/server.ts` — novo endpoint `POST /api/scan-wallet-all`, atualizar `GET /api/discovered-positions`
- `src/dashboard/store.ts` — persistir `scannedPositions` + `scannedAt` em state.json
- `src/engine/rebalancer.ts` — `loadState`/`saveState` incluem novos campos

### Frontend
- `src/dashboard/public/index.html` — nova aba SCANNER (sub-tabs EVM/Solana, tabela, modal de proteção)

### Sem alterações necessárias
- `src/lp/scanners/` — scanners existentes já funcionam
- `src/lp/walletScannerFactory.ts` — factory existente já roteada corretamente
