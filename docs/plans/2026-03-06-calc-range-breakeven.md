# Calc Range Dual-Unit + Break-Even Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show range prices in both $ and % units inside the amber table rows, and add a Break-even column showing days of farm needed to recover a range-exit loss.

**Architecture:** Single-file change to `src/dashboard/public/index.html`. One CSS rule, one HTML attribute (`id` on `<thead>`), and JS changes inside the existing `runCalc()` function of the HEDGE CALCULATOR IIFE.

**Tech Stack:** Vanilla JS, HTML/CSS. No backend changes.

---

### Task 1: CSS + HTML — `.range-pct-hint` + `id="calc-thead"`

**File:** `src/dashboard/public/index.html`

**Step 1: Add CSS rule**

Inside the `<style>` block, append after the `.calc-field .t-in:disabled { ... }` rule (the last calc CSS rule):

```css
.range-pct-hint {
  font-size: 0.68rem;
  display: block;
  color: var(--amber);
  opacity: 0.85;
}
```

**Step 2: Add `id` to `<thead>`**

Find (around line 1113):
```html
                <table class="calc-result-table">
                  <thead>
```

Replace with:
```html
                <table class="calc-result-table">
                  <thead id="calc-thead">
```

**Step 3: Verify build**
```
cd "D:\Documentos\Trae\APRDeltaNeutov3" && npm run build
```
Expected: exit 0.

**Step 4: Commit**
```bash
git add src/dashboard/public/index.html
git commit -m "feat: calc range pct hint CSS + thead id"
```

---

### Task 2: JS — dual-unit price + break-even column in `runCalc`

**File:** `src/dashboard/public/index.html`

All changes are inside the `runCalc` function in the HEDGE CALCULATOR IIFE (search for `// ── HEDGE CALCULATOR`).

**Step 1: Hoist `daily` before the row render block**

Find this block (around line 2249 — the `// Render` comment and everything after it through the farm card):

```js
    // Render
    var tbody = document.getElementById('calc-tbody');
    tbody.innerHTML = rows.map(function (row) {
      var Pp = row.price;
      var lpPnl = row.isCurrent ? 0 : lpValue(L, Pp, Pa, Pb) - V;
      var hPnl = row.isCurrent ? 0 : hedgeUsd * (1 - Pp / P);
      var net = lpPnl + hPnl;

      var lpStr = row.isCurrent ? '—' : '<span style="color:' + pnlColor(lpPnl) + ';">' + fmtUsdPnl(lpPnl) + '</span>';
      var hStr = row.isCurrent ? '—' : '<span style="color:' + pnlColor(hPnl) + ';">' + fmtUsdPnl(hPnl) + '</span>';
      var netStr = row.isCurrent ? '—' : '<span style="color:' + pnlColor(net) + ';font-weight:bold;">' + fmtUsdPnl(net) + '</span>';
      var priceStr = '$' + Pp.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      var cls = row.isRange ? 'range-row' : (row.isCurrent ? 'current-row' : '');
      return '<tr class="' + cls + '"><td>' + row.label + '</td><td style="text-align:right;">' + priceStr + '</td><td>' + lpStr + '</td><td>' + hStr + '</td><td>' + netStr + '</td></tr>';
    }).join('');

    document.getElementById('calc-panel-title').textContent =
      hedgeModeState === 'auto' ? 'Cenários · AUTO HEDGE' : 'Cenários';

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
```

Replace with:

```js
    // Hoist daily so it's available for break-even inside row render
    var daily = apr > 0 ? V * (apr / 100) / 365 : 0;

    // Update thead — add Break-even column only when APR > 0
    document.getElementById('calc-thead').innerHTML =
      '<tr><th>Cenário</th><th>Preço</th><th>P&amp;L LP</th><th>P&amp;L Hedge</th><th>P&amp;L Líquido</th>' +
      (apr > 0 ? '<th>Break-even</th>' : '') + '</tr>';

    // Render
    var tbody = document.getElementById('calc-tbody');
    tbody.innerHTML = rows.map(function (row) {
      var Pp = row.price;
      var lpPnl = row.isCurrent ? 0 : lpValue(L, Pp, Pa, Pb) - V;
      var hPnl = row.isCurrent ? 0 : hedgeUsd * (1 - Pp / P);
      var net = lpPnl + hPnl;

      var lpStr = row.isCurrent ? '—' : '<span style="color:' + pnlColor(lpPnl) + ';">' + fmtUsdPnl(lpPnl) + '</span>';
      var hStr = row.isCurrent ? '—' : '<span style="color:' + pnlColor(hPnl) + ';">' + fmtUsdPnl(hPnl) + '</span>';
      var netStr = row.isCurrent ? '—' : '<span style="color:' + pnlColor(net) + ';font-weight:bold;">' + fmtUsdPnl(net) + '</span>';

      // Price cell: range rows show price + pct-from-current hint
      var pxFormatted = '$' + Pp.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      var pctFromCurrent = (Pp / P - 1) * 100;
      var pctSign = pctFromCurrent >= 0 ? '+' : '';
      var priceStr = pxFormatted + (row.isRange
        ? '<span class="range-pct-hint">' + pctSign + pctFromCurrent.toFixed(2) + '%</span>'
        : '');

      // Break-even cell: only for range rows with a loss, only when APR > 0
      var beStr = '—';
      if (row.isRange && apr > 0 && net < 0) {
        beStr = (Math.abs(net) / daily).toFixed(1) + ' dias';
      }
      var beTd = apr > 0 ? '<td>' + beStr + '</td>' : '';

      var cls = row.isRange ? 'range-row' : (row.isCurrent ? 'current-row' : '');
      return '<tr class="' + cls + '"><td>' + row.label + '</td><td style="text-align:right;">' + priceStr + '</td><td>' + lpStr + '</td><td>' + hStr + '</td><td>' + netStr + '</td>' + beTd + '</tr>';
    }).join('');

    document.getElementById('calc-panel-title').textContent =
      hedgeModeState === 'auto' ? 'Cenários · AUTO HEDGE' : 'Cenários';

    // Farm card (daily already computed above)
    if (apr > 0) {
      document.getElementById('calc-farm-value').textContent =
        '$' + daily.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
        ' / dia  (APR ' + apr + '%)';
      farmCard.style.display = 'flex';
    } else {
      farmCard.style.display = 'none';
    }

    resultsEl.style.display = '';
```

**Step 2: Verify build**
```
cd "D:\Documentos\Trae\APRDeltaNeutov3" && npm run build
```
Expected: exit 0.

**Step 3: Manual smoke test (mental verification)**

Scenario A — APR = 0:
- 6th column (`Break-even`) must NOT appear in the table header or rows
- Range rows still show `$X,XXX.XX` + amber `±YY.YY%` hint below

Scenario B — APR = 18, Range rows with net loss:
- Header has 6 columns: Cenário | Preço | P&L LP | P&L Hedge | P&L Líquido | Break-even
- Range rows show `X.X dias` in Break-even column
- Range rows with net gain show `—`
- Non-range rows all show `—` in Break-even

Scenario C — Price cell for range rows:
- RANGE MAX row: price cell shows `$2,200.00` then `+7.11%` in smaller amber text below
- RANGE MIN row: price cell shows `$1,800.00` then `−12.36%` in smaller amber text below
- Regular rows (e.g. +15%): price cell shows only `$X,XXX.XX` (no hint)

**Step 4: Commit**
```bash
git add src/dashboard/public/index.html
git commit -m "feat: calc range dual-unit hint + break-even column"
```
