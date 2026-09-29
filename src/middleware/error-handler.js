//@ts-check

import { ZodError } from 'zod';
import { logger } from '../utils/logger.js';
import { captureError } from '../utils/sentry.js';
import { errorEnvelope, zodErrorMessage } from '../utils/errors.js';

/** Map error names to HTTP status codes. */
const STATUS_MAP = {
  ValidationError: 400,
  NotFoundError: 404,
  MonimeError: 502,
  OnChainError: 502,
  DatabaseError: 500
};

/**
 * Route-level error handler (mounted per sub-app via `app.onError`). Emits
 * the one response envelope: `{ error: { code, message, request_id } }`.
 * A schema `.parse()` throw (ZodError) maps to 400 ValidationError with a
 * readable path+message. Known error names keep their status/code; an
 * unknown name is a 500 InternalError with the details withheld from the
 * client (they stay in the log line and, for 5xx, in Sentry).
 * @param {Error} err
 * @param {import('hono').Context} c
 * @returns {Response}
 */
export function errorHandler(err, c) {
  const requestId = c.get('requestId');
  const log = c.get('log') || logger;

  if (err instanceof ZodError) {
    const message = zodErrorMessage(err);
    log.warn({ err }, `[ValidationError] ${message}`);
    return c.json(errorEnvelope('ValidationError', message, requestId), 400);
  }

  const knownStatus = STATUS_MAP[err.name];
  const status = knownStatus || 500;
  const code = knownStatus ? err.name : 'InternalError';
  const isServerError = status >= 500;
  const message = isServerError ? 'Internal error' : err.message;

  log.error({ err }, `[${err.name}] ${err.message}`);

  if (isServerError) {
    captureError(err, { request_id: requestId, route: c.req.routePath });
  }

  return c.json(errorEnvelope(code, message, requestId), status);
}
