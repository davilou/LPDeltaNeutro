# Changelog

## [Unreleased] — 2026-02-25

### Mudança de arquitetura: gatilhos de rebalance por movimento de preço

#### Motivação
O sistema anterior usava **delta mismatch percentual** como gatilho principal de rebalance. Perto das bordas do range de liquidez, o token hedgeado (ex: VIRTUAL) fica com quantidade mínima na pool. Pequenas oscilações de preço causavam variações percentuais enormes nesse saldo (ex: 10→20 tokens = 100% de mismatch), disparando rebalances em loop sem valor econômico real.

#### O que mudou

**Gatilhos de rebalance — antes:**
| Gatilho | Descrição |
|---|---|
| Delta mismatch % | Dispara quando `|target - hedge| / target > DELTA_MISMATCH_THRESHOLD` |
| Delta mismatch % (emergency) | Threshold maior, bypassa cooldown; fecha % parcial do gap |
| Timer | Rebalance periódico |
| Range status change | Dispara quando LP entra/sai do range |

**Gatilhos de rebalance — depois:**
| Gatilho | Descrição |
|---|---|
| Price movement | Dispara quando `|preço atual - preço no último rebalance| / preço ref > PRICE_MOVEMENT_THRESHOLD` |
| Price movement (emergency) | Threshold maior, bypassa cooldown |
| Timer | Rebalance periódico (inalterado) |
| Forced close | LP saiu do range → fecha hedge imediatamente (inalterado) |

#### Variáveis de ambiente removidas
```
DELTA_MISMATCH_THRESHOLD
MIN_REBALANCE_USD
ADAPTIVE_THRESHOLD
ADAPTIVE_REFERENCE_TICK_RANGE
ADAPTIVE_MAX_THRESHOLD
EMERGENCY_MISMATCH_THRESHOLD
EMERGENCY_HEDGE_RATIO
TIME_REBALANCE_MIN_MISMATCH
NEAR_BOUNDARY_ZONE          (era temporário, nunca chegou ao .env.example)
NEAR_BOUNDARY_THRESHOLD_MULT (idem)
```

#### Variáveis de ambiente adicionadas
```env
# % de variação de preço desde o último rebalance para disparar rebalance normal
PRICE_MOVEMENT_THRESHOLD=0.05        # default: 5%

# % de variação de preço para emergency (bypassa cooldown)
EMERGENCY_PRICE_MOVEMENT_THRESHOLD=0.15   # default: 15%
```

#### Estado persistido (`state.json`)
- Adicionado campo `lastRebalancePrice` em `PositionState` — preço no momento do último rebalance executado, usado como referência para o gatilho de movimento de preço.
- Backward-compatible: migração automática define `lastRebalancePrice: 0` para estados antigos (primeiro ciclo sem referência não dispara price movement, aguarda timer ou forced close).

#### Arquivos modificados
- `src/config.ts` — novos campos, remoção dos antigos
- `src/types.ts` — `PositionState.lastRebalancePrice`, `ActivePositionConfig` atualizado
- `src/engine/rebalancer.ts` — novos métodos `checkPriceMovement`, `checkEmergencyPriceMovement`; remoção de `checkNeedsRebalance`, `checkEmergencyRebalance`, `computeEffectiveThreshold`, `computeNearBoundaryMultiplier`; `checkTimeRebalance` simplificado
- `src/dashboard/store.ts` — `DashboardData.lastRebalancePrice`, `ActivatePositionRequest` atualizado
- `src/dashboard/server.ts` — campos de ativação atualizados
- `src/index.ts` — campos de ativação atualizados
- `src/dashboard/public/index.html` — formulários de configuração e ativação atualizados; novo campo "Ref Price" exibe `lastRebalancePrice`
- `.env` / `.env.example` — variáveis atualizadas

#### Comportamento do emergency sem referência de preço
Se `lastRebalancePrice = 0` (posição recém-ativada ou migrada), os gatilhos de price movement e emergency retornam `null` — nenhum rebalance é disparado por preço. O primeiro rebalance ocorre via timer (`TIME_REBALANCE_INTERVAL_MIN`) ou forced close (saída de range).
