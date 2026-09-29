//@ts-check

import pino from 'pino';

/**
 * Redacts fields that carry PII/secrets before they ever reach the sink —
 * phone numbers and wallet/destination addresses must never appear at any
 * log level (global-constraints.md). Paths cover both snake_case (DB
 * column names) and camelCase (JS param names) call sites, plus one level
 * of nesting via the wildcard variants.
 */
const REDACT = {
  paths: [
    'phone_number',
    'phoneNumber',
    'wallet_address',
    'walletAddress',
    'destination',
    'from_wallet',
    '*.phone_number',
    '*.wallet_address'
  ],
  censor: '[redacted]'
};

/**
 * Builds a pino logger with the shared redaction config. Accepts an
 * optional destination stream so tests can point at an in-memory sink
 * instead of stdout (F24 redaction test).
 * @param {NodeJS.WritableStream} [destination]
 * @returns {import('pino').Logger}
 */
export function createLogger(destination) {
  return destination ? pino({ redact: REDACT }, destination) : pino({ redact: REDACT });
}

/** Base structured logger (F24) — the process-wide singleton. */
export const logger = createLogger();

export default logger;
