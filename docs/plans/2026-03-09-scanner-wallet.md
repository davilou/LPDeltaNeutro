# Scanner Wallet — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Criar aba SCANNER no dashboard para escanear todas as chains/DEXes em paralelo, persistir resultados por usuário, e ativar proteção diretamente pela tela.

**Architecture:** Novo endpoint `POST /api/scan-wallet-all` executa `Promise.allSettled` em todas as combinações chain+dex do `chainRegistry`, filtra `estimatedUsd > 10`, persiste em `state-{userId}.json` via `BotState.scannedPositions`. Frontend: nova aba com sub-tabs EVM/Solana, tabela de posições, modal de ativação com toggle AUTO/MANUAL de hedge.

**Tech Stack:** TypeScript strict, ethers.js v6, Express v5, SSE, vanilla JS (sem frameworks no frontend)

---

### Task 1: Estender BotState com campos de scan

**Files:**
- Modify: `src/types.ts:148-151`

**Step 1: Adicionar campos ao BotState**

```typescript
export interface BotState {
  positions: Record<string, PositionState>;
  history?: HistoricalPosition[];
  scannedPositions?: DiscoveredPosition[];
  scannedAt?: number;
  scannedNetwork?: 'evm' | 'solana';
  scannedWallet?: string;
}
```

Substituir o bloco atual (linhas 148-151):
```typescript
// antes
export interface BotState {
  positions: Record<string, PositionState>;
  history?: HistoricalPosition[];
}
```

**Step 2: Verificar import de DiscoveredPosition em types.ts**

`DiscoveredPosition` está em `src/lp/types.ts`. Importar com `import type` para evitar circular dependency:

```typescript
import type { DiscoveredPosition } from './lp/types';
```

Adicionar no topo de `src/types.ts` (logo após os imports existentes).

**Step 3: Type-check**

```bash
npx tsc --noEmit
```

Esperado: sem erros.

**Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat(scanner): extend BotState with scannedPositions fields"
```

---

### Task 2: Adicionar métodos de scan ao Rebalancer

**Files:**
- Modify: `src/engine/rebalancer.ts`

**Step 1: Adicionar método saveScannedPositions**

Logo após o método `saveState()` (linha ~224), adicionar:

```typescript
saveScannedPositions(
  positions: import('../lp/types').DiscoveredPosition[],
  network: 'evm' | 'solana',
  wallet: string,
): void {
  this.state.scannedPositions = positions;
  this.state.scannedAt = Date.now();
  this.state.scannedNetwork = network;
  this.state.scannedWallet = wallet;
  this.saveState();
}

getScannedPositions(): {
  positions: import('../lp/types').DiscoveredPosition[];
  scannedAt?: number;
  scannedNetwork?: 'evm' | 'solana';
  scannedWallet?: string;
} {
  return {
    positions: this.state.scannedPositions ?? [],
    scannedAt: this.state.scannedAt,
    scannedNetwork: this.state.scannedNetwork,
    scannedWallet: this.state.scannedWallet,
  };
}
```

**Step 2: Type-check**

```bash
npx tsc --noEmit
```

Esperado: sem erros.

**Step 3: Commit**

```bash
git add src/engine/rebalancer.ts
git commit -m "feat(scanner): add saveScannedPositions/getScannedPositions to Rebalancer"
```

---

### Task 3: Adicionar scanProgress ao DashboardStore e atualizar discovered-positions

**Files:**
- Modify: `src/dashboard/store.ts`

**Step 1: Adicionar método emitScanProgress**

Logo após o método `setDiscoveredPositions` (linha ~137), adicionar:

```typescript
emitScanProgress(payload: { done: number; total: number; chain?: string }): void {
  this.emit('scanProgress', payload);
}
```

**Step 2: Adicionar scanProgress ao listener SSE em server.ts**

Em `src/dashboard/server.ts`, dentro do handler `GET /api/events` (linha ~384), adicionar:

```typescript
const onScanProgress = (payload: unknown) => {
  res.write(`event: scanProgress\ndata: ${JSON.stringify(payload)}\n\n`);
};

store.on('scanProgress', onScanProgress);
// ...no req.on('close'):
store.off('scanProgress', onScanProgress);
```

**Step 3: Atualizar GET /api/discovered-positions**

Substituir o handler atual (linhas 164-167):

```typescript
// antes
app.get('/api/discovered-positions', (req, res) => {
  const store = getStoreForUser(req.session.userId!);
  res.json(store.getDiscoveredPositions());
});
```

Por:

```typescript
app.get('/api/discovered-positions', (req, res) => {
  const userId = req.session.userId!;
  const ctx = getOrCreateEngineContext(userId);
  const { positions, scannedAt, scannedNetwork, scannedWallet } =
    ctx.rebalancer.getScannedPositions();

  // Marcar posições já ativas pelo usuário
  const activeTokenIds = new Set(Object.keys(ctx.rebalancer.getState().positions));
  const withStatus = positions.map(p => ({
    ...p,
    isActive: activeTokenIds.has(String(p.tokenId)),
  }));

  res.json({ positions: withStatus, scannedAt, scannedNetwork, scannedWallet });
});
```

Nota: `getOrCreateEngineContext` já está importado em server.ts. Verificar que `ctx.rebalancer.getState()` está acessível (método público já existe ou adicionar getter público em rebalancer.ts: `getState(): BotState { return this.state; }`).

**Step 4: Type-check**

```bash
npx tsc --noEmit
```

**Step 5: Commit**

```bash
git add src/dashboard/store.ts src/dashboard/server.ts src/engine/rebalancer.ts
git commit -m "feat(scanner): scanProgress SSE event + persist-aware discovered-positions endpoint"
```

---

### Task 4: Novo endpoint POST /api/scan-wallet-all

**Files:**
- Modify: `src/dashboard/server.ts`

**Step 1: Adicionar helper de combinações EVM**

No topo de server.ts (após imports existentes), adicionar:

```typescript
import { isChainDexSupported } from '../lp/chainRegistry';

const EVM_CHAIN_DEX_COMBOS: Array<{ chain: ChainId; dex: DexId }> = [
  { chain: 'base',          dex: 'uniswap-v3'  },
  { chain: 'base',          dex: 'uniswap-v4'  },
  { chain: 'base',          dex: 'aerodrome-cl' },
  { chain: 'eth',           dex: 'uniswap-v3'  },
  { chain: 'eth',           dex: 'uniswap-v4'  },
  { chain: 'eth',           dex: 'pancake-v3'  },
  { chain: 'bsc',           dex: 'uniswap-v3'  },
  { chain: 'bsc',           dex: 'uniswap-v4'  },
  { chain: 'bsc',           dex: 'pancake-v3'  },
  { chain: 'arbitrum',      dex: 'uniswap-v3'  },
  { chain: 'arbitrum',      dex: 'uniswap-v4'  },
  { chain: 'arbitrum',      dex: 'pancake-v3'  },
  { chain: 'polygon',       dex: 'uniswap-v3'  },
  { chain: 'polygon',       dex: 'uniswap-v4'  },
  { chain: 'polygon',       dex: 'pancake-v3'  },
  { chain: 'avalanche',     dex: 'uniswap-v3'  },
  { chain: 'avalanche',     dex: 'uniswap-v4'  },
  { chain: 'hyperliquid-l1', dex: 'project-x' },
].filter(({ chain, dex }) => isChainDexSupported(chain, dex));

const SOLANA_DEX_COMBOS: DexId[] = ['orca', 'raydium', 'meteora'];
```

**Step 2: Adicionar endpoint scan-wallet-all**

Logo após o endpoint `/api/scan-wallet` existente (linha ~193), adicionar:

```typescript
app.post('/api/scan-wallet-all', async (req, res) => {
  const { walletAddress, network } = req.body as {
    walletAddress?: string;
    network?: 'evm' | 'solana';
  };

  const isEvmAddr    = /^0x[0-9a-fA-F]{40}$/.test(walletAddress ?? '');
  const isSolanaAddr = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress ?? '');

  if (!walletAddress || !network) {
    res.status(400).json({ error: 'walletAddress and network required' });
    return;
  }
  if (network === 'evm' && !isEvmAddr) {
    res.status(400).json({ error: 'Invalid EVM address' });
    return;
  }
  if (network === 'solana' && !isSolanaAddr) {
    res.status(400).json({ error: 'Invalid Solana address' });
    return;
  }

  const userId = req.session.userId!;
  const store  = getStoreForUser(userId);
  const ctx    = getOrCreateEngineContext(userId);

  logger.info(`[Scanner] scan-all network=${network} addr=${walletAddress}`);

  try {
    const combos = network === 'evm' ? EVM_CHAIN_DEX_COMBOS
      : SOLANA_DEX_COMBOS.map(dex => ({ chain: 'solana' as ChainId, dex }));

    const total = combos.length;
    let done = 0;
    const allPositions: import('../lp/types').DiscoveredPosition[] = [];
    const seen = new Set<string>();

    const tasks = combos.map(async ({ chain, dex }) => {
      try {
        const scanner = createWalletScanner(chain, dex);
        const found   = await scanner.scanWallet(walletAddress);
        for (const p of found) {
          const key = `${p.tokenId}:${chain}:${dex}`;
          if (!seen.has(key)) {
            seen.add(key);
            allPositions.push(p);
          }
        }
      } catch (err) {
        logger.warn(`[Scanner] ${chain}:${dex} failed — ${err}`);
      } finally {
        done++;
        store.emitScanProgress({ done, total, chain: `${chain}:${dex}` });
      }
    });

    await Promise.allSettled(tasks);

    const filtered = allPositions.filter(p => p.estimatedUsd > 10);
    ctx.rebalancer.saveScannedPositions(filtered, network, walletAddress);
    store.setDiscoveredPositions(filtered);

    res.json({ count: filtered.length, positions: filtered });
  } catch (err) {
    logger.error(`[Scanner] scan-all failed: ${err}`);
    res.status(500).json({ error: 'Scan failed', detail: String(err) });
  }
});
```

**Step 3: Type-check**

```bash
npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/dashboard/server.ts
git commit -m "feat(scanner): POST /api/scan-wallet-all — parallel scan all chains+dex, filter >$10, persist"
```

---

### Task 5: Frontend — aba SCANNER (estrutura HTML + CSS)

**Files:**
- Modify: `src/dashboard/public/index.html`

**Step 1: Adicionar item SCANNER na nav lateral**

Localizar o bloco `<nav>` com os itens de navegação (contém `data-tab="monitor"`, `data-tab="history"`, etc.) e adicionar após o último item (SETTINGS):

```html
<li>
  <button class="nav-item" data-tab="scanner" onclick="showTab('scanner')">
    <span class="nav-icon">⬡</span>
    <span class="nav-label">SCANNER</span>
  </button>
</li>
```

**Step 2: Adicionar seção SCANNER**

Localizar onde as seções das abas são definidas (próximo à seção `id="section-settings"`) e adicionar:

```html
<!-- ===================== SCANNER ===================== -->
<section id="section-scanner" class="tab-section" style="display:none">
  <div class="scanner-container">
    <div class="scanner-subtabs">
      <button class="scanner-subtab active" id="subtab-evm" onclick="setScannerNetwork('evm')">EVM</button>
      <button class="scanner-subtab" id="subtab-solana" onclick="setScannerNetwork('solana')">SOLANA</button>
    </div>

    <div class="scanner-input-row">
      <input
        type="text"
        id="scanner-wallet-input"
        class="scanner-wallet-input"
        placeholder="0x... ou endereço Solana"
        autocomplete="off"
        spellcheck="false"
      />
      <button class="scanner-scan-btn" id="scanner-scan-btn" onclick="startScan()">SCAN</button>
    </div>

    <div id="scanner-progress" class="scanner-progress" style="display:none">
      <div class="scanner-progress-bar">
        <div class="scanner-progress-fill" id="scanner-progress-fill"></div>
      </div>
      <span id="scanner-progress-text">Escaneando...</span>
    </div>

    <div id="scanner-last-update" class="scanner-last-update" style="display:none"></div>

    <div id="scanner-empty" class="scanner-empty" style="display:none">
      Nenhuma posição encontrada com valor superior a $10.
    </div>

    <table class="scanner-table" id="scanner-table" style="display:none">
      <thead>
        <tr>
          <th>Par</th>
          <th>DEX · Chain</th>
          <th>Status</th>
          <th>Range USD</th>
          <th>Valor</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="scanner-tbody"></tbody>
    </table>
  </div>
</section>

<!-- Modal de Proteção -->
<div id="protect-modal-overlay" class="modal-overlay" style="display:none" onclick="closeProtectModal()">
  <div class="modal-box" onclick="event.stopPropagation()">
    <div class="modal-header">
      <span id="protect-modal-title">Proteger Posição</span>
      <button class="modal-close" onclick="closeProtectModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="modal-info-row"><span>Par</span><span id="pm-pair"></span></div>
      <div class="modal-info-row"><span>DEX · Chain</span><span id="pm-dex-chain"></span></div>
      <div class="modal-info-row"><span>Range</span><span id="pm-range"></span></div>
      <div class="modal-info-row"><span>Valor</span><span id="pm-value"></span></div>

      <div class="modal-divider"></div>

      <div class="modal-field">
        <label>Hedge Token</label>
        <select id="pm-hedge-token">
          <option value="token0" id="pm-token0-opt"></option>
          <option value="token1" id="pm-token1-opt"></option>
        </select>
      </div>

      <div class="modal-field">
        <label>Hedge Size</label>
        <div class="hedge-size-row">
          <button class="hedge-mode-btn active" id="pm-btn-auto" onclick="setHedgeMode('auto')">AUTO</button>
          <button class="hedge-mode-btn" id="pm-btn-manual" onclick="setHedgeMode('manual')">MANUAL</button>
          <input type="number" id="pm-hedge-pct" min="0" max="200" step="1" value="100" />
          <span>%</span>
        </div>
      </div>

      <div class="modal-field">
        <label>Cooldown (min)</label>
        <input type="number" id="pm-cooldown" value="720" min="1" />
      </div>

      <div class="modal-field">
        <label>Emergency (%)</label>
        <input type="number" id="pm-emergency" value="15" min="1" max="100" />
      </div>

      <div class="modal-field modal-field-inline">
        <label>Dry Run</label>
        <input type="checkbox" id="pm-dryrun" />
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn-secondary" onclick="closeProtectModal()">CANCELAR</button>
      <button class="btn-primary" onclick="submitProtection()">ATIVAR PROTEÇÃO</button>
    </div>
  </div>
</div>
```

**Step 3: Adicionar CSS para o scanner**

Localizar o bloco `<style>` do documento e adicionar ao final (antes de `</style>`):

```css
/* ===== SCANNER ===== */
.scanner-container { padding: 24px; max-width: 960px; }

.scanner-subtabs { display: flex; gap: 4px; margin-bottom: 20px; }
.scanner-subtab {
  padding: 8px 24px; border: 1px solid var(--border);
  background: transparent; color: var(--text-dim);
  cursor: pointer; border-radius: 4px; font-size: 12px; font-weight: 600;
  letter-spacing: 0.05em; text-transform: uppercase;
}
.scanner-subtab.active { background: var(--accent); color: #000; border-color: var(--accent); }

.scanner-input-row { display: flex; gap: 8px; margin-bottom: 16px; }
.scanner-wallet-input {
  flex: 1; padding: 10px 14px; background: var(--card-bg);
  border: 1px solid var(--border); border-radius: 4px;
  color: var(--text); font-family: monospace; font-size: 13px;
}
.scanner-wallet-input:focus { outline: none; border-color: var(--accent); }
.scanner-scan-btn {
  padding: 10px 28px; background: var(--accent); color: #000;
  border: none; border-radius: 4px; font-weight: 700;
  letter-spacing: 0.08em; cursor: pointer; font-size: 12px;
}
.scanner-scan-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.scanner-progress { margin-bottom: 12px; }
.scanner-progress-bar { height: 4px; background: var(--border); border-radius: 2px; margin-bottom: 6px; }
.scanner-progress-fill { height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.2s; width: 0%; }
#scanner-progress-text { font-size: 11px; color: var(--text-dim); }

.scanner-last-update { font-size: 11px; color: var(--text-dim); margin-bottom: 16px; }
.scanner-empty { color: var(--text-dim); font-size: 13px; padding: 32px 0; }

.scanner-table { width: 100%; border-collapse: collapse; }
.scanner-table th {
  text-align: left; font-size: 11px; color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.05em;
  padding: 8px 12px; border-bottom: 1px solid var(--border);
}
.scanner-table td { padding: 12px; border-bottom: 1px solid var(--border-dim, #222); font-size: 13px; }
.scanner-table tr:hover td { background: rgba(255,255,255,0.02); }

.range-badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 600;
}
.range-badge.in-range  { background: rgba(0,200,100,0.12); color: #00c864; }
.range-badge.above-range { background: rgba(255,180,0,0.12); color: #ffb400; }
.range-badge.below-range { background: rgba(255,80,80,0.12); color: #ff5050; }

.btn-protect {
  padding: 6px 16px; background: var(--accent); color: #000;
  border: none; border-radius: 3px; font-size: 11px; font-weight: 700;
  cursor: pointer; letter-spacing: 0.05em;
}
.badge-protected {
  display: inline-block; padding: 4px 10px;
  background: rgba(0,200,100,0.12); color: #00c864;
  border-radius: 3px; font-size: 11px; font-weight: 600;
}

/* Modal */
.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.7);
  display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.modal-box {
  background: var(--card-bg, #1a1a1a); border: 1px solid var(--border);
  border-radius: 8px; width: 420px; max-width: 95vw;
}
.modal-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 16px 20px; border-bottom: 1px solid var(--border);
  font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
}
.modal-close { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 16px; }
.modal-body { padding: 20px; display: flex; flex-direction: column; gap: 14px; }
.modal-info-row {
  display: flex; justify-content: space-between;
  font-size: 12px; color: var(--text-dim);
}
.modal-info-row span:last-child { color: var(--text); font-weight: 500; }
.modal-divider { border-top: 1px solid var(--border); }
.modal-field { display: flex; flex-direction: column; gap: 6px; }
.modal-field label { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }
.modal-field input, .modal-field select {
  padding: 8px 10px; background: var(--bg, #111); border: 1px solid var(--border);
  border-radius: 4px; color: var(--text); font-size: 13px;
}
.modal-field-inline { flex-direction: row; align-items: center; justify-content: space-between; }
.hedge-size-row { display: flex; align-items: center; gap: 6px; }
.hedge-size-row input { width: 80px; }
.hedge-mode-btn {
  padding: 4px 10px; background: transparent; border: 1px solid var(--border);
  color: var(--text-dim); cursor: pointer; border-radius: 3px; font-size: 11px; font-weight: 600;
}
.hedge-mode-btn.active { background: var(--accent); color: #000; border-color: var(--accent); }
.modal-footer {
  display: flex; justify-content: flex-end; gap: 10px;
  padding: 16px 20px; border-top: 1px solid var(--border);
}
.btn-primary {
  padding: 8px 20px; background: var(--accent); color: #000;
  border: none; border-radius: 4px; font-weight: 700; cursor: pointer; font-size: 12px;
}
.btn-secondary {
  padding: 8px 20px; background: transparent; color: var(--text-dim);
  border: 1px solid var(--border); border-radius: 4px; cursor: pointer; font-size: 12px;
}
```

**Step 4: Type-check + build**

```bash
npx tsc --noEmit
```

**Step 5: Commit**

```bash
git add src/dashboard/public/index.html
git commit -m "feat(scanner): SCANNER tab HTML structure, table, protect modal, CSS"
```

---

### Task 6: Frontend — lógica JavaScript da aba SCANNER

**Files:**
- Modify: `src/dashboard/public/index.html` (bloco `<script>`)

**Step 1: Adicionar variáveis de estado do scanner**

No bloco `<script>` principal, após as variáveis globais existentes, adicionar:

```javascript
// ===== SCANNER STATE =====
let scannerNetwork = 'evm';
let scannerPositions = [];
let protectModalData = null;
let hedgeMode = 'auto'; // 'auto' | 'manual'
let scanProgressTotal = 0;
let scanProgressDone = 0;
```

**Step 2: Adicionar funções do scanner**

```javascript
function setScannerNetwork(network) {
  scannerNetwork = network;
  document.getElementById('subtab-evm').classList.toggle('active', network === 'evm');
  document.getElementById('subtab-solana').classList.toggle('active', network === 'solana');
  document.getElementById('scanner-wallet-input').placeholder =
    network === 'evm' ? '0x...' : 'Endereço Solana (base58)';
}

async function startScan() {
  const addr = document.getElementById('scanner-wallet-input').value.trim();
  if (!addr) return;

  const btn = document.getElementById('scanner-scan-btn');
  btn.disabled = true;

  // Reset progress
  scanProgressDone = 0;
  scanProgressTotal = scannerNetwork === 'evm' ? 18 : 3; // combos totais
  updateScanProgress();
  document.getElementById('scanner-progress').style.display = '';
  document.getElementById('scanner-table').style.display = 'none';
  document.getElementById('scanner-empty').style.display = 'none';

  try {
    const res = await fetch('/api/scan-wallet-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: addr, network: scannerNetwork }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    renderScannerTable(data.positions);
  } catch (err) {
    alert('Erro no scan: ' + err.message);
  } finally {
    btn.disabled = false;
    document.getElementById('scanner-progress').style.display = 'none';
  }
}

function updateScanProgress() {
  const pct = scanProgressTotal ? (scanProgressDone / scanProgressTotal) * 100 : 0;
  document.getElementById('scanner-progress-fill').style.width = pct + '%';
  document.getElementById('scanner-progress-text').textContent =
    `Escaneando... ${scanProgressDone}/${scanProgressTotal}`;
}

function renderScannerTable(positions) {
  scannerPositions = positions || [];
  const tbody = document.getElementById('scanner-tbody');
  tbody.innerHTML = '';

  if (!scannerPositions.length) {
    document.getElementById('scanner-empty').style.display = '';
    document.getElementById('scanner-table').style.display = 'none';
    return;
  }

  document.getElementById('scanner-table').style.display = '';
  document.getElementById('scanner-empty').style.display = 'none';

  for (const p of scannerPositions) {
    const rangeLabel = p.rangeStatus === 'in-range' ? '✓ In Range'
      : p.rangeStatus === 'above-range' ? '↑ Above'
      : '↓ Below';
    const rangeCls = p.rangeStatus;

    const priceLow  = tickToUsd(p.tickLower,  p.token0Decimals, p.token1Decimals);
    const priceHigh = tickToUsd(p.tickUpper,  p.token0Decimals, p.token1Decimals);
    const rangeStr  = `$${fmt(priceLow)} — $${fmt(priceHigh)}`;

    const actionHtml = p.isActive
      ? `<span class="badge-protected">✓ PROTEGIDA</span>`
      : `<button class="btn-protect" onclick="openProtectModal('${p.tokenId}')">▶ PROTECT</button>`;

    const dexChain = `${dexLabel(p.dex)} · ${chainLabel(p.chain)}`;

    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td>${p.token0Symbol}/${p.token1Symbol}</td>
        <td>${dexChain}</td>
        <td><span class="range-badge ${rangeCls}">${rangeLabel}</span></td>
        <td>${rangeStr}</td>
        <td>$${fmt(p.estimatedUsd)}</td>
        <td>${actionHtml}</td>
      </tr>
    `);
  }
}

function tickToUsd(tick, dec0, dec1) {
  // tick → raw ratio → adjust decimals
  const raw = Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
  return raw > 0 ? 1 / raw : 0; // assumes token1 is stablecoin
}

function dexLabel(dex) {
  const map = {
    'uniswap-v3': 'Uni V3', 'uniswap-v4': 'Uni V4',
    'pancake-v3': 'Cake V3', 'pancake-v4': 'Cake V4',
    'aerodrome-cl': 'Aero', 'project-x': 'ProjX',
    'orca': 'Orca', 'raydium': 'Raydium', 'meteora': 'Meteora',
  };
  return map[dex] || dex;
}

function chainLabel(chain) {
  const map = {
    'base': 'Base', 'eth': 'ETH', 'bsc': 'BSC',
    'arbitrum': 'Arb', 'polygon': 'Poly', 'avalanche': 'Avax',
    'hyperliquid-l1': 'HyperEVM', 'solana': 'Solana',
  };
  return map[chain] || chain;
}

function fmt(n) {
  if (!n && n !== 0) return '—';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1)    return n.toFixed(2);
  return n.toFixed(4);
}

// ===== MODAL DE PROTEÇÃO =====
function openProtectModal(tokenId) {
  const p = scannerPositions.find(x => String(x.tokenId) === String(tokenId));
  if (!p) return;
  protectModalData = p;

  document.getElementById('pm-pair').textContent = `${p.token0Symbol}/${p.token1Symbol}`;
  document.getElementById('pm-dex-chain').textContent = `${dexLabel(p.dex)} · ${chainLabel(p.chain)}`;

  const priceLow  = tickToUsd(p.tickLower, p.token0Decimals, p.token1Decimals);
  const priceHigh = tickToUsd(p.tickUpper, p.token0Decimals, p.token1Decimals);
  document.getElementById('pm-range').textContent = `$${fmt(priceLow)} — $${fmt(priceHigh)}`;
  document.getElementById('pm-value').textContent  = `$${fmt(p.estimatedUsd)}`;
  document.getElementById('protect-modal-title').textContent = `Proteger Posição #${tokenId}`;

  // Preencher dropdown de hedge token
  document.getElementById('pm-token0-opt').textContent = `${p.token0Symbol} (token0)`;
  document.getElementById('pm-token0-opt').value = 'token0';
  document.getElementById('pm-token1-opt').textContent = `${p.token1Symbol} (token1)`;
  document.getElementById('pm-token1-opt').value = 'token1';

  // Default: hedge no token volátil (assume token0 = volátil se token1 = stablecoin)
  const t1Lower = (p.token1Symbol || '').toLowerCase();
  const isT1Stable = ['usdc','usdt','dai','busd','usd','tusd'].some(s => t1Lower.includes(s));
  document.getElementById('pm-hedge-token').value = isT1Stable ? 'token0' : 'token1';

  // Reset hedge mode
  setHedgeMode('auto');
  document.getElementById('pm-cooldown').value = 720;
  document.getElementById('pm-emergency').value = 15;
  document.getElementById('pm-dryrun').checked = false;

  document.getElementById('protect-modal-overlay').style.display = 'flex';
}

function closeProtectModal() {
  document.getElementById('protect-modal-overlay').style.display = 'none';
  protectModalData = null;
}

function setHedgeMode(mode) {
  hedgeMode = mode;
  document.getElementById('pm-btn-auto').classList.toggle('active', mode === 'auto');
  document.getElementById('pm-btn-manual').classList.toggle('active', mode === 'manual');
  const input = document.getElementById('pm-hedge-pct');
  if (mode === 'auto') {
    input.value = calcAutoHedge(protectModalData);
    input.readOnly = true;
    input.style.opacity = '0.5';
  } else {
    input.readOnly = false;
    input.style.opacity = '1';
  }
}

function calcAutoHedge(p) {
  if (!p) return 100;
  // H = (lpPnlUp − lpPnlDown) × P / (Pb − Pa)
  // Simplified: for symmetric range, ~50% is neutral; use 100 as safe default
  // Full formula requires LP math — return 100 until calculator module available
  return 100;
}

async function submitProtection() {
  const p = protectModalData;
  if (!p) return;

  const hedgeToken   = document.getElementById('pm-hedge-token').value;
  const hedgeRatio   = parseFloat(document.getElementById('pm-hedge-pct').value) / 100;
  const cooldown     = parseInt(document.getElementById('pm-cooldown').value, 10) * 60;
  const emergency    = parseFloat(document.getElementById('pm-emergency').value) / 100;
  const dryRun       = document.getElementById('pm-dryrun').checked;

  // Derive hedgeSymbol from chosen hedge token
  const hedgeSymbol = hedgeToken === 'token0' ? p.token0Symbol : p.token1Symbol;

  const payload = {
    tokenId:          typeof p.tokenId === 'string' ? p.tokenId : Number(p.tokenId),
    protocolVersion:  p.protocolVersion,
    poolAddress:      p.poolAddress,
    token0Symbol:     p.token0Symbol,
    token1Symbol:     p.token1Symbol,
    fee:              p.fee,
    tickLower:        p.tickLower,
    tickUpper:        p.tickUpper,
    chain:            p.chain,
    dex:              p.dex,
    positionId:       p.tokenId,
    hedgeToken,
    hedgeRatio,
    cooldownSeconds:  cooldown,
    emergencyPriceMovementThreshold: emergency,
    dryRun,
  };

  try {
    const res = await fetch('/api/activate-position', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(await res.text());
    closeProtectModal();
    // Marcar como protegida na tabela
    const row = scannerPositions.find(x => String(x.tokenId) === String(p.tokenId));
    if (row) row.isActive = true;
    renderScannerTable(scannerPositions);
  } catch (err) {
    alert('Erro ao ativar: ' + err.message);
  }
}
```

**Step 3: Conectar evento SSE scanProgress**

No handler de SSE existente (onde `evtSource.addEventListener('positionsDiscovered', ...)` está), adicionar:

```javascript
evtSource.addEventListener('scanProgress', e => {
  const d = JSON.parse(e.data);
  scanProgressDone = d.done;
  scanProgressTotal = d.total;
  updateScanProgress();
});
```

**Step 4: Carregar posições persistidas ao abrir a aba**

Na função `showTab` (ou equivalente que ativa abas), adicionar ao case 'scanner':

```javascript
if (tab === 'scanner') {
  loadPersistedScannedPositions();
}
```

Implementar:

```javascript
async function loadPersistedScannedPositions() {
  try {
    const res = await fetch('/api/discovered-positions');
    if (!res.ok) return;
    const data = await res.json();
    if (data.positions && data.positions.length) {
      renderScannerTable(data.positions);
      if (data.scannedAt) {
        const dt = new Date(data.scannedAt).toLocaleString('pt-BR');
        const el = document.getElementById('scanner-last-update');
        el.textContent = `Última atualização: ${dt}`;
        el.style.display = '';
        if (data.scannedWallet) {
          document.getElementById('scanner-wallet-input').value = data.scannedWallet;
        }
        if (data.scannedNetwork) {
          setScannerNetwork(data.scannedNetwork);
        }
      }
    }
  } catch (_) {}
}
```

**Step 5: Type-check + build**

```bash
npx tsc --noEmit
npm run build
```

Esperado: sem erros.

**Step 6: Commit**

```bash
git add src/dashboard/public/index.html
git commit -m "feat(scanner): SCANNER tab JS — scan-all, progress, table render, protect modal, persist reload"
```

---

### Task 7: Verificação final

**Step 1: Build limpo**

```bash
npm run build
```

Esperado: saída sem erros em `dist/`.

**Step 2: Smoke test manual**

1. Abrir dashboard → aba SCANNER aparece na nav lateral
2. Sub-tab EVM/SOLANA muda placeholder do input
3. Inserir wallet EVM → clicar SCAN → barra de progresso avança → tabela aparece (ou msg vazia)
4. Reload da página → posições persistidas recarregam automaticamente, wallet pré-preenchida
5. Clicar ▶ PROTECT → modal abre com dados corretos
6. Modal: toggle AUTO/MANUAL funciona; ATIVAR chama `/api/activate-position`
7. Após ativar: badge ✓ PROTEGIDA aparece na linha

**Step 3: Commit final**

```bash
git add -A
git commit -m "feat(scanner): scanner wallet tab complete — multi-chain scan, persist, protect modal"
```
