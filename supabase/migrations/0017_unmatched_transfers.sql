-- Suspense accounting for unmatched inbound USDC (F11). Any USDC that lands
-- on the treasury wallet with no matching open withdrawal must be booked
-- here instead of silently dropped by the Helius handler — `signature` is
-- UNIQUE so a replayed webhook delivery for the same on-chain tx books
-- exactly once.

CREATE TABLE unmatched_transfers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signature    text NOT NULL UNIQUE,     -- exactly-once booking per on-chain tx
  from_wallet  text NOT NULL,
  amount_usdc  bigint NOT NULL,
  reason       text NOT NULL,            -- 'no_open_match' | 'lookup_error'
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','refunded','matched','written_off')),
  resolution_note text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
