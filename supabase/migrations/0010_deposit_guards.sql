-- Same guarantee withdrawals already have: one signature, one row, ever.
CREATE UNIQUE INDEX uq_deposits_solana_tx ON deposits (solana_tx_signature)
  WHERE solana_tx_signature IS NOT NULL;
