# Auto Hedge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an AUTO mode to the Hedge Size field that calculates the optimal hedge percentage to equalize P&L at both range extremes (Range MAX and Range MIN).

**Architecture:** Single-file change to `src/dashboard/public/index.html`. HTML toggle on the Hedge Size field (same pattern as USD/% range toggles), one CSS rule, and JS logic added to the existing IIFE. No backend changes.

**Tech Stack:** Vanilla JS, HTML/CSS. Closed-form math — no iteration needed.

---

### Task 1: HTML + CSS — toggle on Hedge Size field

**File:** `src/dashboard/public/index.html`

**Step 1: Replace the Hedge Size `calc-field` div** (lines 1085–1088)

Old:
```html
            <div class="calc-field">
              <label>Hedge Size (%)</label>
              <input id="calc-hedge" type="number" class="t-in" placeholder="100" min="0" max="200" />
            </div>
```

New:
```html
            <div class="calc-field">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <label style="margin-bottom:0;">Hedge Size (%)</label>
                <div class="range-mode-toggle" id="hedge-mode-toggle">
                  <span class="range-mode-btn active" onclick="setHedgeMode('manual',this)">MANUAL</span>
                  <span class="range-mode-btn" onclick="setHedgeMode('auto',this)">AUTO</span>
                </div>
              </div>
              <input id="calc-hedge" type="number" class="t-in" placeholder="100" min="0" max="200" />
            </div>
```

**Step 2: Add `id` to the results panel title** (line 1101)

Old:
```html
              <div class="panel-title">Cenários</div>
```

New:
```html
              <div class="panel-title" id="calc-panel-title">Cenários</div>
```

**Step 3: Add CSS rule** inside the existing `<style>` block, appended just before the closing `</style>` tag. Find the last line of the calc CSS block (`.calc-farm-value { ... }`) and append after it:

```css
.calc-field .t-in:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

**Step 4: Verify build**
```
npm run build
```
Expected: exit 0.

**Step 5: Commit**
```bash
git add src/dashboard/public/index.html
git commit -m "feat: auto hedge toggle HTML/CSS"
```

---

### Task 2: JavaScript — `setHedgeMode` + `runCalc` auto logic

**File:** `src/dashboard/public/index.html`

**Step 1: Add `hedgeModeState` variable** inside the IIFE, right after `var pbModeState = 'usd';` (line ~2127)

Old:
```js
  var paModeState = 'usd';
  var pbModeState = 'usd';
```

New:
```js
  var paModeState = 'usd';
  var pbModeState = 'usd';
  var hedgeModeState = 'manual';
```

**Step 2: Add `setHedgeMode` function** right after the closing `};` of `setRangeMode` (line ~2138)

```js
  window.setHedgeMode = function (mode, el) {
    hedgeModeState = mode;
    var toggle = document.getElementById('hedge-mode-toggle');
    toggle.querySelectorAll('.range-mode-btn').forEach(function (btn) { btn.classList.remove('active'); });
    el.classList.add('active');
    var input = document.getElementById('calc-hedge');
    input.disabled = mode === 'auto';
    if (mode === 'auto') input.value = '';
  };
```

**Step 3: Update `runCalc` — replace the `hedgePct` read and `hedgeUsd` compute block**

Old (lines ~2185 and ~2201–2202):
```js
    var hedgePct = parseFloat(document.getElementById('calc-hedge').value) || 0;
    var apr = parseFloat(document.getElementById('calc-apr').value) || 0;

    if (!(V > 0) || !(P > 0) || !(Pa > 0) || !(Pb > 0) || Pa >= Pb) {
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
    // Volatile token amount at current price, then hedge notional in USD
    var xTokens = L * (1 / Math.sqrt(P) - 1 / Math.sqrt(Pb));
    var hedgeUsd = xTokens * P * (hedgePct / 100);
```

New:
```js
    var apr = parseFloat(document.getElementById('calc-apr').value) || 0;

    if (!(V > 0) || !(P > 0) || !(Pa > 0) || !(Pb > 0) || Pa >= Pb) {
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
    var xTokens = L * (1 / Math.sqrt(P) - 1 / Math.sqrt(Pb));

    var hedgePct;
    if (hedgeModeState === 'auto') {
      var lpPnlUp = lpValue(L, Pb, Pa, Pb) - V;
      var lpPnlDown = lpValue(L, Pa, Pa, Pb) - V;
      var H = (lpPnlUp - lpPnlDown) * P / (Pb - Pa);
      var safeX = xTokens > 0 ? xTokens : 1e-9;
      hedgePct = Math.max(0, H / (safeX * P) * 100);
      document.getElementById('calc-hedge').value = hedgePct.toFixed(2);
      if (H <= 0) errEl.textContent = 'Auto Hedge: range não requer hedge para equalizar extremos (H ≤ 0).';
    } else {
      hedgePct = parseFloat(document.getElementById('calc-hedge').value) || 0;
    }
    var hedgeUsd = xTokens * P * (hedgePct / 100);
```

**Step 4: Update panel title in `runCalc`** — add one line right before the `// Farm card` comment (line ~2234)

```js
    document.getElementById('calc-panel-title').textContent =
      hedgeModeState === 'auto' ? 'Cenários · AUTO HEDGE' : 'Cenários';
```

**Step 5: Verify build**
```
npm run build
```
Expected: exit 0.

**Step 6: Manual smoke test**

- Open dashboard → CALCULATOR
- Input: Pool Value=30000, Price=2800, Pa=2400, Pb=3200, APR=18
- Toggle Hedge Size to AUTO → input becomes disabled, value clears
- Click CALCULATE
- Verify: input shows a computed % (e.g. ~63.x), panel title shows "Cenários · AUTO HEDGE"
- Verify: Range MAX row and Range MIN row have approximately equal P&L Líquido values
- Toggle back to MANUAL → input becomes editable, panel title resets to "Cenários"

**Step 7: Commit**
```bash
git add src/dashboard/public/index.html
git commit -m "feat: auto hedge — calculates optimal hedge % to equalize range extremes"
```
