//@ts-check

import { createSupabaseClient } from '../utils/supabase.js';

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
    .single();

  return { data, error };
}

/**
 * Set a new exchange rate (deactivates the previous one)
 * @param {string} application
 * @param {number} rate - SLE per 1 USDC
 * @param {string} setBy
 */
export async function setRate(application, rate, setBy) {
  await supabase
    .from('exchange_rates')
    .update({ active: false })
    .eq('application', application)
    .eq('active', true);

  const { data, error } = await supabase
    .from('exchange_rates')
    .insert({
      application,
      rate,
      set_by: setBy,
      active: true
    })
    .select()
    .single();

  return { data, error };
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
