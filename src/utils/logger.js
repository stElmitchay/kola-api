//@ts-check

import pino from 'pino';

/**
 * Redacts fields that carry PII/secrets before they ever reach the sink —
 * phone numbers and wallet/destination addresses must never appear at any
 * log level (global-constraints.md). Paths cover both snake_case (DB
 * column names) and camelCase (JS param names) call sites, one level of
 * nesting (`*.<field>`), and two levels of nesting (`*.*.<field>`) for
 * structured fields nested two objects deep (e.g. `{ withdrawal: { meta:
 * { phone_number } } }`).
 *
 * IMPORTANT — pino/fast-redact wildcards match an EXACT number of levels,
 * not "at any depth": `*.*.phone_number` matches `a.b.phone_number` but
 * NOT `a.phone_number` or `a.b.c.phone_number` (verified manually).
 * There is no "redact this field no matter how deep it's nested" path
 * form. This is why call sites that log an arbitrary/unversioned
 * third-party payload (e.g. src/utils/monime.js's vendor error response,
 * whose shape Monime controls, not us) must NOT rely on these paths —
 * they extract a redaction-safe subset (status/error codes/messages) and
 * log that instead of the raw payload. Keep that pattern for any future
 * call site logging data whose shape/depth isn't fixed by our own code.
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
    '*.wallet_address',
    '*.*.phone_number',
    '*.*.phoneNumber',
    '*.*.wallet_address',
    '*.*.walletAddress'
  ],
  censor: '[redacted]'
};

/**
 * Builds a pino logger with the shared redaction config. Accepts an
 * optional destination stream so tests can point at an in-memory sink
 * instead of stdout (F24 redaction test). When no destination is given,
 * writes SYNCHRONOUSLY to stdout (fd 1) via `pino.destination({ sync:
 * true })` instead of pino's default async/buffered SonicBoom transport.
 * On Vercel the function instance can freeze immediately after the
 * response is sent — an async destination's buffered writes (including
 * `alert:true` incident lines emitted at the tail of a request) can be
 * delayed past the freeze and lost entirely. Synchronous stdout writes
 * cost a little throughput but guarantee every line — especially the
 * page-worthy ones — actually lands before the instance freezes.
 * @param {NodeJS.WritableStream} [destination]
 * @returns {import('pino').Logger}
 */
export function createLogger(destination) {
  return pino({ redact: REDACT }, destination ?? pino.destination({ dest: 1, sync: true }));
}

/** Base structured logger (F24) — the process-wide singleton. */
export const logger = createLogger();

export default logger;
