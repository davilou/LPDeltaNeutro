/** Snapshot de um ciclo extraido dos logs */
export interface TickData {
  timestamp: number;
  token0Amount: number;
  token1Amount: number;
  price: number;
  fundingRate: number;
  rangeStatus: 'in-range' | 'above-range' | 'below-range';
  /** Current hedge size read from the exchange at this tick */
  hedgeSize: number;
  /** Uncollected LP fees in token0 (0 when not present in logs) */
  lpFees0: number;
  /** Uncollected LP fees in token1 (0 when not present in logs) */
  lpFees1: number;
}

/** Config injetavel (nao depende do singleton config.ts) */
export interface BacktestConfig {
  hedgeFloor: number;
  /**
   * Alvo de cobertura como fração do delta total (ex: 0.8 = 80%).
   * Todos os hedge ratios internos (1.0, 0.98, 0.90) são escalados por este valor.
   * Padrão: 1.0 (comportamento original, 100% delta-neutro).
   */
  hedgeRatio: number;
  deltaMismatchThreshold: number;
  rebalanceIntervalMin: number;
  maxDailyRebalances: number;
  minRebalanceUsd: number;
  minNotionalUsd: number;
  hlTakerFee: number;
  label: string;
  /**
   * Emergency rebalance: bypassa cooldown quando mismatch ultrapassa este valor.
   * Undefined = desabilitado.
   */
  emergencyMismatchThreshold?: number;
  /**
   * Fração do gap a fechar no emergency (0.5 = metade, 1.0 = tudo).
   */
  emergencyHedgeRatio?: number;
}

/** Interface de estrategia */
export interface IRebalanceStrategy {
  shouldRebalance(
    tick: TickData,
    currentHedgeSize: number,
    targetSize: number,
    lastRebalanceTimestamp: number,
    config: BacktestConfig,
  ): boolean;
}

/** Registro de um trade simulado */
export interface TradeRecord {
  timestamp: number;
  fromSize: number;
  toSize: number;
  deltaUsd: number;
  feeUsd: number;
  price: number;
  /** Motivo do rebalance */
  trigger: 'range' | 'strategy' | 'emergency';
}

/** Resultado de um backtest */
export interface BacktestResult {
  label: string;
  totalTrades: number;
  /** Quantos trades foram disparados por mudança de range */
  rangeTriggeredTrades: number;
  /** Quantos trades foram disparados pelo critério da strategy (threshold/time) */
  strategyTriggeredTrades: number;
  /** Quantos trades foram disparados por emergency mismatch */
  emergencyTrades: number;
  /** Taxas de rebalanceamento pagas à HL (custo, sempre positivo) */
  totalFeesUsd: number;
  /**
   * Variação do valor da LP principal (token0*price + token1).
   * Captura o efeito do preço + impermanent loss tick a tick.
   */
  lpValuePnlUsd: number;
  /**
   * Mark-to-market da posição short na HL.
   * Positivo = preço caiu (short lucrou). Negativo = preço subiu.
   */
  hlMarkToMarketPnlUsd: number;
  /**
   * P&L acumulado de funding rate.
   * Positivo = taxa positiva (shorts recebem). Negativo = taxa negativa (shorts pagam).
   */
  fundingPnlUsd: number;
  /**
   * LP fees acumuladas (token0*price + token1 das fees não coletadas).
   * Zero enquanto o bot não logar tokensOwed; disponível em dados futuros.
   */
  lpFeesPnlUsd: number;
  maxDrawdownUsd: number;
  /** Net PnL = lpValuePnl + hlMarkToMarket + funding + lpFees - hlTradeFees */
  finalPnlUsd: number;
  avgTimeBetweenTrades: number;
  trades: TradeRecord[];
}
