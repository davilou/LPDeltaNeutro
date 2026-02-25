/**
 * One-off script: inserts the rebalance records that failed to save
 * on the nights of 2026-02-24 and 2026-02-25 due to network errors.
 *
 * Run: npx ts-node src/scripts/backfillRebalances.ts
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { RebalanceRecord } from '../db/types';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_KEY!;

if (!supabaseUrl || !supabaseKey) {
  console.error('SUPABASE_URL or SUPABASE_KEY not set');
  process.exit(1);
}

const client = createClient(supabaseUrl, supabaseKey);
const HL_TAKER_FEE = 0.000432;

// Helper: fee = |change in notional| * taker fee
function fee(fromNotional: number, toNotional: number): number {
  return Math.abs(toNotional - fromNotional) * HL_TAKER_FEE;
}

const records: RebalanceRecord[] = [
  // ─── NFT#4688193 — 2026-02-24 ──────────────────────────────────────────────
  {
    token_id: 4688193,
    timestamp: '2026-02-24T00:03:56.000Z',
    coin: 'VIRTUAL',
    action: null, avg_px: null, executed_sz: null, trade_value_usd: null,
    fee_usd: fee(170.06, 189.62),
    trade_pnl_usd: 0,
    trigger_reason: 'delta mismatch',
    is_emergency: false,
    from_size: 291.9, to_size: 324.5748,
    from_notional: 170.06, to_notional: 189.62,
    token0_symbol: 'VIRTUAL', token0_amount: 413.9984,
    token1_symbol: 'USDC',   token1_amount: 257.4170,
    range_status: 'in-range',
    total_pos_usd: 499.28,
    price: 0.584224,
    funding_rate: -0.0001,
    net_delta: 39.2987,
    hl_equity: 0,
    pnl_virtual_usd: 0, pnl_virtual_pct: 0,
    pnl_realized_usd: 0, pnl_lp_fees_usd: 0,
    pnl_funding_usd: 0, pnl_hl_fees_usd: 0,
    daily_count: 1,
    hedge_ratio: 1.0,
  },
  {
    token_id: 4688193,
    timestamp: '2026-02-24T03:45:55.000Z',
    coin: 'VIRTUAL',
    action: null, avg_px: null, executed_sz: null, trade_value_usd: null,
    fee_usd: fee(187.75, 205.17),
    trade_pnl_usd: 0,
    trigger_reason: 'delta mismatch',
    is_emergency: false,
    from_size: 324.6, to_size: 354.1729,
    from_notional: 187.75, to_notional: 205.17,
    token0_symbol: 'VIRTUAL', token0_amount: 451.7511,
    token1_symbol: 'USDC',   token1_amount: 235.4534,
    range_status: 'in-range',
    total_pos_usd: 497.14,
    price: 0.579280,
    funding_rate: -0.0001,
    net_delta: 36.8009,
    hl_equity: 0,
    pnl_virtual_usd: 0, pnl_virtual_pct: 0,
    pnl_realized_usd: 0, pnl_lp_fees_usd: 0,
    pnl_funding_usd: 0, pnl_hl_fees_usd: 0,
    daily_count: 2,
    hedge_ratio: 1.0,
  },

  // ─── NFT#4694546 — 2026-02-24 ──────────────────────────────────────────────
  {
    token_id: 4694546,
    timestamp: '2026-02-24T22:22:02.000Z',
    coin: 'VIRTUAL',
    action: null, avg_px: null, executed_sz: null, trade_value_usd: null,
    fee_usd: fee(177.89, 116.16),
    trade_pnl_usd: 0,
    trigger_reason: 'emergency: mismatch 62.8% > 60%, partial 90% of gap, cooldown bypassed',
    is_emergency: true,
    from_size: 278.3, to_size: 181.7227,
    from_notional: 177.89, to_notional: 116.16,
    token0_symbol: 'VIRTUAL', token0_amount: 213.7399,
    token1_symbol: 'USDC',   token1_amount: 371.5664,
    range_status: 'in-range',
    total_pos_usd: 508.20,
    price: 0.639240,
    funding_rate: 0,
    net_delta: -107.3081,
    hl_equity: 0,
    pnl_virtual_usd: 0, pnl_virtual_pct: 0,
    pnl_realized_usd: 0, pnl_lp_fees_usd: 0,
    pnl_funding_usd: 0, pnl_hl_fees_usd: 0,
    daily_count: 1,
    hedge_ratio: 1.0,
  },
  {
    token_id: 4694546,
    timestamp: '2026-02-24T23:00:15.000Z',
    coin: 'VIRTUAL',
    action: null, avg_px: null, executed_sz: null, trade_value_usd: null,
    fee_usd: fee(119.22, 71.92),
    trade_pnl_usd: 0,
    trigger_reason: 'emergency: mismatch 77.6% > 60%, partial 90% of gap, cooldown bypassed',
    is_emergency: true,
    from_size: 181.7, to_size: 110.2450,
    from_notional: 119.22, to_notional: 71.92,
    token0_symbol: 'VIRTUAL', token0_amount: 127.8820,
    token1_symbol: 'USDC',   token1_amount: 427.0430,
    range_status: 'in-range',
    total_pos_usd: 510.47,
    price: 0.652349,
    funding_rate: 0,
    net_delta: -79.3944,
    hl_equity: 0,
    pnl_virtual_usd: 0, pnl_virtual_pct: 0,
    pnl_realized_usd: 0, pnl_lp_fees_usd: 0,
    pnl_funding_usd: 0, pnl_hl_fees_usd: 0,
    daily_count: 2,
    hedge_ratio: 1.0,
  },
  {
    token_id: 4694546,
    timestamp: '2026-02-24T23:15:21.000Z',
    coin: 'VIRTUAL',
    action: null, avg_px: null, executed_sz: null, trade_value_usd: null,
    fee_usd: fee(72.91, 43.72),
    trade_pnl_usd: 0,
    trigger_reason: 'emergency: mismatch 80.1% > 60%, partial 90% of gap, cooldown bypassed',
    is_emergency: true,
    from_size: 110.2, to_size: 66.0812,
    from_notional: 72.91, to_notional: 43.72,
    token0_symbol: 'VIRTUAL', token0_amount: 76.4739,
    token1_symbol: 'USDC',   token1_amount: 460.8370,
    range_status: 'in-range',
    total_pos_usd: 511.43,
    price: 0.661612,
    funding_rate: 0,
    net_delta: -49.0209,
    hl_equity: 0,
    pnl_virtual_usd: 0, pnl_virtual_pct: 0,
    pnl_realized_usd: 0, pnl_lp_fees_usd: 0,
    pnl_funding_usd: 0, pnl_hl_fees_usd: 0,
    daily_count: 3,
    hedge_ratio: 1.0,
  },
  {
    token_id: 4694546,
    timestamp: '2026-02-24T23:23:21.000Z',
    coin: 'VIRTUAL',
    action: null, avg_px: null, executed_sz: null, trade_value_usd: null,
    fee_usd: fee(44.13, 28.00),
    trade_pnl_usd: 0,
    trigger_reason: 'emergency: mismatch 68.0% > 60%, partial 90% of gap, cooldown bypassed',
    is_emergency: true,
    from_size: 66.1, to_size: 42.0246,
    from_notional: 44.13, to_notional: 28.00,
    token0_symbol: 'VIRTUAL', token0_amount: 49.1870,
    token1_symbol: 'USDC',   token1_amount: 478.9538,
    range_status: 'in-range',
    total_pos_usd: 511.72,
    price: 0.666192,
    funding_rate: 0,
    net_delta: -26.7504,
    hl_equity: 0,
    pnl_virtual_usd: 0, pnl_virtual_pct: 0,
    pnl_realized_usd: 0, pnl_lp_fees_usd: 0,
    pnl_funding_usd: 0, pnl_hl_fees_usd: 0,
    daily_count: 4,
    hedge_ratio: 1.0,
  },
  {
    token_id: 4694546,
    timestamp: '2026-02-24T23:25:01.000Z',
    coin: 'VIRTUAL',
    action: null, avg_px: null, executed_sz: null, trade_value_usd: null,
    fee_usd: fee(28.16, 18.09),
    trade_pnl_usd: 0,
    trigger_reason: 'emergency: mismatch 65.6% > 60%, partial 90% of gap, cooldown bypassed',
    is_emergency: true,
    from_size: 42.0, to_size: 27.0328,
    from_notional: 28.16, to_notional: 18.09,
    token0_symbol: 'VIRTUAL', token0_amount: 31.7122,
    token1_symbol: 'USDC',   token1_amount: 490.6220,
    range_status: 'in-range',
    total_pos_usd: 511.84,
    price: 0.669197,
    funding_rate: 0,
    net_delta: -16.6302,
    hl_equity: 0,
    pnl_virtual_usd: 0, pnl_virtual_pct: 0,
    pnl_realized_usd: 0, pnl_lp_fees_usd: 0,
    pnl_funding_usd: 0, pnl_hl_fees_usd: 0,
    daily_count: 5,
    hedge_ratio: 1.0,
  },
  {
    token_id: 4694546,
    timestamp: '2026-02-24T23:46:41.000Z',
    coin: 'VIRTUAL',
    action: null, avg_px: null, executed_sz: null, trade_value_usd: null,
    fee_usd: fee(17.80, 46.90),
    trade_pnl_usd: 0,
    trigger_reason: 'emergency: mismatch 64.5% > 60%, partial 90% of gap, cooldown bypassed',
    is_emergency: true,
    from_size: 27.0, to_size: 71.2204,
    from_notional: 17.80, to_notional: 46.90,
    token0_symbol: 'VIRTUAL', token0_amount: 95.1672,
    token1_symbol: 'USDC',   token1_amount: 448.4978,
    range_status: 'in-range',
    total_pos_usd: 511.17,
    price: 0.658509,
    funding_rate: 0,
    net_delta: 49.1338,
    hl_equity: 0,
    pnl_virtual_usd: 0, pnl_virtual_pct: 0,
    pnl_realized_usd: 0, pnl_lp_fees_usd: 0,
    pnl_funding_usd: 0, pnl_hl_fees_usd: 0,
    daily_count: 6,
    hedge_ratio: 1.0,
  },

  // ─── NFT#4694546 — 2026-02-25 ──────────────────────────────────────────────
  {
    token_id: 4694546,
    timestamp: '2026-02-25T05:06:41.000Z',
    coin: 'VIRTUAL',
    action: null, avg_px: null, executed_sz: null, trade_value_usd: null,
    fee_usd: fee(47.59, 28.06),
    trade_pnl_usd: 0,
    trigger_reason: 'emergency: mismatch 83.1% > 60%, partial 90% of gap, cooldown bypassed',
    is_emergency: true,
    from_size: 71.2, to_size: 42.1180,
    from_notional: 47.59, to_notional: 28.06,
    token0_symbol: 'VIRTUAL', token0_amount: 48.6083,
    token1_symbol: 'USDC',   token1_amount: 479.3393,
    range_status: 'in-range',
    total_pos_usd: 511.73,
    price: 0.666325,
    funding_rate: 0,
    net_delta: -32.3133,
    hl_equity: 0,
    pnl_virtual_usd: 0, pnl_virtual_pct: 0,
    pnl_realized_usd: 0, pnl_lp_fees_usd: 0,
    pnl_funding_usd: 0, pnl_hl_fees_usd: 0,
    daily_count: 7,
    hedge_ratio: 1.0,
  },
  {
    token_id: 4694546,
    timestamp: '2026-02-25T05:30:02.000Z',
    coin: 'VIRTUAL',
    action: null, avg_px: null, executed_sz: null, trade_value_usd: null,
    fee_usd: fee(28.25, 11.28),
    trade_pnl_usd: 0,
    trigger_reason: 'emergency: mismatch 200.9% > 60%, partial 90% of gap, cooldown bypassed',
    is_emergency: true,
    from_size: 42.1, to_size: 16.8013,
    from_notional: 28.25, to_notional: 11.28,
    token0_symbol: 'VIRTUAL', token0_amount: 17.4879,
    token1_symbol: 'USDC',   token1_amount: 500.1583,
    range_status: 'in-range',
    total_pos_usd: 511.90,
    price: 0.671610,
    funding_rate: 0,
    net_delta: -28.1097,
    hl_equity: 0,
    pnl_virtual_usd: 0, pnl_virtual_pct: 0,
    pnl_realized_usd: 0, pnl_lp_fees_usd: 0,
    pnl_funding_usd: 0, pnl_hl_fees_usd: 0,
    daily_count: 8,
    hedge_ratio: 1.0,
  },
  {
    token_id: 4694546,
    timestamp: '2026-02-25T05:33:22.000Z',
    coin: 'VIRTUAL',
    action: null, avg_px: null, executed_sz: null, trade_value_usd: null,
    fee_usd: fee(11.36, 1.14),
    trade_pnl_usd: 0,
    trigger_reason: 'emergency: mismatch 100.0% > 60%, partial 90% of gap, cooldown bypassed',
    is_emergency: true,
    from_size: 16.8, to_size: 1.6800,
    from_notional: 11.36, to_notional: 1.14,
    token0_symbol: 'VIRTUAL', token0_amount: 0.0,
    token1_symbol: 'USDC',   token1_amount: 511.9300,
    range_status: 'above-range',
    total_pos_usd: 511.93,
    price: 0.677681,
    funding_rate: 0,
    net_delta: -16.8000,
    hl_equity: 0,
    pnl_virtual_usd: 0, pnl_virtual_pct: 0,
    pnl_realized_usd: 0, pnl_lp_fees_usd: 0,
    pnl_funding_usd: 0, pnl_hl_fees_usd: 0,
    daily_count: 9,
    hedge_ratio: 1.0,
  },
];

async function main() {
  console.log(`Inserting ${records.length} missing rebalance records...`);

  for (const record of records) {
    const { error } = await client.from('rebalances').insert(record);
    if (error) {
      console.error(`FAILED [${record.timestamp} NFT#${record.token_id}]: ${error.message}`);
    } else {
      console.log(`OK [${record.timestamp} NFT#${record.token_id}] ${record.from_size} → ${record.to_size}`);
    }
  }

  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
