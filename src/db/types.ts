export interface RebalanceRecord {
  token_id: number;
  timestamp: string; // ISO string

  // Execução HL
  coin: string | null;
  action: string | null;
  avg_px: number | null;
  executed_sz: number | null;
  trade_value_usd: number | null;
  fee_usd: number | null;
  // PnL deste trade específico (0 para SELL, realizado para BUY-REDUCE/CLOSE)
  trade_pnl_usd: number;

  // Trigger
  trigger_reason: string | null;
  is_emergency: boolean;

  // Hedge
  from_size: number;
  to_size: number;
  from_notional: number;
  to_notional: number;

  // Posição LP
  token0_symbol: string;
  token0_amount: number;
  token1_symbol: string;
  token1_amount: number;
  range_status: string;
  total_pos_usd: number;
  price: number;

  // Mercado
  funding_rate: number;
  net_delta: number;
  hl_equity: number;

  // P&L acumulado
  pnl_virtual_usd: number;
  pnl_virtual_pct: number;
  pnl_realized_usd: number;
  pnl_lp_fees_usd: number;
  pnl_funding_usd: number;
  pnl_hl_fees_usd: number;

  // Contadores
  daily_count: number;
  hedge_ratio: number;
}
