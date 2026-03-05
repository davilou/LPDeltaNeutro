# Hedge Calculator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a CALCULATOR page to the dashboard sidebar with a Uniswap V3 LP + hedge PnL simulator.

**Architecture:** Single-file change to `src/dashboard/public/index.html`. New sidebar nav item, new page div, CSS for 2-column layout, and a self-contained JS `calcSection` block. No backend changes.

**Tech Stack:** Vanilla JS, HTML/CSS. Same design tokens as the existing dashboard (`--green`, `--red`, `--amber`, `--mono`, `--disp`, `.panel`, etc.).

---

### Task 1: Sidebar nav item + page skeleton + showPage update

**File:** `src/dashboard/public/index.html`

**Step 1: Add CALCULATOR to the sidebar nav** (line ~832, after HISTORY)

```html
<div class="sidebar-item" id="nav-calculator" onclick="showPage('calculator')">CALCULATOR</div>
```

**Step 2: Add `page-calculator` div skeleton** (line ~933, after `#page-history` closing tag)

```html
<!-- ── PAGE: CALCULATOR ──────────────────────────────────── -->
<div id="page-calculator" style="display:none;">
  <!-- content added in Task 2 & 3 -->
</div><!-- end #page-calculator -->
```

**Step 3: Add `'calculator'` to the pages array in `showPage()`** (line ~1001)

Change:
```js
['monitor', 'history', 'settings'].forEach(function (p) {
```
To:
```js
['monitor', 'history', 'calculator', 'settings'].forEach(function (p) {
```

**Step 4: Verify build**
```
npm run build
```
Expected: exit 0, no TS errors (no TS changes, just sanity check).

**Step 5: Commit**
```bash
git add src/dashboard/public/index.html
git commit -m "feat: add CALCULATOR page skeleton to sidebar"
```

---

### Task 2: CSS + inputs panel HTML

**File:** `src/dashboard/public/index.html`

**Step 1: Add CSS** inside the existing `<style>` block (append before the closing `</style>`)

```css
/* ══════════════════════════════════════
   CALCULATOR PAGE
══════════════════════════════════════ */
.calc-layout {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 12px;
  align-items: start;
}

.calc-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}

.calc-field label {
  font-size: 0.7rem;
  color: var(--tx-dim);
  letter-spacing: 1px;
  text-transform: uppercase;
}

.calc-field input {
  /* reuse .t-in styles — just extend */
  background: var(--surface2);
  border: 1px solid var(--bd-md);
  color: var(--tx);
  font-family: var(--mono);
  font-size: 0.85rem;
  padding: 6px 10px;
  border-radius: 3px;
  width: 100%;
  outline: none;
}

.calc-field input:focus {
  border-color: var(--bd-hi);
}

.calc-result-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}

.calc-result-table th {
  text-align: right;
  padding: 5px 10px;
  color: var(--tx-dim);
  font-size: 0.68rem;
  letter-spacing: 1px;
  border-bottom: 1px solid var(--bd);
}

.calc-result-table th:first-child { text-align: left; }

.calc-result-table td {
  padding: 5px 10px;
  text-align: right;
  border-bottom: 1px solid var(--bd);
  font-variant-numeric: tabular-nums;
}

.calc-result-table td:first-child { text-align: left; color: var(--tx-dim); }

.calc-result-table tr.range-row td {
  background: rgba(245, 158, 11, 0.07);
  color: var(--amber);
}

.calc-result-table tr.range-row td:first-child { color: var(--amber); font-weight: bold; }

.calc-result-table tr.current-row td {
  color: var(--tx-muted);
}

.calc-farm-card {
  margin-top: 12px;
  padding: 12px 16px;
  background: var(--surface2);
  border: 1px solid var(--bd-md);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.calc-farm-label {
  font-size: 0.7rem;
  color: var(--tx-dim);
  letter-spacing: 1px;
  text-transform: uppercase;
}

.calc-farm-value {
  font-family: var(--disp);
  font-size: 1rem;
  color: var(--green);
}
```

**Step 2: Replace the empty `page-calculator` div** with the full inputs panel

```html
<!-- ── PAGE: CALCULATOR ──────────────────────────────────── -->
<div id="page-calculator" style="display:none;">
  <div class="calc-layout">

    <!-- LEFT: Inputs -->
    <div class="panel">
      <div class="panel-title">Parâmetros</div>

      <div class="calc-field">
        <label>Pool Value (USD)</label>
        <input id="calc-poolValue" type="number" placeholder="30000" min="0" />
      </div>
      <div class="calc-field">
        <label>Current Price</label>
        <input id="calc-price" type="number" placeholder="2800" min="0" />
      </div>
      <div class="calc-field">
        <label>Range Min — Pa</label>
        <input id="calc-pa" type="number" placeholder="2400" min="0" />
      </div>
      <div class="calc-field">
        <label>Range Max — Pb</label>
        <input id="calc-pb" type="number" placeholder="3200" min="0" />
      </div>
      <div class="calc-field">
        <label>Hedge Size (USD notional)</label>
        <input id="calc-hedge" type="number" placeholder="15000" min="0" />
      </div>
      <div class="calc-field">
        <label>Pool APR (%)</label>
        <input id="calc-apr" type="number" placeholder="18" min="0" />
      </div>

      <button class="btn" style="width:100%;margin-top:4px;" onclick="runCalc()">CALCULATE</button>
      <div id="calc-error" style="margin-top:8px;font-size:0.75rem;color:var(--red);min-height:16px;"></div>
    </div>

    <!-- RIGHT: Results -->
    <div>
      <div class="panel" id="calc-results" style="display:none;">
        <div class="panel-title">Cenários</div>
        <div style="overflow-x:auto;">
          <table class="calc-result-table">
            <thead>
              <tr>
                <th>Cenário</th>
                <th>Preço</th>
                <th>P&amp;L LP</th>
                <th>P&amp;L Hedge</th>
                <th>P&amp;L Líquido</th>
              </tr>
            </thead>
            <tbody id="calc-tbody"></tbody>
          </table>
        </div>
        <div class="calc-farm-card" id="calc-farm-card" style="display:none;">
          <span class="calc-farm-label">Farm Diário Estimado</span>
          <span class="calc-farm-value" id="calc-farm-value">—</span>
        </div>
      </div>
    </div>

  </div>
</div><!-- end #page-calculator -->
```

**Step 3: Verify build**
```
npm run build
```
Expected: exit 0.

**Step 4: Commit**
```bash
git add src/dashboard/public/index.html
git commit -m "feat: calculator page layout, inputs panel and results skeleton"
```

---

### Task 3: JavaScript — math + render

**File:** `src/dashboard/public/index.html`

**Step 1: Add `runCalc` and helpers** inside the `<script>` block, just before the closing `</script>` tag (after `connectSSE()`).

```js
// ── HEDGE CALCULATOR ─────────────────────────────────────
(function () {
  // Uniswap V3: compute liquidity L from pool value and price bounds
  function computeL(V, P, Pa, Pb) {
    var sp = Math.sqrt(P), spa = Math.sqrt(Pa), spb = Math.sqrt(Pb);
    // V = L * (sp*(spb-sp)/spb + sp - spa)
    return V / (sp * (spb - sp) / spb + sp - spa);
  }

  // LP value at new price P' given liquidity L and bounds
  function lpValue(L, Pp, Pa, Pb) {
    if (Pp <= Pa) {
      // fully volatile token
      var spa = Math.sqrt(Pa), spb = Math.sqrt(Pb);
      return L * (1 / spa - 1 / spb) * Pp;
    }
    if (Pp >= Pb) {
      // fully stable
      var spb2 = Math.sqrt(Pb), spa2 = Math.sqrt(Pa);
      return L * (spb2 - spa2);
    }
    var sp2 = Math.sqrt(Pp), spb3 = Math.sqrt(Pb), spa3 = Math.sqrt(Pa);
    return L * (sp2 * (spb3 - sp2) / spb3 + sp2 - spa3);
  }

  function fmtUsd(v) {
    var sign = v >= 0 ? '+' : '';
    return sign + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function pnlColor(v) {
    if (Math.abs(v) < 0.005) return 'var(--tx-muted)';
    return v >= 0 ? 'var(--green)' : 'var(--red)';
  }

  window.runCalc = function () {
    var errEl = document.getElementById('calc-error');
    var resultsEl = document.getElementById('calc-results');
    var farmCard = document.getElementById('calc-farm-card');
    errEl.textContent = '';

    var V = parseFloat(document.getElementById('calc-poolValue').value);
    var P = parseFloat(document.getElementById('calc-price').value);
    var Pa = parseFloat(document.getElementById('calc-pa').value);
    var Pb = parseFloat(document.getElementById('calc-pb').value);
    var H = parseFloat(document.getElementById('calc-hedge').value) || 0;
    var apr = parseFloat(document.getElementById('calc-apr').value) || 0;

    if (!V || !P || !Pa || !Pb || Pa >= Pb || P <= 0 || Pa <= 0) {
      errEl.textContent = 'Preencha todos os campos com valores válidos (Pa < Pb).';
      resultsEl.style.display = 'none';
      return;
    }
    if (P < Pa || P > Pb) {
      errEl.textContent = 'Preço atual deve estar dentro do range (Pa ≤ P ≤ Pb).';
      resultsEl.style.display = 'none';
      return;
    }

    var L = computeL(V, P, Pa, Pb);

    // Fixed percentage rows
    var pcts = [-0.15, -0.10, -0.05, 0, 0.05, 0.10, 0.15];
    var rows = pcts.map(function (pct) {
      return { label: pct === 0 ? 'Atual' : (pct > 0 ? '+' : '') + (pct * 100).toFixed(0) + '%', price: P * (1 + pct), isRange: false, isCurrent: pct === 0 };
    });

    // Insert range rows
    rows.push({ label: '▼ RANGE MIN', price: Pa, isRange: true, isCurrent: false });
    rows.push({ label: '▲ RANGE MAX', price: Pb, isRange: true, isCurrent: false });

    // Sort by price ascending
    rows.sort(function (a, b) { return a.price - b.price; });

    // Render
    var tbody = document.getElementById('calc-tbody');
    tbody.innerHTML = rows.map(function (row) {
      var Pp = row.price;
      var lpPnl = row.isCurrent ? 0 : lpValue(L, Pp, Pa, Pb) - V;
      var hPnl = row.isCurrent ? 0 : H * (1 - Pp / P);
      var net = lpPnl + hPnl;

      var lpStr = row.isCurrent ? '—' : '<span style="color:' + pnlColor(lpPnl) + ';">' + fmtUsd(lpPnl) + '</span>';
      var hStr = row.isCurrent ? '—' : '<span style="color:' + pnlColor(hPnl) + ';">' + fmtUsd(hPnl) + '</span>';
      var netStr = row.isCurrent ? '—' : '<span style="color:' + pnlColor(net) + ';font-weight:bold;">' + fmtUsd(net) + '</span>';
      var priceStr = '$' + Pp.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      var cls = row.isRange ? 'range-row' : (row.isCurrent ? 'current-row' : '');
      return '<tr class="' + cls + '"><td>' + row.label + '</td><td style="text-align:right;">' + priceStr + '</td><td>' + lpStr + '</td><td>' + hStr + '</td><td>' + netStr + '</td></tr>';
    }).join('');

    // Farm card
    if (apr > 0) {
      var daily = V * (apr / 100) / 365;
      document.getElementById('calc-farm-value').textContent =
        '$' + daily.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
        ' / dia  (APR ' + apr + '%)';
      farmCard.style.display = 'flex';
    } else {
      farmCard.style.display = 'none';
    }

    resultsEl.style.display = '';
  };
})();
// ─────────────────────────────────────────────────────────
```

**Step 2: Verify build**
```
npm run build
```
Expected: exit 0.

**Step 3: Manual smoke test**
- Open dashboard → click CALCULATOR
- Input: Pool Value=30000, Price=2800, Pa=2400, Pb=3200, Hedge=15000, APR=18
- Click CALCULATE
- Verify: table appears with 9 rows (7 pct + Pa + Pb), Pa row amber, Pb row amber, farm card shows ~$14.79/dia
- Verify: row order is price ascending (Pa ~2400 near -15% area, Pb ~3200 near +15% area)
- Verify: P&L values green/red appropriately

**Step 4: Commit**
```bash
git add src/dashboard/public/index.html
git commit -m "feat: hedge calculator — math engine and scenario table"
```
