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

  if (!signature || !verifyWebhookSignature(rawBody, signature)) {
    // Temporary debug: return what we see so we can diagnose the mismatch
    const secret = process.env.MONIME_WEBHOOK_SECRET || '';
    const parts = {};
    if (signature) {
      for (const part of signature.split(',')) {
        const [key, ...rest] = part.split('=');
        parts[key] = rest.join('=');
      }
    }
    const ts = parts['t'] || '';
    const computed = ts ? createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('base64') : 'no-ts';

    console.error('[Webhook] Invalid signature');
    return c.json({
      error: 'Invalid signature',
      debug: {
        bodyLength: rawBody.length,
        bodyFirst80: rawBody.substring(0, 80),
        bodyLast40: rawBody.substring(rawBody.length - 40),
        signatureHeader: signature || 'missing',
        secretPrefix: secret.substring(0, 6),
        secretSuffix: secret.substring(secret.length - 6),
        secretLength: secret.length,
        secretCharCodes: JSON.stringify([...secret].slice(-5).map(c => c.charCodeAt(0))),
        computedSig: computed,
        receivedSig: parts['v1'] || 'missing'
      }
    }, 401);
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
