-- ============================================================
-- kola-api: Withdrawals table
-- USDC (Solana) → SLE (Mobile Money) flow
-- Used by: src/repos/withdrawals.js, src/routes/withdrawals/*, src/routes/webhooks/monime.js
-- ============================================================

CREATE TABLE withdrawals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application           uuid NOT NULL REFERENCES auth_api_keys (id),
  phone_number          text NOT NULL,
  from_wallet_address   text NOT NULL,
  provider_code         text NOT NULL,
  amount_usdc           bigint NOT NULL,
  amount_sle            bigint NOT NULL,
  fee_bps               integer NOT NULL DEFAULT 0,
  exchange_rate         numeric NOT NULL,
  status                text NOT NULL DEFAULT 'pending_deposit'
                        CHECK (status IN ('pending_deposit', 'received', 'processing', 'completed', 'failed', 'expired')),
  monime_payout_id      text,
  solana_tx_signature   text,
  failure_reason        text,
  metadata              jsonb NOT NULL DEFAULT '{}',
  expires_at            timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_withdrawals_application ON withdrawals (application);
CREATE INDEX idx_withdrawals_phone ON withdrawals (phone_number);
CREATE INDEX idx_withdrawals_status ON withdrawals (status);
CREATE INDEX idx_withdrawals_created ON withdrawals (created_at DESC);
CREATE INDEX idx_withdrawals_from_wallet ON withdrawals (from_wallet_address);

-- Ensure the same Solana tx signature can never be used twice
CREATE UNIQUE INDEX idx_withdrawals_solana_tx ON withdrawals (solana_tx_signature)
  WHERE solana_tx_signature IS NOT NULL;
