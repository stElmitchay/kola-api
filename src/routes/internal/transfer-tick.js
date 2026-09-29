//@ts-check
import { Hono } from 'hono';
import { timingSafeEqual, createHash } from 'crypto';
import {
  listOpenJobs, recordSignature, markSent, markFailedPermanent, bumpAttempt
} from '../../repos/transfer-jobs.js';
import { updateDepositIfStatus } from '../../repos/deposits.js';
import {
  buildSignedUsdcTransfer, checkSignatureLanded, sendSerializedTransaction, getCurrentBlockHeight
} from '../../utils/solana.js';

const MAX_ATTEMPTS = 5;
export const DEFAULT_SWEEP_LIMIT = 20;
const app = new Hono();
const digest = (s) => createHash('sha256').update(s, 'utf8').digest();

/**
 * Constant-time compare against CRON_SECRET. Fails closed (returns false,
 * never throws) when either side is empty.
 * @param {string} got
 */
function matchesCronSecret(got) {
  const expected = process.env.CRON_SECRET;
  if (!got || !expected) return false;
  return timingSafeEqual(digest(got), digest(expected));
}

app.post('/', async (c) => {
  // Vercel cron sends `Authorization: Bearer $CRON_SECRET`; an operator or
  // manual trigger may instead send `X-Cron-Secret`. Either is accepted.
  const bearer = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '');
  const cronHeader = c.req.header('X-Cron-Secret') || '';
  if (!matchesCronSecret(bearer) && !matchesCronSecret(cronHeader)) {
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
 * @param {number} limit
 * @returns {Promise<number>} number of jobs processed
 */
export async function sweepOpenJobs(limit) {
  const { data: jobs } = await listOpenJobs(limit);
  for (const job of jobs || []) await processJob(job);
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
  if (job.status === 'sending' && job.signature) {
    const landed = await checkSignatureLanded(job.signature);
    if (landed === 'finalized') return finish(job, job.signature);
    if (landed === 'pending') return;                                  // still confirming — leave it
    const height = await getCurrentBlockHeight();
    if (height <= job.last_valid_block_height) return;                 // may still land — NEVER re-sign yet
    // blockhash expired, tx provably dead → fall through to rebuild
  }

  if (job.attempts >= MAX_ATTEMPTS) {
    await markFailedPermanent(job.id, 'max attempts exceeded');
    await updateDepositIfStatus(job.deposit_id, 'processing', {
      status: 'failed', failure_reason: 'transfer failed permanently — operator action required'
    });
    return;
  }

  try {
    const built = await buildSignedUsdcTransfer(job.destination, Number(job.amount_usdc));
    // Persist the signature BEFORE broadcast — the whole point of this pipeline.
    const { data: claimed } = await recordSignature(job.id, built);
    if (!claimed) return;                                              // another tick claimed it
    await updateDepositIfStatus(job.deposit_id, 'confirmed', { status: 'processing' });
    await sendSerializedTransaction(built.serialized, built.signature, built.blockhash, built.lastValidBlockHeight);
    return finish(job, built.signature);
  } catch (e) {
    await bumpAttempt(job.id, e.message);                              // stays 'sending'; next tick applies the landed/expired rule
  }
}

/**
 * @param {object} job
 * @param {string} signature
 */
async function finish(job, signature) {
  await markSent(job.id, signature);
  await updateDepositIfStatus(job.deposit_id, 'processing', {
    status: 'completed', solana_tx_signature: signature
  });
  // B4 wires postJournal('deposit_payout', ...) here.
}

export default app;
