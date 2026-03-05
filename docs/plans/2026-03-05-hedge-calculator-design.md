# Hedge Calculator — Design Doc
_Date: 2026-03-05_

## Overview

Nova aba **CALCULATOR** no dashboard. Ferramenta client-side (zero backend) para simular o impacto de movimentos de preço em uma posição LP com hedge short na Hyperliquid.

## Estrutura da página

- Nova entrada na sidebar entre HISTORY e SETTINGS: `CALCULATOR`
- Nova div `#page-calculator`, adicionada ao array do `showPage()`
- Todo o cálculo é feito em JavaScript no browser, sem chamadas ao servidor

## Layout

Duas colunas lado a lado:
- **Esquerda**: painel de inputs (`.panel`)
- **Direita**: tabela de cenários + card de farm diário

## Inputs (6 campos + botão CALCULATE)

| Campo | Tipo | Unidade |
|---|---|---|
| Pool Value | number | USD |
| Current Price | number | USD |
| Range Min (Pa) | number | USD |
| Range Max (Pb) | number | USD |
| Hedge Size | number | USD notional |
| Pool APR | number | % |

## Tabela de Cenários

Linhas ordenadas por preço crescente. Linhas fixas: −15%, −10%, −5%, Atual, +5%, +10%, +15%. Linhas dinâmicas: **▼ RANGE MIN** (Pa) e **▲ RANGE MAX** (Pb) inseridas na posição correta da ordem.

Colunas: `Cenário | Novo Preço | P&L LP | P&L Hedge | P&L Líquido`

- Valores positivos: verde (`--green`)
- Valores negativos: vermelho (`--red`)
- Linhas de range: fundo âmbar destacado, label como `▼ RANGE MIN` / `▲ RANGE MAX`
- Linha "Atual": P&L = $0 em todos os campos

## Card de Farm Diário

Card simples abaixo da tabela:
```
FARM DIÁRIO ESTIMADO: $XX.XX  (APR YY% · $ZZZ,ZZZ)
```
Assume posição sempre in-range.

## Matemática

### Liquidez L (Uniswap V3 concentrada)

```
sp  = √P,  spa = √Pa,  spb = √Pb
L   = V / (sp·(spb − sp)/spb + sp − spa)
```

### Valor LP em novo preço P'

```
sp' = √P'
```

- **In-range** (Pa ≤ P' ≤ Pb):
  `V' = L·(sp'·(spb − sp')/spb + sp' − spa)`

- **Below Pa** (100% token volátil):
  `V' = L·(1/spa − 1/spb)·P'`

- **Above Pb** (100% stablecoin):
  `V' = L·(spb − spa)`

### Hedge PnL (short)

```
hedge_pnl = hedge_size × (1 − P'/P)
```

### Farm Diário

```
daily_farm = V × APR/100 / 365
```

## Algoritmo da tabela

1. Montar array de pontos: `[{label, price, isRange}]` com as 7 linhas fixas + Pa + Pb
2. Ordenar por `price` ascendente
3. Para cada ponto: calcular `lp_pnl`, `hedge_pnl`, `net_pnl`
4. Renderizar linhas — range rows com estilo diferenciado
