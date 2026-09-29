//@ts-check

import { timingSafeEqual } from 'crypto';
import { logger } from './logger.js';

/**
 * Verify the Helius webhook auth header. Helius lets you configure a static
 * "Authentication Header" value in the dashboard; it sends that exact string
 * back in the Authorization header on every callback. We compare it in
 * constant time against the env-configured expected value.
 *
 * See docs/fixtures/helius/AUTH.md (V-D) for why a static bearer — rather
 * than a signed/HMAC'd webhook — is an acceptable posture here, and for the
 * pending dashboard check on whether the current plan supports signing.
 *
 * @param {string} headerValue
 * @returns {boolean}
 */
export function verifyHeliusAuth(headerValue) {
  const expected = process.env.HELIUS_WEBHOOK_AUTH_HEADER;
  if (!expected) {
    logger.error('[Helius] HELIUS_WEBHOOK_AUTH_HEADER not configured');
    return false;
  }
  if (!headerValue) return false;

  const a = Buffer.from(headerValue);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
