//@ts-check

import { Hono } from 'hono';
import { verifyWebhookSignature } from '../../utils/monime.js';
import { transferUsdc } from '../../utils/solana.js';
import { getDepositById, updateDeposit } from '../../repos/deposits.js';

const app = new Hono();

app.post('/', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('Monime-Signature');

  // Debug: log what Monime sends vs what we compute
  const { createHmac } = await import('node:crypto');
  const computedHex = createHmac('sha256', process.env.MONIME_WEBHOOK_SECRET || '')
    .update(rawBody)
    .digest('hex');
  const computedBase64 = createHmac('sha256', process.env.MONIME_WEBHOOK_SECRET || '')
    .update(rawBody)
    .digest('base64');
  console.log(`[Webhook Debug] Received signature: ${signature}`);
  console.log(`[Webhook Debug] Computed hex: ${computedHex}`);
  console.log(`[Webhook Debug] Computed base64: ${computedBase64}`);
  console.log(`[Webhook Debug] Body preview: ${rawBody.slice(0, 200)}`);
  console.log(`[Webhook Debug] All headers: ${JSON.stringify(Object.fromEntries(c.req.raw.headers.entries()))}`);

  if (!signature || !verifyWebhookSignature(rawBody, signature)) {
    console.error('[Webhook] Invalid signature');
    return c.json({ error: 'Invalid signature' }, 401);
  }

  const payload = JSON.parse(rawBody);
  const eventName = payload.event?.name;
  const reference = payload.data?.reference;

  console.log(`[Webhook] Received event: ${eventName}, reference: ${reference}`);

  if (!reference) {
    console.error('[Webhook] No reference in payload');
    return c.json({ received: true });
  }

  const { data: deposit, error } = await getDepositById(reference);

  if (error || !deposit) {
    console.error(`[Webhook] Deposit not found for reference: ${reference}`);
    return c.json({ received: true });
  }

  if (deposit.status === 'completed' || deposit.status === 'failed') {
    console.log(`[Webhook] Deposit ${deposit.id} already ${deposit.status}, skipping`);
    return c.json({ received: true });
  }

  const successEvents = [
    'checkout_session.completed',
    'payment_code.completed'
  ];

  const expiryEvents = [
    'checkout_session.expired',
    'checkout_session.cancelled',
    'payment_code.expired'
  ];

  if (successEvents.includes(eventName)) {
    await handlePaymentSuccess(deposit);
  } else if (expiryEvents.includes(eventName)) {
    await updateDeposit(deposit.id, { status: 'expired' });
    console.log(`[Webhook] Deposit ${deposit.id} marked as expired`);
  }

  return c.json({ received: true });
});

/**
 * Handle a successful payment — transfer USDC to the user's wallet
 * @param {object} deposit
 */
async function handlePaymentSuccess(deposit) {
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
