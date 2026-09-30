//@ts-check

import * as Sentry from '@sentry/node';

let initialized = false;

/**
 * Guarded Sentry init — a no-op whenever SENTRY_DSN isn't set (dev/CI/most
 * test runs). Called once from api/index.js at module load, after
 * validateConfig().
 * @returns {void}
 */
export function initSentry() {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({ dsn });
  initialized = true;
}

/**
 * Reports an error to Sentry with request context. No-op (never throws)
 * when Sentry hasn't been initialized (no SENTRY_DSN) — Sentry must never
 * be a hard dependency of the error path itself.
 * @param {Error} err
 * @param {object} [ctx]
 * @returns {void}
 */
export function captureError(err, ctx) {
  if (!initialized) return;
  Sentry.captureException(err, ctx ? { extra: ctx } : undefined);
}

/** Test-only: resets the initialized guard. */
export function __resetSentryForTests() {
  initialized = false;
}
