-- ============================================================
-- Disable RLS on the withdrawals table to match the rest of the
-- schema (deposits, exchange_rates, derived_wallets, auth_api_keys
-- are all accessed via the service-role-like key from server-side
-- code, with application-scoped queries enforced in the repo layer).
-- ============================================================

ALTER TABLE withdrawals DISABLE ROW LEVEL SECURITY;
