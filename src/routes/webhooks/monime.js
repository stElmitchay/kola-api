//@ts-check

import { Hono } from 'hono';
import { verifyWebhookSignature } from '../../utils/monime.js';
import { transferUsdc } from '../../utils/solana.js';
import { getDepositById, updateDepositIfStatus } from '../../repos/deposits.js';
import {
  getWithdrawalById,
  getWithdrawalByMonimePayoutId,
  updateWithdrawal
} from '../../repos/withdrawals.js';
import { recordWebhookEvent } from '../../repos/webhook-events.js';

const app = new Hono();

app.post('/', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('Monime-Signature');

  if (!signature || !verifyWebhookSignature(rawBody, signature)) {
    console.error('[Webhook] Invalid signature');
    return c.json({ error: 'Invalid signature' }, 401);
  }

  const payload = JSON.parse(rawBody);
  const eventName = payload.event?.name || '';
  // ASSUMPTION(V-A): verify against docs/fixtures/monime/ — fixture wins
  const eventId = payload.event?.id;

  const { isNew, error: gateError } = await recordWebhookEvent('monime', eventId, eventName, payload, rawBody);
  if (gateError) {
    console.error(`[Webhook] Event gate error for ${eventName}: ${gateError.message}`);
    c.header('Retry-After', '60');
    return c.json({ error: 'Event gate unavailable' }, 503);
  }
  if (!isNew) {
    return c.json({ received: true, duplicate: true });
  }

  console.log(`[Webhook] Received event: ${eventName}`);

  // Route by event resource type. Each handler is responsible for extracting
  // the identifier it needs (reference for deposits, payout id for payouts).
  if (eventName.startsWith('payment_code.') || eventName.startsWith('checkout_session.')) {
    const reference = payload.data?.reference;
    if (!reference) {
      console.error('[Webhook] No reference in deposit payload');
      return c.json({ received: true });
    }
    return handleDepositEvent(c, eventName, reference, payload);
  }

  if (eventName.startsWith('payout.')) {
    return handlePayoutEvent(c, eventName, payload.data);
  }

  console.log(`[Webhook] Ignoring unhandled event type: ${eventName}`);
  return c.json({ received: true });
});

/**
 * @param {any} c
 * @param {string} eventName
 * @param {string} reference
 * @param {any} payload
 */
async function handleDepositEvent(c, eventName, reference, payload) {
  const { data: deposit, error } = await getDepositById(reference);

  if (error || !deposit) {
    console.error(`[Webhook] Deposit not found for reference: ${reference}`);
    return c.json({ received: true });
  }

  if (['completed', 'failed', 'expired'].includes(deposit.status)) {
    console.log(`[Webhook] Deposit ${deposit.id} already ${deposit.status}, skipping`);
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
      console.error(`[Webhook] AMOUNT MISMATCH deposit=${deposit.id}`); // C4 upgrades this to a paged alert
      return c.json({ received: true });
    }
    await handleDepositSuccess(deposit);
  } else if (expiryEvents.includes(eventName)) {
    await updateDepositIfStatus(deposit.id, 'pending', { status: 'expired' });
    console.log(`[Webhook] Deposit ${deposit.id} marked as expired`);
  }

  return c.json({ received: true });
}

/**
 * @param {any} c
 * @param {string} eventName
 * @param {any} data
 */
async function handlePayoutEvent(c, eventName, data) {
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
    console.error(`[Webhook] Withdrawal not found for payout id=${payoutId} / metadata=${metadataWithdrawalId}`);
    return c.json({ received: true });
  }

  if (['completed', 'failed', 'expired'].includes(withdrawal.status)) {
    console.log(`[Webhook] Withdrawal ${withdrawal.id} already ${withdrawal.status}, skipping`);
    return c.json({ received: true });
  }

  if (eventName === 'payout.completed') {
    const { error: writeErr } = await updateWithdrawal(withdrawal.id, { status: 'completed' });
    if (writeErr) {
      console.error(`[Webhook] Failed to mark withdrawal ${withdrawal.id} as completed: ${writeErr.message}`);
    } else {
      console.log(`[Webhook] Withdrawal ${withdrawal.id} completed`);
    }
  } else if (eventName === 'payout.failed') {
    const reason = data?.failureDetail?.message || data?.failureDetail?.code || 'Monime payout failed';
    const { error: writeErr } = await updateWithdrawal(withdrawal.id, {
      status: 'failed',
      failure_reason: reason
    });
    if (writeErr) {
      console.error(`[Webhook] Failed to mark withdrawal ${withdrawal.id} as failed: ${writeErr.message}`);
    } else {
      console.log(`[Webhook] Withdrawal ${withdrawal.id} failed: ${reason}`);
    }
  }

  return c.json({ received: true });
}

/**
 * Handle a successful deposit — transfer USDC to the user's wallet.
 * CAS pending → processing is the claim: exactly one delivery of this
 * event (original, retry, or duplicate event name) wins the claim; every
 * other delivery sees data=null and returns without touching the chain.
 * Exported for tests.
 * @param {object} deposit
 */
export async function handleDepositSuccess(deposit) {
  const { data: claimed, error: claimErr } = await updateDepositIfStatus(
    deposit.id, 'pending', { status: 'processing' }
  );
  if (claimErr) {
    console.error(`[Webhook] Deposit ${deposit.id} claim failed: ${claimErr.message}`);
    return;
  }
  if (!claimed) {
    console.log(`[Webhook] Deposit ${deposit.id} already claimed, skipping`);
    return;
  }

  try {
    const txSignature = await transferUsdc(claimed.wallet_address, claimed.amount_usdc);
    await updateDepositIfStatus(deposit.id, 'processing', {
      status: 'completed', solana_tx_signature: txSignature
    });
  } catch (error) {
    console.error(`[Webhook] USDC transfer failed for deposit ${deposit.id}: ${error.message}`);
    await updateDepositIfStatus(deposit.id, 'processing', {
      status: 'failed', failure_reason: error.message
    });
  }
}

export default app;
