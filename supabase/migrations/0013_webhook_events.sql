-- Exactly-once gate for inbound webhooks (F3, F5). Insert-first: a row
-- existing for (provider, event_id) means this exact delivery was already
-- processed and must be acked without re-processing.
CREATE TABLE webhook_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     text NOT NULL CHECK (provider IN ('monime','helius')),
  event_id     text NOT NULL,           -- provider's id; sha256(rawBody) fallback
  event_name   text NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);
