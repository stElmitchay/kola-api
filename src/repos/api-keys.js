//@ts-check

import { createSupabaseClient } from '../utils/supabase.js';

const supabase = createSupabaseClient();

/**
 * Create a new API key record
 * @param {object} keyData
 * @param {string} keyData.client_id
 * @param {string} keyData.key_hash
 * @param {string} keyData.name
 * @param {string} keyData.business_name
 * @param {string} keyData.app_name
 * @param {string} [keyData.expires_at]
 * @param {object} [keyData.permissions]
 * @param {number} [keyData.rate_limit]
 */
export async function createApiKey(keyData) {
  const { data, error } = await supabase
    .from('auth_api_keys')
    .insert({
      ...keyData,
      is_active: true
    })
    .select()
    .single();

  return { data, error };
}

/**
 * List all API keys
 */
export async function listApiKeys() {
  const { data, error } = await supabase
    .from('auth_api_keys')
    .select('id, client_id, name, business_name, app_name, is_active, expires_at, last_used_at, created_at')
    .order('created_at', { ascending: false });

  return { data, error };
}

/**
 * Deactivate an API key
 * @param {string} id
 */
export async function deactivateApiKey(id) {
  const { data, error } = await supabase
    .from('auth_api_keys')
    .update({ is_active: false })
    .eq('id', id)
    .select()
    .single();

  return { data, error };
}
