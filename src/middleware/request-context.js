//@ts-check

import { logger } from '../utils/logger.js';

/**
 * Mounted first in api/index.js (before killSwitch) so every request —
 * even one rejected by the kill switch, auth, or rate limiting — gets a
 * request id and exactly one access-log line on completion. Sets
 * `requestId` (used by the error envelope) and `log` (a pino child bound
 * to that request id, for downstream handlers/middleware to log through)
 * in the Hono context.
 * @param {import('hono').Context} c
 * @param {Function} next
 */
export async function requestContext(c, next) {
  const requestId = crypto.randomUUID();
  const log = logger.child({ request_id: requestId });
  c.set('requestId', requestId);
  c.set('log', log);

  const start = Date.now();
  await next();
  const latencyMs = Date.now() - start;

  const application = c.get('application');
  log.info({
    route: c.req.routePath,
    method: c.req.method,
    status: c.res.status,
    latency_ms: latencyMs,
    request_id: requestId,
    ...(application ? { application } : {})
  }, 'request completed');
}
