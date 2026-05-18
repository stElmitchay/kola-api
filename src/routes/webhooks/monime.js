//@ts-check

import { Hono } from 'hono';
import { createHmac } from 'crypto';
import { verifyWebhookSignature } from '../../utils/monime.js';
import { transferUsdc } from '../../utils/solana.js';
import { getDepositById, updateDeposit } from '../../repos/deposits.js';

const app = new Hono();

app.post('/', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('Monime-Signature');
  const verified = signature && verifyWebhookSignature(rawBody, signature);

  // DEBUG: Log everything to figure out Monime's exact signing method
  const secret = process.env.MONIME_WEBHOOK_SECRET || '';
  const parts = {};
  if (signature) {
    for (const part of signature.split(',')) {
      const [key, ...rest] = part.split('=');
      parts[key] = rest.join('=');
    }
  }
  const ts = parts['t'] || '';
  const received = parts['v1'] || '';

  // Try every possible approach
  const a1 = ts ? createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('base64') : '';
  const a2 = ts ? createHmac('sha256', Buffer.from(secret, 'base64')).update(`${ts}.${rawBody}`).digest('base64') : '';
  const a3 = createHmac('sha256', secret).update(rawBody).digest('base64');
  const a4 = createHmac('sha256', Buffer.from(secret, 'base64')).update(rawBody).digest('base64');
  const a5 = ts ? createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex') : '';
  const a6 = createHmac('sha256', secret).update(rawBody).digest('hex');

  console.log(`[Webhook Sig Debug] verified=${verified}`);
  console.log(`[Webhook Sig Debug] received=${received}`);
  console.log(`[Webhook Sig Debug] a1(str,ts.body,b64)=${a1}`);
  console.log(`[Webhook Sig Debug] a2(b64key,ts.body,b64)=${a2}`);
  console.log(`[Webhook Sig Debug] a3(str,body,b64)=${a3}`);
  console.log(`[Webhook Sig Debug] a4(b64key,body,b64)=${a4}`);
  console.log(`[Webhook Sig Debug] a5(str,ts.body,hex)=${a5}`);
  console.log(`[Webhook Sig Debug] a6(str,body,hex)=${a6}`);
  console.log(`[Webhook Sig Debug] bodyLen=${rawBody.length} secretLen=${secret.length} header=${signature}`);

  if (!verified) {
    console.error('[Webhook] Invalid signature — returning 200 to stop retries, NOT processing');
    return c.json({ received: true });
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
