# Calc Range Dual-Unit + Break-Even Design Doc
_Date: 2026-03-06_

## Overview

Duas melhorias na aba CALCULATOR do dashboard:

1. **Range dual-unit**: linhas amber da tabela mostram o preço do range em ambas as unidades ($ e %)
2. **Break-even**: nova coluna na tabela mostra quantos dias de farm são necessários para recuperar o prejuízo de uma saída de range

## Feature 1 — Range dual-unit

### Comportamento

Nas linhas `▲ RANGE MAX` e `▼ RANGE MIN`, a célula da coluna Preço exibe:
```
$2,200
+7.11%
```
O segundo valor (pct) é renderizado como bloco menor abaixo do preço em $.

### Fórmula

```
pct = (rangePx / P - 1) * 100
```

Formatado com sinal explícito: `+7.11%` / `−12.36%`.

### Implementação

Apenas mudança na string gerada pelo `tbody.innerHTML` no `runCalc()`:
- Rows não-range: `priceStr` inalterado (`$X,XXX.XX`)
- Rows de range: `priceStr` = `$X,XXX.XX<span class="range-pct-hint">±YY.YY%</span>`

CSS: `.range-pct-hint { font-size: 0.68rem; opacity: 0.8; display: block; color: var(--amber); }`

## Feature 2 — Break-even column

### Comportamento

6ª coluna `Break-even` adicionada ao thead e tbody **somente quando `apr > 0`**.

| Caso | Valor exibido |
|------|---------------|
| Linha normal (não-range) | `—` |
| Linha de range, PnL líquido ≥ 0 | `—` |
| Linha de range, PnL líquido < 0, APR > 0 | `X.X dias` |
| APR = 0 | coluna não aparece |

### Fórmula

```
daily = V * APR/100 / 365
breakEven = |net| / daily   (arredondado para 1 casa)
```

`daily` já é calculado para o farm card — reutilizado sem redundância.

### Implementação

- `thead`: adicionar `<th>Break-even</th>` condicionalmente (`if (apr > 0)`)
- Cada row no `tbody`: adicionar `<td>` com `—` ou `X.X dias`

## Arquivos

Somente `src/dashboard/public/index.html`:
- CSS: 1 regra nova (`.range-pct-hint`)
- JS: mudanças em `runCalc()` dentro do IIFE existente (thead dinâmico + priceStr das range rows + coluna break-even)
