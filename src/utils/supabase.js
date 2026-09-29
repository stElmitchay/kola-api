//@ts-check

import { createClient } from '@supabase/supabase-js';

/**
 * Server-side Supabase client using the service-role key.
 * The anon key must NEVER be used by this API: RLS is deny-all (0009)
 * and anon has no grants on the public schema.
 */
export function createSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('SUPABASE_URL is not set');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}
