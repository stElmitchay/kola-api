//@ts-check

import { createHmac } from 'crypto';

/**
 * Hash an API key using HMAC-SHA256 with the salt
 * @param {string} apiKey
 * @returns {string}
 */
export function hashApiKey(apiKey) {
  return createHmac('sha256', process.env.API_KEY_SALT)
    .update(apiKey)
    .digest('hex');
}
