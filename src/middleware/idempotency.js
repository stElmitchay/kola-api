//@ts-check

import { createHash } from 'crypto';
import { createSupabaseClient } from '../utils/supabase.js';
import { errorEnvelope } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const supabase = createSupabaseClient();

/**
 * Idempotency-Key middleware factory for money POSTs (F12). Optional in v1:
 * a missing header passes straight through. When present, the
 * (application, scope, key) triple is claimed via a PK insert on
 * idempotency_keys (0018) — the first writer wins the claim and runs the
 * handler; every other request for the same triple sees the claim fail and
 * is resolved from the stored row instead of re-running the handler.
 * @param {'deposits'|'withdrawals'} scope
 */
export function idempotency(scope) {
  return async (c, next) => {
    const key = c.req.header('Idempotency-Key');
    if (!key) return next(); // optional in v1; docs recommend it

    const application = c.get('application');
    const rawBody = await c.req.text();
    const requestHash = createHash('sha256').update(rawBody).digest('hex');

    // Claim: first writer wins the (application, scope, key) PK.
    const { error: claimErr } = await supabase.from('idempotency_keys')
      .insert({ key, application, scope, request_hash: requestHash });

    if (claimErr) { // row already exists — this request lost the claim
      const { data: row } = await supabase.from('idempotency_keys').select('*')
        .eq('application', application).eq('scope', scope).eq('key', key).single();
      const requestId = c.get('requestId');
      if (!row) return c.json(errorEnvelope('Conflict', 'Idempotency conflict', requestId), 409);
      if (row.request_hash !== requestHash) {
        return c.json(
          errorEnvelope('ValidationError', 'Idempotency-Key reused with a different request body', requestId),
          422
        );
      }
      if (row.response_body === null) {
        c.header('Retry-After', '2');
        return c.json(errorEnvelope('Conflict', 'Original request still in flight', requestId), 409);
      }
      return c.json(row.response_body, row.response_status);
    }

    await next();

    const res = c.res.clone();
    const body = await res.json().catch(() => null);
    const { error: storeErr } = await supabase.from('idempotency_keys')
      .update({ response_status: res.status, response_body: body })
      .eq('application', application).eq('scope', scope).eq('key', key);
    if (storeErr) {
      // Storage failure must never break the response already sent to the client.
      const log = c.get('log') || logger;
      log.error({ alert: true }, `[Idempotency] Failed to store response for ${scope}/${key}: ${storeErr.message}`);
    }
  };
}
