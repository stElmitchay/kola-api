//@ts-check

import { createSupabaseClient } from '../utils/supabase.js';

const supabase = createSupabaseClient();

/**
 * Book an inbound USDC transfer that has no matching open withdrawal to the
 * suspense table (F11), instead of dropping it. `signature` is UNIQUE
 * (migration 0017) — a replayed webhook delivery for the same on-chain tx
 * hits the `ON CONFLICT (signature) DO NOTHING` upsert and `data` comes
 * back `null` with no error, which the caller treats as "already booked,
 * nothing further to do" (no second suspense_in journal).
 * @param {object} params
 * @param {string} params.signature
 * @param {string} params.from_wallet
 * @param {number} params.amount_usdc
 * @param {'no_open_match'|'lookup_error'} params.reason
 * @returns {Promise<{data: object|null, error: any}>}
 */
export async function recordUnmatched({ signature, from_wallet, amount_usdc, reason }) {
  const { data, error } = await supabase
    .from('unmatched_transfers')
    .upsert(
      { signature, from_wallet, amount_usdc, reason },
      { onConflict: 'signature', ignoreDuplicates: true }
    )
    .select()
    .maybeSingle();

  return { data, error };
}

/**
 * List unmatched transfers, newest first. Used by the admin endpoint.
 * @param {object} [filters]
 * @param {string} [filters.status]
 * @param {number} [filters.limit]
 * @param {number} [filters.offset]
 */
export async function listUnmatched(filters = {}) {
  let query = supabase
    .from('unmatched_transfers')
    .select('*')
    .order('created_at', { ascending: false });

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
