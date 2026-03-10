import { SupabaseClient } from '@supabase/supabase-js';
import { AuthUser } from './types';
import { encrypt, decrypt } from './encrypt';
import { logger } from '../utils/logger';

interface UserRow {
  id: string;
  google_id: string;
  email: string;
  display_name: string | null;
  hl_private_key_enc: string | null;
  hl_private_key_iv: string | null;
  hl_private_key_tag: string | null;
  hl_wallet_address: string | null;
}

function rowToUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    googleId: row.google_id,
    email: row.email,
    displayName: row.display_name,
    hlPrivateKeyEnc: row.hl_private_key_enc,
    hlPrivateKeyIv: row.hl_private_key_iv,
    hlPrivateKeyTag: row.hl_private_key_tag,
    hlWalletAddress: row.hl_wallet_address,
  };
}

export async function findOrCreateUser(
  client: SupabaseClient,
  googleId: string,
  email: string,
  displayName: string | null
): Promise<AuthUser | null> {
  try {
    // Try to find existing user
    const { data: existing, error: findErr } = await client
      .from('users')
      .select('*')
      .eq('google_id', googleId)
      .single();

    if (findErr && findErr.code !== 'PGRST116') {
      logger.error(`[UserStore] findUser error: ${findErr.message}`);
      return null;
    }

    if (existing) return rowToUser(existing as UserRow);

    // Create new user
    const { data: created, error: createErr } = await client
      .from('users')
      .insert({ google_id: googleId, email, display_name: displayName })
      .select('*')
      .single();

    if (createErr || !created) {
      logger.error(`[UserStore] createUser error: ${createErr?.message}`);
      return null;
    }

    logger.info(`[UserStore] New user created: ${email}`);
    return rowToUser(created as UserRow);
  } catch (err) {
    logger.error(`[UserStore] findOrCreateUser failed: ${err}`);
    return null;
  }
}

export async function loadCredentials(
  client: SupabaseClient,
  userId: string
): Promise<{ privateKey: string; walletAddress: string } | null> {
  try {
    const { data, error } = await client
      .from('users')
      .select('hl_private_key_enc, hl_private_key_iv, hl_private_key_tag, hl_wallet_address')
      .eq('id', userId)
      .single();

    if (error || !data) return null;

    const row = data as Pick<UserRow, 'hl_private_key_enc' | 'hl_private_key_iv' | 'hl_private_key_tag' | 'hl_wallet_address'>;
    if (!row.hl_private_key_enc || !row.hl_private_key_iv || !row.hl_private_key_tag || !row.hl_wallet_address) {
      return null;
    }

    const privateKey = decrypt({
      ciphertext: row.hl_private_key_enc,
      iv: row.hl_private_key_iv,
      tag: row.hl_private_key_tag,
    });

    return { privateKey, walletAddress: row.hl_wallet_address };
  } catch (err) {
    logger.error(`[UserStore] loadCredentials failed for ${userId}: ${err}`);
    return null;
  }
}

export async function saveCredentials(
  client: SupabaseClient,
  userId: string,
  privateKey: string,
  walletAddress: string
): Promise<void> {
  try {
    const encrypted = encrypt(privateKey);
    const { error } = await client
      .from('users')
      .update({
        hl_private_key_enc: encrypted.ciphertext,
        hl_private_key_iv: encrypted.iv,
        hl_private_key_tag: encrypted.tag,
        hl_wallet_address: walletAddress,
      })
      .eq('id', userId);

    if (error) {
      logger.error(`[UserStore] saveCredentials error: ${error.message}`);
      return;
    }
    logger.info(`[UserStore] Credentials saved for user ${userId}`);
  } catch (err) {
    logger.error(`[UserStore] saveCredentials failed: ${err}`);
  }
}
