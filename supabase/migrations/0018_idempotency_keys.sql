-- Idempotency-Key support on money POSTs (F12). A mobile client on a
-- Sierra Leone network *will* retry POSTs; this table lets the deposits
-- and withdrawals idempotency middleware (src/middleware/idempotency.js)
-- claim a (application, scope, key) tuple once, replay the stored
-- response on retry, and reject a reused key with a different body.

CREATE TABLE idempotency_keys (
  key           text NOT NULL,
  application   uuid NOT NULL,
  scope         text NOT NULL,               -- 'deposits' | 'withdrawals'
  request_hash  text NOT NULL,               -- sha256 of raw body
  response_status integer,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application, scope, key)
);
