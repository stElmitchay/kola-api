//@ts-check

import { createHmac, timingSafeEqual } from 'crypto';
import { createMonimeError } from './errors.js';

const BASE_URL = 'https://api.monime.io';

/**
 * Make an authenticated request to the Monime API
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 * @param {string} [idempotencyKey]
 * @returns {Promise<any>}
 */
async function monimeRequest(method, path, body, idempotencyKey) {
  /** @type {Record<string, string>} */
  const headers = {
    'Authorization': `Bearer ${process.env.MONIME_ACCESS_TOKEN}`,
    'Monime-Space-Id': process.env.MONIME_SPACE_ID,
    'Content-Type': 'application/json'
  };

  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json();

  if (!response.ok) {
    const message = data.messages?.join(', ') || `Monime API error: ${response.status}`;
    throw createMonimeError(message);
  }

  return data;
}

/**
 * Create a checkout session for mobile money collection
 * @param {object} params
 * @param {string} params.depositId - Our deposit ID (used as reference)
 * @param {number} params.amountMinorUnits - Amount in SLE minor units
 * @param {string} params.successUrl
 * @param {string} params.cancelUrl
 * @param {object} [params.metadata]
 * @returns {Promise<{ id: string, redirectUrl: string, expireTime: string }>}
 */
export async function createCheckoutSession(params) {
  const response = await monimeRequest(
    'POST',
    '/v1/checkout-sessions',
    {
      name: `USDC Purchase - ${params.depositId}`,
      lineItems: [
        {
          type: 'custom',
          name: 'USDC Purchase',
          price: { currency: 'SLE', value: params.amountMinorUnits },
          quantity: 1,
          reference: params.depositId
        }
      ],
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
      reference: params.depositId,
      financialAccountId: process.env.MONIME_FINANCIAL_ACCOUNT_ID,
      paymentOptions: {
        momo: { disable: false },
        card: { disable: true },
        bank: { disable: true },
        wallet: { disable: true }
      },
      metadata: params.metadata || {}
    },
    params.depositId
  );

  return {
    id: response.result.id,
    redirectUrl: response.result.redirectUrl,
    expireTime: response.result.expireTime
  };
}

/**
 * Create a USSD payment code for mobile money collection
 * @param {object} params
 * @param {string} params.depositId - Our deposit ID (used as reference)
 * @param {number} params.amountMinorUnits - Amount in SLE minor units
 * @param {string} params.phoneNumber - Customer phone number
 * @param {string} [params.customerName]
 * @param {object} [params.metadata]
 * @returns {Promise<{ id: string, ussdCode: string, expireTime: string }>}
 */
export async function createPaymentCode(params) {
  const response = await monimeRequest(
    'POST',
    '/v1/payment-codes',
    {
      mode: 'one_time',
      name: `USDC Purchase - ${params.depositId}`,
      amount: { currency: 'SLE', value: params.amountMinorUnits },
      duration: '30m',
      customer: { name: params.customerName || 'Customer' },
      reference: params.depositId,
      authorizedPhoneNumber: params.phoneNumber,
      financialAccountId: process.env.MONIME_FINANCIAL_ACCOUNT_ID,
      metadata: params.metadata || {}
    },
    params.depositId
  );

  return {
    id: response.result.id,
    ussdCode: response.result.ussdCode,
    expireTime: response.result.expireTime
  };
}

/**
 * Get a checkout session by ID
 * @param {string} id
 * @returns {Promise<any>}
 */
export async function getCheckoutSession(id) {
  const response = await monimeRequest('GET', `/v1/checkout-sessions/${id}`);
  return response.result;
}

/**
 * Get a payment code by ID
 * @param {string} id
 * @returns {Promise<any>}
 */
export async function getPaymentCode(id) {
  const response = await monimeRequest('GET', `/v1/payment-codes/${id}`);
  return response.result;
}

/**
 * List mobile money providers for Sierra Leone
 * @returns {Promise<any[]>}
 */
export async function getProviders() {
  const response = await monimeRequest('GET', '/v1/momos?country=SL');
  return response.result;
}

/**
 * Verify Monime webhook signature.
 * Header: "Monime-Signature: t=<unix_seconds>,v1=<base64_hmac>"
 * Signed payload uses underscore: "<timestamp>_<rawBody>". HMAC-SHA256 → base64.
 * @param {string} rawBody
 * @param {string} signatureHeader
 * @returns {boolean}
 */
export function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.MONIME_WEBHOOK_SECRET;
  if (!secret) return false;

  const parts = {};
  for (const part of signatureHeader.split(',')) {
    const [key, ...rest] = part.split('=');
    parts[key] = rest.join('=');
  }
  const timestamp = parts['t'];
  const receivedSig = parts['v1'];
  if (!timestamp || !receivedSig) return false;

  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts)) return false;
  const age = Math.floor(Date.now() / 1000) - ts;
  if (age > 5 * 60 || age < -60) return false;

  const expectedB64 = createHmac('sha256', secret)
    .update(`${timestamp}_${rawBody}`, 'utf8')
    .digest('base64');

  const a = Buffer.from(receivedSig, 'base64');
  const b = Buffer.from(expectedB64, 'base64');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
