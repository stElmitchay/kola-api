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
 * sign-before-send pipeline (F9). Fences on the EXACT prior state the
 * caller observed (`observed.status`, `observed.signature`), not merely
 * "status is still open": under READ COMMITTED, two concurrent ticks can
 * both read a job as 'queued'/'sending', both build a (different, both
 * valid) signature, and a same-status-only WHERE clause would let both
 * writes match in turn — one after the other commits — causing a
 * double-broadcast. Fencing on the observed signature too means the
 * second writer's WHERE no longer matches once the first writer's UPDATE
 * has landed (the signature column moved out from under it), so it gets
 * data=null exactly like any other lost claim.
 *
 * This supersedes the brief's `.neq('signature', built.signature)` guard,
 * which was a no-op in practice: `built.signature` is always the caller's
 * own freshly-built signature, so it can never equal the row's *current*
 * signature at the time of the query — the guard never excluded anything.
 *
 * @param {string} id
 * @param {object} built
 * @param {string} built.signature
 * @param {string} built.blockhash
 * @param {number} built.lastValidBlockHeight
 * @param {object} observed - the status/signature the caller read before building
 * @param {string} observed.status
 * @param {string | null} observed.signature
 */
export async function recordSignature(id, { signature, blockhash, lastValidBlockHeight }, observed) {
  let query = supabase
    .from('transfer_jobs')
    .update({
      status: 'sending',
      signature,
      blockhash,
      last_valid_block_height: lastValidBlockHeight,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .eq('status', observed.status);

  query = observed.signature === null
    ? query.is('signature', null)
    : query.eq('signature', observed.signature);

  const { data, error } = await query.select().maybeSingle();

  return { data, error };
}

/**
 * Mark a job's signature as landed on-chain (finalized). Terminal state.
 * CAS on status still being 'sending' — a no-op result here means the job
 * moved out from under this tick some other way and is worth a look.
 * @param {string} id
 * @param {string} signature
 */
export async function markSent(id, signature) {
  const { data, error } = await supabase
    .from('transfer_jobs')
    .update({ status: 'sent', signature, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'sending')
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
 * Record a failed attempt and bump the retry counter, WITHOUT touching
 * status: a build-failed job stays 'queued', a send-failed job stays
 * 'sending' with its already-persisted signature intact — this function
 * must never be the thing that flips a job into 'sending' or fabricates a
 * status transition. Also used by the sweep's per-job isolation (a
 * throwing job is bumped and pushed to the back of the queue via
 * `updated_at` rather than blocking the rest of the sweep). Read-modify-
 * write is acceptable here because only the single-threaded tick loop
 * ever touches `attempts`.
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
      attempts: current.attempts + 1,
      last_error: lastError,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select()
    .maybeSingle();

  return { data, error };
}
