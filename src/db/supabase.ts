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

export async function insertRebalance(data: RebalanceRecord): Promise<void> {
  if (!client) return;
  try {
    const { error } = await client.from('rebalances').insert(data);
    if (error) {
      logger.error(`[Supabase] insertRebalance error: ${error.message}`);
    } else {
      logger.info(`[Supabase] Rebalance record inserted for token_id=${data.token_id}`);
    }
  } catch (err) {
    logger.error(`[Supabase] insertRebalance exception: ${err}`);
  }
}
