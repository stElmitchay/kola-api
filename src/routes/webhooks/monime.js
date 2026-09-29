//@ts-check

import { Hono } from 'hono';
import { waitUntil } from '@vercel/functions';
import { verifyWebhookSignature } from '../../utils/monime.js';
import { getDepositById, updateDepositIfStatus } from '../../repos/deposits.js';
import {
  getWithdrawalById,
  getWithdrawalByMonimePayoutId,
  updateWithdrawal
} from '../../repos/withdrawals.js';
import { recordWebhookEvent } from '../../repos/webhook-events.js';
import { enqueueTransfer } from '../../repos/transfer-jobs.js';
import { sweepOpenJobs, DEFAULT_SWEEP_LIMIT } from '../internal/transfer-tick.js';
import { postDepositCollection, postWithdrawalPayout } from '../../repos/ledger.js';
import { errorEnvelope } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

const app = new Hono();

app.post('/', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('Monime-Signature');
  const log = c.get('log') || logger;

  if (!signature || !verifyWebhookSignature(rawBody, signature)) {
    log.error('[Webhook] Invalid signature');
    return c.json(errorEnvelope('Unauthorized', 'Invalid signature', c.get('requestId')), 401);
  }

  const payload = JSON.parse(rawBody);
  const eventName = payload.event?.name || '';
  // ASSUMPTION(V-A): verify against docs/fixtures/monime/ — fixture wins
  const eventId = payload.event?.id;

  const { isNew, error: gateError } = await recordWebhookEvent('monime', eventId, eventName, payload, rawBody);
  if (gateError) {
    log.error({ alert: true }, `[Webhook] Event gate error for ${eventName}: ${gateError.message}`);
    c.header('Retry-After', '60');
    return c.json(errorEnvelope('ServiceUnavailable', 'Event gate unavailable', c.get('requestId')), 503);
  }
  if (!isNew) {
    return c.json({ received: true, duplicate: true });
  }

  log.info(`[Webhook] Received event: ${eventName}`);

  // Route by event resource type. Each handler is responsible for extracting
  // the identifier it needs (reference for deposits, payout id for payouts).
  if (eventName.startsWith('payment_code.') || eventName.startsWith('checkout_session.')) {
    const reference = payload.data?.reference;
    if (!reference) {
      log.error('[Webhook] No reference in deposit payload');
      return c.json({ received: true });
    }
    return handleDepositEvent(c, eventName, reference, payload);
  }

  if (eventName.startsWith('payout.')) {
    return handlePayoutEvent(c, eventName, payload.data);
  }

  log.info(`[Webhook] Ignoring unhandled event type: ${eventName}`);
  return c.json({ received: true });
});

/**
 * @param {any} c
 * @param {string} eventName
 * @param {string} reference
 * @param {any} payload
 */
async function handleDepositEvent(c, eventName, reference, payload) {
  const log = c.get('log') || logger;
  const { data: deposit, error } = await getDepositById(reference);

  if (error || !deposit) {
    log.error(`[Webhook] Deposit not found for reference: ${reference}`);
    return c.json({ received: true });
  }

  if (['completed', 'failed', 'expired'].includes(deposit.status)) {
    log.info(`[Webhook] Deposit ${deposit.id} already ${deposit.status}, skipping`);
    return c.json({ received: true });
  }

  // 'payment_code.processed' is kept alongside 'completed' deliberately —
  // see the "Standing decision" in docs/fixtures/monime/README.md. Without
  // fixture evidence that both fire for one payment, removing it risks
  // stranding USSD deposits whose only terminal event might be 'processed';
  // the A3 CAS claim in handleDepositSuccess already makes a double-fire
  // from both events arriving harmless.
  const successEvents = [
    'checkout_session.completed',
    'payment_code.completed',
    'payment_code.processed'
  ];

  const expiryEvents = [
    'checkout_session.expired',
    'checkout_session.cancelled',
    'payment_code.expired'
  ];

  if (successEvents.includes(eventName)) {
    // ASSUMPTION(V-A): verify against docs/fixtures/monime/ — fixture wins
    const paid = payload.data?.amount?.value; // SLE minor units
    if (typeof paid !== 'number' || paid !== Number(deposit.amount_sle)) {
      await updateDepositIfStatus(deposit.id, 'pending', {
        status: 'amount_mismatch',
        failure_reason: `collected=${paid ?? 'absent'} quoted=${deposit.amount_sle}`
      });
      log.error({ alert: true }, `[Webhook] AMOUNT MISMATCH deposit=${deposit.id}`);
      return c.json({ received: true });
    }
    await handleDepositSuccess(deposit);
  } else if (expiryEvents.includes(eventName)) {
    await updateDepositIfStatus(deposit.id, 'pending', { status: 'expired' });
    log.info(`[Webhook] Deposit ${deposit.id} marked as expired`);
  }

  return c.json({ received: true });
}

/**
 * @param {any} c
 * @param {string} eventName
 * @param {any} data
 */
async function handlePayoutEvent(c, eventName, data) {
  const log = c.get('log') || logger;
  // Payout webhooks identify the payout via `data.id` (Monime's payout id we
  // stored when triggering it). Fall back to metadata.withdrawal_id.
  const payoutId = data?.id;
  const metadataWithdrawalId = data?.metadata?.withdrawal_id;

  let result = null;
  if (payoutId) {
    result = await getWithdrawalByMonimePayoutId(payoutId);
  }
  if ((!result || !result.data) && metadataWithdrawalId) {
    result = await getWithdrawalById(metadataWithdrawalId);
  }

  const withdrawal = result?.data;
  if (!withdrawal) {
    log.error(`[Webhook] Withdrawal not found for payout id=${payoutId} / metadata=${metadataWithdrawalId}`);
    return c.json({ received: true });
  }

  if (['completed', 'failed', 'expired'].includes(withdrawal.status)) {
    log.info(`[Webhook] Withdrawal ${withdrawal.id} already ${withdrawal.status}, skipping`);
    return c.json({ received: true });
  }

  if (eventName === 'payout.completed') {
    const { error: writeErr } = await updateWithdrawal(withdrawal.id, { status: 'completed' });
    if (writeErr) {
      log.error(`[Webhook] Failed to mark withdrawal ${withdrawal.id} as completed: ${writeErr.message}`);
    } else {
      log.info(`[Webhook] Withdrawal ${withdrawal.id} completed`);
      await postWithdrawalPayout(withdrawal);
    }
  } else if (eventName === 'payout.failed') {
    const reason = data?.failureDetail?.message || data?.failureDetail?.code || 'Monime payout failed';
    const { error: writeErr } = await updateWithdrawal(withdrawal.id, {
      status: 'failed',
      failure_reason: reason
    });
    if (writeErr) {
      log.error(`[Webhook] Failed to mark withdrawal ${withdrawal.id} as failed: ${writeErr.message}`);
    } else {
      log.info(`[Webhook] Withdrawal ${withdrawal.id} failed: ${reason}`);
    }
  }

  return c.json({ received: true });
}

/**
 * Handle a successful deposit — enqueue the USDC payout instead of sending
 * it inline. CAS pending → confirmed is the claim: exactly one delivery of
 * this event (original, retry, or duplicate event name) wins the claim;
 * every other delivery sees data=null and returns without enqueueing a
 * second job (enqueueTransfer is additionally idempotent on deposit_id).
 * The actual transfer runs off-path in the transfer-tick worker (F9) —
 * this keeps the webhook ack under a second regardless of RPC latency.
 * Exported for tests.
 * @param {object} deposit
 */
export async function handleDepositSuccess(deposit) {
  const { data: claimed, error: claimErr } = await updateDepositIfStatus(
    deposit.id, 'pending', { status: 'confirmed' }
  );
  if (claimErr) {
    logger.error(`[Webhook] Deposit ${deposit.id} claim failed: ${claimErr.message}`);
    return;
  }
  if (!claimed) {
    logger.info(`[Webhook] Deposit ${deposit.id} already claimed, skipping`);
    return;
  }

  await postDepositCollection(claimed);

  const { error: enqueueErr } = await enqueueTransfer({
    depositId: deposit.id,
    destination: claimed.wallet_address,
    amountUsdc: claimed.amount_usdc
  });
  if (enqueueErr) {
    logger.error(`[Webhook] enqueueTransfer failed for deposit ${deposit.id}: ${enqueueErr.message}`);
  }

  // Best-effort immediate kick so the payout doesn't sit idle until the next
  // cron tick (up to 60s away). A missing/failing waitUntil must NEVER break
  // the webhook path — the cron sweep processes anything missed regardless.
  // Both the synchronous call (waitUntil itself throwing, e.g. outside a
  // Vercel execution context) and the async sweep it schedules are guarded.
  try {
    waitUntil(
      sweepOpenJobs(DEFAULT_SWEEP_LIMIT).catch((error) => {
        logger.error(`[Webhook] waitUntil kick's sweepOpenJobs failed for deposit ${deposit.id}: ${error.message}`);
      })
    );
  } catch (error) {
    logger.error(`[Webhook] waitUntil kick failed for deposit ${deposit.id}: ${error.message}`);
  }
}

export default app;
