export interface ClosedPositionRecord {
  user_id?: string;
  token_id: string | number;
  pool_address: string | null;
  protocol_version: string | null;
  token0_symbol: string | null;
  token1_symbol: string | null;
  fee: number | null;
  tick_lower: number | null;
  tick_upper: number | null;
  hedge_symbol: string | null;
  activated_at: string;   // ISO string — required
  deactivated_at: string; // ISO string — required
  initial_lp_usd: number | null;
  initial_hl_usd: number | null;
  final_lp_fees_usd: number | null;
  final_cumulative_funding_usd: number | null;
  final_cumulative_hl_fees_usd: number | null;
  final_virtual_pnl_usd: number | null;
  final_virtual_pnl_pct: number | null;
  final_unrealized_pnl_usd: number | null;
  final_realized_pnl_usd: number | null;
}

export interface ProtectionActivationRecord {
  user_id?: string;
  token_id: string | number;
  pool_address: string;
  protocol_version: string;
  token0_symbol: string;
  token1_symbol: string;
  token0_amount: number;
  token1_amount: number;
  initial_lp_usd: number;
  initial_lp_fees_usd: number;
  initial_timestamp: number;
  fee?: number | null;
  tick_lower?: number | null;
  tick_upper?: number | null;
}

export interface RebalanceRecord {
  user_id?: string;
  token_id: string | number;
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
