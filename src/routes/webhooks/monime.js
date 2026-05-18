//@ts-check

import { Hono } from 'hono';
import { verifyWebhookSignature } from '../../utils/monime.js';
import { transferUsdc } from '../../utils/solana.js';
import { getDepositById, updateDeposit } from '../../repos/deposits.js';
import { getWithdrawalById, updateWithdrawal } from '../../repos/withdrawals.js';

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
  const reference = payload.data?.reference;

  console.log(`[Webhook] Received event: ${eventName}, reference: ${reference}`);

  if (!reference) {
    console.error('[Webhook] No reference in payload');
    return c.json({ received: true });
  }

  // Route by event resource type
  if (eventName.startsWith('payment_code.') || eventName.startsWith('checkout_session.')) {
    return handleDepositEvent(c, eventName, reference);
  }

  if (eventName.startsWith('payout.')) {
    return handlePayoutEvent(c, eventName, reference, payload.data);
  }

  console.log(`[Webhook] Ignoring unhandled event type: ${eventName}`);
  return c.json({ received: true });
});

/**
 * @param {any} c
 * @param {string} eventName
 * @param {string} reference
 */
async function handleDepositEvent(c, eventName, reference) {
  const { data: deposit, error } = await getDepositById(reference);

  if (error || !deposit) {
    console.error(`[Webhook] Deposit not found for reference: ${reference}`);
    return c.json({ received: true });
  }

  if (['completed', 'failed', 'expired'].includes(deposit.status)) {
    console.log(`[Webhook] Deposit ${deposit.id} already ${deposit.status}, skipping`);
    return c.json({ received: true });
  }

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
    await handleDepositSuccess(deposit);
  } else if (expiryEvents.includes(eventName)) {
    await updateDeposit(deposit.id, { status: 'expired' });
    console.log(`[Webhook] Deposit ${deposit.id} marked as expired`);
  }

  return c.json({ received: true });
}

/**
 * @param {any} c
 * @param {string} eventName
 * @param {string} reference
 * @param {any} data
 */
async function handlePayoutEvent(c, eventName, reference, data) {
  const { data: withdrawal, error } = await getWithdrawalById(reference);

  if (error || !withdrawal) {
    console.error(`[Webhook] Withdrawal not found for reference: ${reference}`);
    return c.json({ received: true });
  }

  if (['completed', 'failed', 'expired'].includes(withdrawal.status)) {
    console.log(`[Webhook] Withdrawal ${withdrawal.id} already ${withdrawal.status}, skipping`);
    return c.json({ received: true });
  }

  if (eventName === 'payout.completed') {
    await updateWithdrawal(withdrawal.id, { status: 'completed' });
    console.log(`[Webhook] Withdrawal ${withdrawal.id} completed`);
  } else if (eventName === 'payout.failed') {
    const reason = data?.failureDetail?.message || data?.failureDetail?.code || 'Monime payout failed';
    await updateWithdrawal(withdrawal.id, {
      status: 'failed',
      failure_reason: reason
    });
    console.log(`[Webhook] Withdrawal ${withdrawal.id} failed: ${reason}`);
  } else if (eventName === 'payout.delayed') {
    // Informational; keep current status
    console.log(`[Webhook] Withdrawal ${withdrawal.id} delayed (still processing)`);
  }

  return c.json({ received: true });
}

/**
 * Handle a successful deposit — transfer USDC to the user's wallet
 * @param {object} deposit
 */
async function handleDepositSuccess(deposit) {
  try {
    await updateDeposit(deposit.id, { status: 'confirmed' });
    console.log(`[Webhook] Deposit ${deposit.id} confirmed, initiating USDC transfer`);

    await updateDeposit(deposit.id, { status: 'processing' });

    const txSignature = await transferUsdc(
      deposit.wallet_address,
      deposit.amount_usdc
    );

    await updateDeposit(deposit.id, {
      status: 'completed',
      solana_tx_signature: txSignature
    });

    console.log(`[Webhook] Deposit ${deposit.id} completed. Tx: ${txSignature}`);
  } catch (error) {
    console.error(`[Webhook] USDC transfer failed for deposit ${deposit.id}:`, error.message);

    await updateDeposit(deposit.id, {
      status: 'failed',
      failure_reason: error.message
    });
  }
}

export default app;
