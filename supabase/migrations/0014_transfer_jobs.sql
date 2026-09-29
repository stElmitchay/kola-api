-- Durable sign-before-send transfer pipeline (F9). A job's signature is
-- persisted BEFORE broadcast, so an ambiguous RPC timeout can never cause a
-- double-pay: the recovery worker checks whether the persisted signature
-- landed on-chain before ever considering a re-sign.
CREATE TABLE transfer_jobs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id              uuid NOT NULL UNIQUE REFERENCES deposits (id),  -- UNIQUE = enqueue is idempotent
  destination             text NOT NULL,
  amount_usdc             bigint NOT NULL CHECK (amount_usdc > 0),
  status                  text NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','sending','sent','failed_permanent')),
  signature               text,
  blockhash               text,
  last_valid_block_height bigint,
  attempts                integer NOT NULL DEFAULT 0,
  last_error              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_transfer_jobs_open ON transfer_jobs (status, updated_at)
  WHERE status IN ('queued','sending');
