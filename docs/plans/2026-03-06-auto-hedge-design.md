# Auto Hedge — Design Doc
_Date: 2026-03-06_

## Overview

Novo modo **Auto Hedge** na calculadora. Quando ativo, calcula automaticamente o tamanho ideal do hedge para que o P&L líquido seja igual nos dois extremos do range (Range MAX e Range MIN), criando proteção simétrica.

## Trigger

Acionado pelo botão CALCULATE (mesmo fluxo atual). Não há recálculo em tempo real.

## Matemática

```
lpPnl_up   = lpValue(L, Pb, Pa, Pb) - V      # P&L LP ao sair pelo topo
lpPnl_down = lpValue(L, Pa, Pa, Pb) - V      # P&L LP ao sair pelo fundo

Condição de igualdade:
  lpPnl_up + H*(1 - Pb/P) = lpPnl_down + H*(1 - Pa/P)

Resolvendo para H (hedge notional USD):
  H = (lpPnl_up - lpPnl_down) * P / (Pb - Pa)

Convertendo para %:
  hedgePct = H / (xTokens * P) * 100
```

Se `H ≤ 0`: hedge desnecessário para equalizar (clamp a 0, mostrar aviso).

## UI (arquivo único: `src/dashboard/public/index.html`)

### Toggle no campo Hedge Size

Mesmo padrão visual do toggle `USD | %` dos campos Range Min/Max:

```
Hedge Size (%)           [MANUAL | AUTO]
[ input: 63.4 (disabled) ]
```

- Modo MANUAL: input editável, valor definido pelo usuário (comportamento atual)
- Modo AUTO: input disabled (cinza), preenchido pelo runCalc()

### Badge no painel de resultados

Quando AUTO: título do painel mostra `Cenários  ·  AUTO HEDGE`

### Edge case

Se `hedgePct ≤ 0`: input mostra `0` e `calc-error` exibe mensagem informativa (não é erro crítico, não bloqueia exibição da tabela).

## Implementação

Arquivo: `src/dashboard/public/index.html` apenas.

**HTML:** toggle `MANUAL | AUTO` no label do campo `calc-hedge`

**CSS:** `.calc-field .t-in:disabled { opacity: 0.5; cursor: not-allowed; }`

**JS (dentro do IIFE existente):**
- `var hedgeModeState = 'manual';`
- `window.setHedgeMode(mode, el)` — atualiza estado, habilita/desabilita input
- Em `runCalc()`: se AUTO, computar `H` e `hedgePct` antes de renderizar tabela
