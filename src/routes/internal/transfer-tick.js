//@ts-check
import { Hono } from 'hono';
import {
  listOpenJobs, recordSignature, markSent, markFailedPermanent, bumpAttempt
} from '../../repos/transfer-jobs.js';
import { updateDepositIfStatus } from '../../repos/deposits.js';
import {
  buildSignedUsdcTransfer, checkSignatureLanded, sendSerializedTransaction, getCurrentBlockHeight
} from '../../utils/solana.js';
import { postDepositPayout } from '../../repos/ledger.js';
import { verifyCronAuth } from '../../utils/cron-auth.js';

const MAX_ATTEMPTS = 5;
// ~13s margin (32 slots) against load-balanced RPC backends disagreeing on
// exactly which block is current — never treat a blockhash as expired on a
// hair-trigger height comparison (task C5 revisits this further).
const EXPIRY_MARGIN_SLOTS = 32;
export const DEFAULT_SWEEP_LIMIT = 20;
const app = new Hono();

app.post('/', async (c) => {
  if (!verifyCronAuth(c)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const processed = await sweepOpenJobs(DEFAULT_SWEEP_LIMIT);
  return c.json({ processed });
});

/**
 * Fetch open (queued/sending) transfer jobs and process each one. Shared by
 * the cron route handler and the best-effort `waitUntil` kick fired from
 * the deposit webhook path — the cron sweep is the source of truth either
 * way; the kick just shaves latency off the common case.
 *
 * Each job is isolated: `listOpenJobs` orders oldest-`updated_at`-first, so
 * a single poisoned job (an RPC call that throws instead of resolving)
 * must never block every job behind it. A throw from `processJob` is
 * caught here, the job's attempt counter is bumped (which also bumps its
 * `updated_at`, pushing it to the back of the queue), and the sweep moves
 * on — the poisoned job eventually reaches the attempts-exhausted path
 * instead of head-of-line-blocking the sweep forever.
 * @param {number} limit
 * @returns {Promise<number>} number of jobs processed
 */
export async function sweepOpenJobs(limit) {
  const { data: jobs } = await listOpenJobs(limit);
  for (const job of jobs || []) {
    try {
      await processJob(job);
    } catch (e) {
      console.error(`[TransferTick] job ${job.id} threw outside its own recovery path, isolating: ${e.message}`);
      await bumpAttempt(job.id, e.message);
    }
  }
  return (jobs || []).length;
}

/**
 * Process a single transfer job. The recovery rule is sacred: a job already
 * 'sending' with a persisted signature is NEVER re-signed until its
 * blockhash has provably expired without the signature landing — an
 * ambiguous RPC timeout must never cause a double-pay (F9).
 * Exported for tests.
 * @param {object} job
 */
export async function processJob(job) {
  const isRebuild = job.status === 'sending' && Boolean(job.signature);

  if (isRebuild) {
    const landed = await checkSignatureLanded(job.signature);
    if (landed === 'finalized') return finish(job, job.signature);
    if (landed === 'pending') return;                                  // still confirming — leave it
    const height = await getCurrentBlockHeight();
    if (height <= job.last_valid_block_height + EXPIRY_MARGIN_SLOTS) return; // may still land — NEVER re-sign yet
    // blockhash expired, tx provably dead → fall through to rebuild
  }

  if (job.attempts >= MAX_ATTEMPTS) {
    await markFailedPermanent(job.id, 'max attempts exceeded');
    const failureUpdate = {
      status: 'failed', failure_reason: 'transfer failed permanently — operator action required'
    };
    const { data: fromProcessing, error: processingErr } = await updateDepositIfStatus(
      job.deposit_id, 'processing', failureUpdate
    );
    if (processingErr) {
      console.error(`[TransferTick] deposit ${job.deposit_id} processing->failed CAS error: ${processingErr.message}`);
    }
    if (!fromProcessing && !processingErr) {
      // The deposit hadn't reached 'processing' yet (still 'confirmed') —
      // legal per 0012's state machine. Fall back so it isn't stranded.
      const { data: fromConfirmed, error: confirmedErr } = await updateDepositIfStatus(
        job.deposit_id, 'confirmed', failureUpdate
      );
      if (confirmedErr) {
        console.error(`[TransferTick] deposit ${job.deposit_id} confirmed->failed CAS error: ${confirmedErr.message}`);
      }
      if (!fromConfirmed && !confirmedErr) {
        console.error(
          `[TransferTick] ALERT: deposit ${job.deposit_id} (job ${job.id}) transfer failed permanently but ` +
          `neither processing->failed nor confirmed->failed matched — deposit status needs manual operator investigation`
        );
      }
    }
    return;
  }

  // The exact state this tick observed, used to fence recordSignature
  // against a concurrent tick doing the same thing to the same job.
  const observed = { status: job.status, signature: job.signature ?? null };

  try {
    const built = await buildSignedUsdcTransfer(job.destination, Number(job.amount_usdc));
    // Persist the signature BEFORE broadcast — the whole point of this
    // pipeline. Fenced on `observed`: if another tick already moved this
    // job (e.g. it also built and recorded its own signature first), the
    // WHERE no longer matches and we get data=null here.
    const { data: claimed } = await recordSignature(job.id, built, observed);
    if (!claimed) return;                    // another tick already claimed this job

    const { error: confirmErr } = await updateDepositIfStatus(
      job.deposit_id, 'confirmed', { status: 'processing' }
    );
    if (confirmErr) {
      console.error(`[TransferTick] deposit ${job.deposit_id} confirmed->processing CAS error: ${confirmErr.message}`);
    }
    // Not fenced on the result above: on the re-sign path the deposit is
    // already 'processing' from the first attempt, so this legitimately
    // no-ops without error — that's expected, not a claim loss.

    if (isRebuild) {
      // One more look immediately before broadcast: the OLD signature may
      // have landed in the gap between the recovery check above and now.
      // If so, finish with the tx that actually landed instead of
      // broadcasting a second one.
      const stillLanded = await checkSignatureLanded(job.signature);
      if (stillLanded === 'finalized') return finish(job, job.signature);
    }

    await sendSerializedTransaction(built.serialized, built.signature, built.blockhash, built.lastValidBlockHeight);
    return finish(job, built.signature);
  } catch (e) {
    await bumpAttempt(job.id, e.message);    // status untouched; next tick re-applies the landed/expired rule
  }
}

/**
 * @param {object} job
 * @param {string} signature
 */
async function finish(job, signature) {
  const { data: sentData, error: sentErr } = await markSent(job.id, signature);
  if (sentErr) {
    console.error(`[TransferTick] job ${job.id} markSent error: ${sentErr.message}`);
  } else if (!sentData) {
    console.error(`[TransferTick] job ${job.id} markSent no-op — status was not 'sending' when finish() ran`);
  }

  const { error: completedErr } = await updateDepositIfStatus(job.deposit_id, 'processing', {
    status: 'completed', solana_tx_signature: signature
  });
  if (completedErr) {
    console.error(`[TransferTick] deposit ${job.deposit_id} processing->completed CAS error: ${completedErr.message}`);
  }
  await postDepositPayout({ id: job.deposit_id, amount_usdc: job.amount_usdc });
}

export default app;
