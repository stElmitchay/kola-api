//@ts-check

import { hashApiKey } from '../utils/crypto.js';
import { createSupabaseClient } from '../utils/supabase.js';

/**
 * API key authentication middleware
 * Reads X-API-Key header, hashes and verifies against auth_api_keys table
 * Sets `clientId` and `application` in Hono context
 * @param {import('hono').Context} c
 * @param {Function} next
 */
export async function apiKeyAuth(c, next) {
  const apiKey = c.req.header('X-API-Key') || c.req.query('api_key');

  if (!apiKey) {
    return c.json({ error: 'Missing API key' }, 401);
  }

  const keyHash = hashApiKey(apiKey);
  const supabase = createSupabaseClient();

  const { data, error } = await supabase
    .from('auth_api_keys')
    .select('*')
    .eq('key_hash', keyHash)
    .eq('is_active', true)
    .single();

  if (error || !data) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    return c.json({ error: 'API key expired' }, 401);
  }

  await supabase
    .from('auth_api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id);

  c.set('clientId', data.client_id);
  c.set('application', data.id);

  await next();
}
