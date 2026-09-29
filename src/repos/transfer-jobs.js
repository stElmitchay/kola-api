//@ts-check

import { createSupabaseClient } from '../utils/supabase.js';

const supabase = createSupabaseClient();

/**
 * Idempotently enqueue a transfer job for a confirmed deposit. `deposit_id`
 * is UNIQUE, so a duplicate enqueue (retry, duplicate webhook delivery)
 * upserts onto the existing row instead of creating a second job — that
 * uniqueness is what makes enqueue safe to call more than once for the
 * same deposit.
 * @param {object} params
 * @param {string} params.depositId
 * @param {string} params.destination
 * @param {number} params.amountUsdc
 */
export async function enqueueTransfer({ depositId, destination, amountUsdc }) {
  const { data, error } = await supabase
    .from('transfer_jobs')
    .upsert(
      { deposit_id: depositId, destination, amount_usdc: amountUsdc },
      { onConflict: 'deposit_id', ignoreDuplicates: true }
    )
    .select()
    .maybeSingle();

  return { data, error };
}

/**
 * List open jobs (queued or sending) for the worker tick to process,
 * oldest-updated first.
 * @param {number} limit
 */
export async function listOpenJobs(limit) {
  const { data, error } = await supabase
    .from('transfer_jobs')
    .select('*')
    .in('status', ['queued', 'sending'])
    .order('updated_at', { ascending: true })
    .limit(limit);

  return { data, error };
}

/**
 * Persist a freshly-built signature BEFORE broadcast — the core of the
 * sign-before-send pipeline (F9). CAS on status still being open (queued,
 * or sending when re-signing an expired attempt) so a concurrent tick that
 * already claimed this job cannot be overwritten. Returns data=null
 * (without an error) when another tick won the claim.
 * @param {string} id
 * @param {object} built
 * @param {string} built.signature
 * @param {string} built.blockhash
 * @param {number} built.lastValidBlockHeight
 */
export async function recordSignature(id, { signature, blockhash, lastValidBlockHeight }) {
  const { data, error } = await supabase
    .from('transfer_jobs')
    .update({
      status: 'sending',
      signature,
      blockhash,
      last_valid_block_height: lastValidBlockHeight,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .in('status', ['queued', 'sending'])
    .select()
    .maybeSingle();

  return { data, error };
}

/**
 * Mark a job's signature as landed on-chain (finalized). Terminal state.
 * @param {string} id
 * @param {string} signature
 */
export async function markSent(id, signature) {
  const { data, error } = await supabase
    .from('transfer_jobs')
    .update({ status: 'sent', signature, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .maybeSingle();

  return { data, error };
}

/**
 * Mark a job as permanently failed (attempts exhausted). Terminal state —
 * requires operator action.
 * @param {string} id
 * @param {string} lastError
 */
export async function markFailedPermanent(id, lastError) {
  const { data, error } = await supabase
    .from('transfer_jobs')
    .update({ status: 'failed_permanent', last_error: lastError, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .maybeSingle();

  return { data, error };
}

/**
 * Record a failed build/send attempt and bump the retry counter. Leaves the
 * job in 'sending' so the next tick applies the landed/expired recovery
 * rule rather than blindly retrying. Read-modify-write is acceptable here
 * because only the single-threaded tick loop ever touches `attempts`.
 * @param {string} id
 * @param {string} lastError
 */
export async function bumpAttempt(id, lastError) {
  const { data: current, error: readError } = await supabase
    .from('transfer_jobs')
    .select('attempts')
    .eq('id', id)
    .single();
  if (readError) return { data: null, error: readError };

  const { data, error } = await supabase
    .from('transfer_jobs')
    .update({
      status: 'sending',
      attempts: current.attempts + 1,
      last_error: lastError,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select()
    .maybeSingle();

  return { data, error };
}
