import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';
import { logger } from '../utils/logger';
import { RebalanceRecord } from './types';

let client: SupabaseClient | null = null;

if (config.supabaseUrl && config.supabaseKey) {
  client = createClient(config.supabaseUrl, config.supabaseKey);
  logger.info('[Supabase] Client initialized');
} else {
  logger.warn('[Supabase] SUPABASE_URL or SUPABASE_KEY not set — persistence disabled');
}

const MAX_RETRIES = 4;
const RETRY_BASE_MS = 2_000;

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
