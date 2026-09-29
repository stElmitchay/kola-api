-- ============================================================
-- 0009: Least privilege. The API moves to the service-role key
-- (bypasses RLS). anon/authenticated lose every grant on public.
-- RLS is enabled deny-all (no policies) on every table as the
-- second line of defence if a grant ever reappears.
-- Supabase Auth (auth schema) is unaffected — the dashboard's
-- anon key keeps working for login only.
-- ============================================================

ALTER TABLE auth_api_keys   ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposits        ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawals     ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_rates  ENABLE ROW LEVEL SECURITY;
ALTER TABLE derived_wallets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
