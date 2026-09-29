//@ts-check

import { createSupabaseClient } from '../utils/supabase.js';

const supabase = createSupabaseClient();

/**
 * Create a new withdrawal record via the advisory-locked `create_withdrawal_guarded`
 * RPC (migration 0016). The daily-cap sum and the (wallet, amount) duplicate-open
 * check both run inside that function under a per-phone `pg_advisory_xact_lock`,
 * so two concurrent creates for the same phone can no longer both pass either
 * check (F10 — TOCTOU).
 * @param {object} withdrawal
 * @param {string} withdrawal.application
 * @param {string} withdrawal.phone_number
 * @param {string} withdrawal.from_wallet_address
 * @param {string} withdrawal.provider_code
 * @param {number} withdrawal.amount_usdc
 * @param {number} withdrawal.amount_sle
 * @param {number} [withdrawal.amount_sle_gross]
 * @param {number} withdrawal.fee_bps
 * @param {number} withdrawal.exchange_rate
 * @param {string} withdrawal.expires_at
 * @param {object} [withdrawal.metadata]
 * @param {number} dailyCapUsdc - rolling 24h cap (minor units) enforced inside the RPC
 */
export async function createWithdrawal(withdrawal, dailyCapUsdc) {
  const { data, error } = await supabase.rpc('create_withdrawal_guarded', {
    p: withdrawal,
    p_daily_cap: dailyCapUsdc
  });

  return { data, error };
}

/**
 * Get a withdrawal by ID, scoped to application
 * @param {string} id
 * @param {string} application
 */
export async function getWithdrawal(id, application) {
  const { data, error } = await supabase
    .from('withdrawals')
    .select('*')
    .eq('id', id)
    .eq('application', application)
    .single();

  return { data, error };
}

/**
 * Get a withdrawal by ID without application scoping (for webhooks)
 * @param {string} id
 */
export async function getWithdrawalById(id) {
  const { data, error } = await supabase
    .from('withdrawals')
    .select('*')
    .eq('id', id)
    .single();

  return { data, error };
}

/**
 * Get a withdrawal by the Monime payout ID (set when we trigger the payout).
 * Used by the webhook handler since Monime payouts don't echo back a
 * `reference` field — only the `id` they assigned.
 * @param {string} monimePayoutId
 */
export async function getWithdrawalByMonimePayoutId(monimePayoutId) {
  const { data, error } = await supabase
    .from('withdrawals')
    .select('*')
    .eq('monime_payout_id', monimePayoutId)
    .single();

  return { data, error };
}

/**
 * Find the single open (pending_deposit, not expired) withdrawal matching
 * a (from_wallet_address, amount_usdc) pair. Used in two places:
 *  - initiateWithdrawal: refuse a duplicate while one is open, so the pair
 *    is unique by construction
 *  - Helius auto-confirm handler: identify which withdrawal an incoming
 *    USDC transfer settles
 * Unscoped by application since Helius watches the treasury globally.
 * @param {string} fromWalletAddress
 * @param {number} amountUsdc
 */
export async function findPendingByWalletAndAmount(fromWalletAddress, amountUsdc) {
  const { data, error } = await supabase
    .from('withdrawals')
    .select('*')
    .eq('from_wallet_address', fromWalletAddress)
    .eq('amount_usdc', amountUsdc)
    .eq('status', 'pending_deposit')
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  return { data, error };
}

/**
 * Compare-and-swap update: only writes if the row is still in expectedStatus.
 * Returns data=null (without an error) when another writer has already moved
 * the row past expectedStatus, letting concurrent paths (manual /:id/confirm
 * and Helius auto-confirm) coexist without double-firing the payout.
 * @param {string} id
 * @param {string} expectedStatus
 * @param {object} updates
 */
export async function updateWithdrawalIfStatus(id, expectedStatus, updates) {
  const { data, error } = await supabase
    .from('withdrawals')
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .eq('status', expectedStatus)
    .select()
    .maybeSingle();

  return { data, error };
}

/**
 * List withdrawals with optional filters
 * @param {string} application
 * @param {object} [filters]
 * @param {string} [filters.phoneNumber]
 * @param {string} [filters.status]
 * @param {number} [filters.limit]
 * @param {number} [filters.offset]
 */
export async function listWithdrawals(application, filters = {}) {
  let query = supabase
    .from('withdrawals')
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
 * Update a withdrawal record
 * @param {string} id
 * @param {object} updates
 */
export async function updateWithdrawal(id, updates) {
  const { data, error } = await supabase
    .from('withdrawals')
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select()
    .single();

  return { data, error };
}
