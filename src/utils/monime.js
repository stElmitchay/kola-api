//@ts-check

import { createHmac, timingSafeEqual } from 'crypto';
import { createMonimeError } from './errors.js';
import { logger } from './logger.js';
import { envInt, envStr } from './config.js';

const DEFAULT_BASE_URL = 'https://api.monime.io';

/**
 * Monime API base URL. Live-reading (not cached) so game-day drills and
 * tests can point it at a local stand-in (e.g. a one-liner 500 server) via
 * `MONIME_BASE_URL` without a restart; production leaves it unset and gets
 * the real Monime API unchanged.
 * @returns {string}
 */
export function monimeBaseUrl() {
  return envStr('MONIME_BASE_URL', DEFAULT_BASE_URL);
}

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

  const timeoutMs = envInt('MONIME_TIMEOUT_MS');

  let response;
  try {
    response = await fetch(`${monimeBaseUrl()}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw createMonimeError(`Monime request timed out after ${timeoutMs}ms — outcome unknown, do not assume failure`);
    }
    throw err;
  }

  const data = await response.json();

  if (!response.ok) {
    // Surface as much detail as possible
    const detail =
      (Array.isArray(data.messages) && data.messages.join(', ')) ||
      (Array.isArray(data.errors) && data.errors.map(e => e.message || JSON.stringify(e)).join(', ')) ||
      data.error?.message ||
      data.message ||
      JSON.stringify(data);
    // Deliberately do NOT log the raw vendor `data` object: its shape is
    // whatever Monime sends back (arbitrary, unversioned), so it can nest
    // a rejected payout's phone/wallet destination at any depth. The
    // logger's redact paths only match an exact, fixed depth (verified:
    // pino/fast-redact wildcards like '*.*.phone_number' match exactly
    // two levels of nesting, not "at any depth") — they can't reliably
    // cover a shape we don't control. Log only the derived `detail`
    // string (error codes/messages) plus request metadata instead.
    logger.error({ status: response.status, path, method, detail }, '[Monime] request failed');
    throw createMonimeError(`Monime API error ${response.status}: ${detail}`);
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
 * Create a payout to a Mobile Money wallet.
 * @param {object} params
 * @param {string} params.withdrawalId - Our withdrawal ID (used as reference + idempotency key)
 * @param {number} params.amountMinorUnits - SLE amount in minor units (1 SLE = 100)
 * @param {string} params.phoneNumber - Destination MoMo phone (e.g. "+23279688339")
 * @param {string} params.providerCode - Monime momo provider code (e.g. "m17" for Orange)
 * @param {object} [params.metadata]
 * @returns {Promise<{ id: string, status: string }>}
 */
export async function createPayout(params) {
  const response = await monimeRequest(
    'POST',
    '/v1/payouts',
    {
      amount: { currency: 'SLE', value: params.amountMinorUnits },
      source: { financialAccountId: process.env.MONIME_FINANCIAL_ACCOUNT_ID },
      destination: {
        type: 'momo',
        providerId: params.providerCode,
        phoneNumber: params.phoneNumber
      },
      metadata: { ...(params.metadata || {}), withdrawal_id: params.withdrawalId }
    },
    params.withdrawalId
  );

  return {
    id: response.result.id,
    status: response.result.status
  };
}

/**
 * Get a payout by ID
 * @param {string} id
 * @returns {Promise<any>}
 */
export async function getPayout(id) {
  const response = await monimeRequest('GET', `/v1/payouts/${id}`);
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
