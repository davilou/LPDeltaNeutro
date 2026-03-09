import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ClosedPositionRecord, RebalanceRecord, ProtectionActivationRecord } from './types';

let client: SupabaseClient | null = null;

if (config.supabaseUrl && config.supabaseKey) {
  client = createClient(config.supabaseUrl, config.supabaseKey);
  logger.info('[Supabase] Client initialized');
} else {
  logger.warn('[Supabase] SUPABASE_URL or SUPABASE_KEY not set — persistence disabled');
}

// Service client (bypasses RLS) — used for auth operations
export let supabaseServiceClient: SupabaseClient | null = null;
if (config.supabaseUrl && config.supabaseKey) {
  supabaseServiceClient = createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const MAX_RETRIES = 4;
const RETRY_BASE_MS = 2_000;

export async function insertClosedPosition(data: ClosedPositionRecord): Promise<void> {
  if (!client) return;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { error } = await client.from('closed_positions').insert(data);
      if (error) {
        logger.error(`[Supabase] insertClosedPosition error (attempt ${attempt}/${MAX_RETRIES}): ${error.message}`);
        return;
      }
      logger.info(`[Supabase] Closed position record inserted for token_id=${data.token_id}`);
      return;
    } catch (err: any) {
      const cause = err?.cause?.message ?? err?.cause ?? '';
      const detail = cause ? ` (cause: ${cause})` : '';
      if (attempt < MAX_RETRIES) {
        const delayMs = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        logger.warn(`[Supabase] insertClosedPosition failed (attempt ${attempt}/${MAX_RETRIES})${detail} — retrying in ${delayMs / 1000}s`);
        await new Promise(res => setTimeout(res, delayMs));
      } else {
        logger.error(`[Supabase] insertClosedPosition failed after ${MAX_RETRIES} attempts${detail}: ${err}`);
      }
    }
  }
}

export async function fetchClosedPositions(userId?: string): Promise<ClosedPositionRecord[]> {
  if (!client) return [];

  try {
    let query = client
      .from('closed_positions')
      .select('*')
      .order('deactivated_at', { ascending: false });

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data, error } = await query;

    if (error) {
      logger.error(`[Supabase] fetchClosedPositions error: ${error.message}`);
      return [];
    }
    return (data ?? []) as ClosedPositionRecord[];
  } catch (err) {
    logger.error(`[Supabase] fetchClosedPositions failed: ${err}`);
    return [];
  }
}

export async function fetchRebalances(userId?: string, tokenId?: number, limit = 100): Promise<RebalanceRecord[]> {
  if (!client) return [];

  try {
    let query = client
      .from('rebalances')
      .select('token_id, timestamp, coin, action, avg_px, executed_sz, trade_value_usd, fee_usd, trigger_reason, is_emergency, from_size, to_size, from_notional, to_notional, token0_symbol, token1_symbol, range_status, price, pnl_realized_usd, pnl_funding_usd')
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (userId) query = query.eq('user_id', userId);
    if (tokenId !== undefined) query = query.eq('token_id', tokenId);

    const { data, error } = await query;
    if (error) {
      logger.error(`[Supabase] fetchRebalances error: ${error.message}`);
      return [];
    }
    return (data ?? []) as RebalanceRecord[];
  } catch (err) {
    logger.error(`[Supabase] fetchRebalances failed: ${err}`);
    return [];
  }
}

export async function upsertProtectionActivation(data: ProtectionActivationRecord): Promise<void> {
  if (!client) return;
  try {
    const { error } = await client
      .from('protection_activations')
      .upsert(data, { onConflict: 'user_id,token_id' });
    if (error) {
      logger.error(`[Supabase] upsertProtectionActivation error: ${error.message}`);
    } else {
      logger.info(`[Supabase] Protection activation saved for token_id=${data.token_id}`);
    }
  } catch (err) {
    logger.error(`[Supabase] upsertProtectionActivation failed: ${err}`);
  }
}

export async function fetchProtectionActivation(userId: string, tokenId: string | number): Promise<ProtectionActivationRecord | null> {
  if (!client) return null;
  try {
    const { data, error } = await client
      .from('protection_activations')
      .select('*')
      .eq('user_id', userId)
      .eq('token_id', tokenId)
      .single();
    if (error) return null;
    return data as ProtectionActivationRecord;
  } catch {
    return null;
  }
}

export async function insertRebalance(data: RebalanceRecord): Promise<void> {
  if (!client) return;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { error } = await client.from('rebalances').insert(data);
      if (error) {
        logger.error(`[Supabase] insertRebalance error (attempt ${attempt}/${MAX_RETRIES}): ${error.message}`);
        // Supabase API errors (e.g. schema mismatch, RLS) won't improve on retry
        return;
      }
      logger.info(`[Supabase] Rebalance record inserted for token_id=${data.token_id}`);
      return;
    } catch (err: any) {
      const cause = err?.cause?.message ?? err?.cause ?? '';
      const detail = cause ? ` (cause: ${cause})` : '';
      if (attempt < MAX_RETRIES) {
        const delayMs = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        logger.warn(`[Supabase] insertRebalance failed (attempt ${attempt}/${MAX_RETRIES})${detail} — retrying in ${delayMs / 1000}s`);
        await new Promise(res => setTimeout(res, delayMs));
      } else {
        logger.error(`[Supabase] insertRebalance failed after ${MAX_RETRIES} attempts${detail}: ${err}`);
      }
    }
  }
}
