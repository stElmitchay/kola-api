-- ============================================================
-- kola-api: Initial Database Schema
-- Mobile Money (SLE) → USDC On-Ramp
-- ============================================================

-- 1. API Keys
-- Used by: src/repos/api-keys.js, src/middleware/api-key-auth.js
-- ============================================================

CREATE TABLE auth_api_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       text NOT NULL,
  key_hash        text NOT NULL UNIQUE,
  name            text NOT NULL,
  business_name   text NOT NULL,
  app_name        text NOT NULL,
  expires_at      timestamptz,
  permissions     jsonb NOT NULL DEFAULT '{}',
  rate_limit      integer NOT NULL DEFAULT 100,
  is_active       boolean NOT NULL DEFAULT true,
  last_used_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_keys_client_id ON auth_api_keys (client_id);
CREATE INDEX idx_api_keys_active ON auth_api_keys (is_active) WHERE is_active = true;


-- 2. Deposits
-- Used by: src/repos/deposits.js, src/routes/webhooks/monime.js
-- ============================================================

CREATE TABLE deposits (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application           uuid NOT NULL REFERENCES auth_api_keys (id),
  phone_number          text NOT NULL,
  wallet_address        text NOT NULL,
  wallet_type           text NOT NULL CHECK (wallet_type IN ('derived', 'provided')),
  amount_sle            bigint NOT NULL,
  amount_usdc           bigint NOT NULL,
  exchange_rate         numeric NOT NULL,
  payment_method        text NOT NULL CHECK (payment_method IN ('checkout', 'ussd')),
  monime_resource_id    text,
  monime_order_number   text,
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'confirmed', 'processing', 'completed', 'failed', 'expired')),
  solana_tx_signature   text,
  failure_reason        text,
  metadata              jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_deposits_application ON deposits (application);
CREATE INDEX idx_deposits_phone ON deposits (phone_number);
CREATE INDEX idx_deposits_status ON deposits (status);
CREATE INDEX idx_deposits_created ON deposits (created_at DESC);


-- 3. Exchange Rates
-- Used by: src/repos/exchange-rates.js
-- ============================================================

CREATE TABLE exchange_rates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application   uuid NOT NULL REFERENCES auth_api_keys (id),
  rate          numeric NOT NULL CHECK (rate > 0),
  active        boolean NOT NULL DEFAULT true,
  set_by        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rates_app_active ON exchange_rates (application, active) WHERE active = true;


-- 4. Derived Wallets
-- Used by: src/repos/wallets.js
-- ============================================================

CREATE TABLE derived_wallets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number    text NOT NULL,
  wallet_address  text NOT NULL,
  application     uuid NOT NULL REFERENCES auth_api_keys (id),
  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (phone_number, application)
);
