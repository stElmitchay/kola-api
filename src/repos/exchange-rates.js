//@ts-check

import { createSupabaseClient } from '../utils/supabase.js';
import { envInt } from '../utils/config.js';

const supabase = createSupabaseClient();

/**
 * Get the active exchange rate for an application
 * @param {string} application
 */
export async function getActiveRate(application) {
  const { data, error } = await supabase
    .from('exchange_rates')
    .select('*')
    .eq('application', application)
    .eq('active', true)
    .maybeSingle();          // never turn "0 or 2 rows" into an outage-shaped error

  return { data, error };
}

/**
 * Atomically deactivate the old rate and insert the new one (single tx in
 * Postgres — F6). The partial unique index makes "two active rates"
 * impossible even under concurrent calls.
 * @param {string} application
 * @param {number} rate - SLE per 1 USDC
 * @param {string} setBy
 */
export async function setRate(application, rate, setBy) {
  const { data, error } = await supabase.rpc('set_exchange_rate', {
    p_application: application, p_rate: rate, p_set_by: setBy
  });
  return { data, error };
}

/**
 * Reject a rate that is too old to price real money against.
 * @param {{ rate: string|number, created_at: string }} rateRow
 */
export function assertRateFresh(rateRow) {
  const maxAgeMinutes = envInt('RATE_MAX_AGE_MINUTES');
  const ageMs = Date.now() - new Date(rateRow.created_at).getTime();
  if (ageMs > maxAgeMinutes * 60_000) {
    const err = new Error('Exchange rate is stale. An operator must set a fresh rate.');
    err.name = 'ValidationError';
    throw err;
  }
}

/**
 * Get exchange rate history for an application
 * @param {string} application
 * @param {number} [limit]
 */
export async function getRateHistory(application, limit = 20) {
  const { data, error } = await supabase
    .from('exchange_rates')
    .select('*')
    .eq('application', application)
    .order('created_at', { ascending: false })
    .limit(limit);

  return { data, error };
}
