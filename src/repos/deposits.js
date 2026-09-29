//@ts-check

import { createSupabaseClient } from '../utils/supabase.js';

const supabase = createSupabaseClient();

/**
 * Create a new deposit record
 * @param {object} deposit
 * @param {string} deposit.application
 * @param {string} deposit.phone_number
 * @param {string} deposit.wallet_address
 * @param {string} deposit.wallet_type
 * @param {number} deposit.amount_sle
 * @param {number} deposit.amount_usdc
 * @param {number} deposit.exchange_rate
 * @param {string} deposit.payment_method
 * @param {object} [deposit.metadata]
 */
export async function createDeposit(deposit) {
  const { data, error } = await supabase
    .from('deposits')
    .insert({
      ...deposit,
      status: 'pending'
    })
    .select()
    .single();

  return { data, error };
}

/**
 * Get a deposit by ID, scoped to application
 * @param {string} id
 * @param {string} application
 */
export async function getDeposit(id, application) {
  const { data, error } = await supabase
    .from('deposits')
    .select('*')
    .eq('id', id)
    .eq('application', application)
    .single();

  return { data, error };
}

/**
 * Get a deposit by ID without application scoping (for webhooks)
 * @param {string} id
 */
export async function getDepositById(id) {
  const { data, error } = await supabase
    .from('deposits')
    .select('*')
    .eq('id', id)
    .single();

  return { data, error };
}

/**
 * List deposits with optional filters
 * @param {string} application
 * @param {object} [filters]
 * @param {string} [filters.phoneNumber]
 * @param {string} [filters.status]
 * @param {number} [filters.limit]
 * @param {number} [filters.offset]
 */
export async function listDeposits(application, filters = {}) {
  let query = supabase
    .from('deposits')
    .select('*')
    .eq('application', application)
    .order('created_at', { ascending: false });

  if (filters.phoneNumber) {
    query = query.eq('phone_number', filters.phoneNumber);
  }
  if (filters.status) {
    query = query.eq('status', filters.status);
  }
  if (filters.limit) {
    query = query.limit(filters.limit);
  }
  if (filters.offset) {
    query = query.range(filters.offset, filters.offset + (filters.limit || 10) - 1);
  }

  const { data, error } = await query;
  return { data, error };
}

/**
 * Update a deposit record
 * @param {string} id
 * @param {object} updates
 */
export async function updateDeposit(id, updates) {
  const { data, error } = await supabase
    .from('deposits')
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select()
    .single();

  return { data, error };
}

/**
 * Compare-and-swap update: only writes if the row is still in expectedStatus.
 * Returns data=null (no error) when another writer already advanced the row —
 * the losing webhook retry/duplicate must treat that as "someone else owns it".
 * @param {string} id
 * @param {string} expectedStatus
 * @param {object} updates
 */
export async function updateDepositIfStatus(id, expectedStatus, updates) {
  const { data, error } = await supabase
    .from('deposits')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', expectedStatus)
    .select()
    .maybeSingle();

  return { data, error };
}
