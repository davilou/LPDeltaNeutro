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
        logger.error({ message: 'db.insert_error', table: 'closed_positions', token_id: data.token_id, attempt, max_retries: MAX_RETRIES, error: error.message });
        return;
      }
      logger.debug({ message: 'db.insert_ok', table: 'closed_positions', token_id: data.token_id });
      return;
    } catch (err: any) {
      const cause = err?.cause?.message ?? err?.cause ?? '';
      const detail = cause ? ` (cause: ${cause})` : '';
      if (attempt < MAX_RETRIES) {
        const delayMs = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        logger.warn({ message: 'db.insert_retry', table: 'closed_positions', token_id: data.token_id, attempt, max_retries: MAX_RETRIES, retry_in_s: delayMs / 1000, error: String(err) });
        await new Promise(res => setTimeout(res, delayMs));
      } else {
        logger.error({ message: 'db.insert_failed', table: 'closed_positions', token_id: data.token_id, attempts: MAX_RETRIES, error: String(err) });
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
      logger.error({ message: 'db.fetch_error', table: 'closed_positions', error: error.message });
      return [];
    }
    return (data ?? []) as ClosedPositionRecord[];
  } catch (err) {
    logger.error({ message: 'db.fetch_failed', table: 'closed_positions', error: String(err) });
    return [];
  }
}

export async function fetchRebalances(userId?: string, tokenId?: number, activationId?: string, limit = 100): Promise<RebalanceRecord[]> {
  if (!client) return [];

  try {
    let query = client
      .from('rebalances')
      .select('token_id, timestamp, coin, action, avg_px, executed_sz, trade_value_usd, fee_usd, trigger_reason, is_emergency, from_size, to_size, from_notional, to_notional, token0_symbol, token1_symbol, range_status, price, pnl_realized_usd, pnl_funding_usd, activation_id')
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (userId) query = query.eq('user_id', userId);
    if (activationId) query = query.eq('activation_id', activationId);
    else if (tokenId !== undefined) query = query.eq('token_id', tokenId);

    const { data, error } = await query;
    if (error) {
      logger.error({ message: 'db.fetch_error', table: 'rebalances', error: error.message });
      return [];
    }
    return (data ?? []) as RebalanceRecord[];
  } catch (err) {
    logger.error({ message: 'db.fetch_failed', table: 'rebalances', error: String(err) });
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
      logger.error({ message: 'db.upsert_error', table: 'protection_activations', token_id: data.token_id, error: error.message });
    } else {
      logger.debug({ message: 'db.upsert_ok', table: 'protection_activations', token_id: data.token_id });
    }
  } catch (err) {
    logger.error({ message: 'db.upsert_failed', table: 'protection_activations', token_id: data.token_id, error: String(err) });
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
        logger.error({ message: 'db.insert_error', table: 'rebalances', token_id: data.token_id, attempt, max_retries: MAX_RETRIES, error: error.message });
        // Supabase API errors (e.g. schema mismatch, RLS) won't improve on retry
        return;
      }
      logger.debug({ message: 'db.insert_ok', table: 'rebalances', token_id: data.token_id });
      return;
    } catch (err: any) {
      const cause = err?.cause?.message ?? err?.cause ?? '';
      const detail = cause ? ` (cause: ${cause})` : '';
      if (attempt < MAX_RETRIES) {
        const delayMs = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        logger.warn({ message: 'db.insert_retry', table: 'rebalances', token_id: data.token_id, attempt, max_retries: MAX_RETRIES, retry_in_s: delayMs / 1000, error: String(err) });
        await new Promise(res => setTimeout(res, delayMs));
      } else {
        logger.error({ message: 'db.insert_failed', table: 'rebalances', token_id: data.token_id, attempts: MAX_RETRIES, error: String(err) });
      }
    }
  }
}
