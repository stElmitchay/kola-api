-- ============================================================
-- kola-api: ONE-SHOT PRODUCTION APPLY — migrations 0009..0020
--
-- HOW TO RUN (pick one):
--   A) Supabase Dashboard -> SQL Editor -> paste this ENTIRE file -> Run.
--      The editor executes it as one batch; any error rolls back everything.
--   B) psql "$SUPABASE_DB_URL" --single-transaction -v ON_ERROR_STOP=1 \
--        -f scripts/prod-apply-0009-0020.sql
--
-- Safety model: pre-flight guards abort BEFORE any change if the live
-- schema doesn't match what these migrations assume (the undocumented
-- 0002-0006 drift), and the post-apply verification at the bottom RAISES
-- (rolling back every change) if the end state is not exactly right.
-- Either it all lands, or nothing does.
--
-- AFTER this succeeds: set the Vercel env vars (SUPABASE_SERVICE_ROLE_KEY
-- + the REQUIRED set in .env.example) and deploy the new code. The old
-- POC deployment stops working the moment this applies (anon key is cut
-- off) — that is the point of migration 0009.
-- ============================================================

-- ---------- PRE-FLIGHT GUARDS (abort before touching anything) ----------
DO $$
DECLARE v_count int;
BEGIN
  -- Already applied? (0009 enables RLS on auth_api_keys)
  SELECT count(*) INTO v_count FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='public' AND c.relname='auth_api_keys' AND c.relrowsecurity;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'ABORT: RLS already enabled on auth_api_keys — 0009+ appear to be applied already. Nothing was changed.';
  END IF;

  -- The five POC tables these migrations build on must exist
  SELECT count(*) INTO v_count FROM information_schema.tables
    WHERE table_schema='public'
    AND table_name IN ('auth_api_keys','deposits','withdrawals','exchange_rates','derived_wallets');
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'ABORT: expected the 5 POC tables, found %. Schema drift (ghost migrations 0002-0006) — investigate before applying. Nothing was changed.', v_count;
  END IF;

  -- 0012 drops this constraint by name; verify it exists under the default name
  SELECT count(*) INTO v_count FROM information_schema.table_constraints
    WHERE table_schema='public' AND table_name='deposits' AND constraint_name='deposits_status_check';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'ABORT: deposits_status_check constraint not found under its default name (0002-0006 drift?). Run: SELECT constraint_name FROM information_schema.table_constraints WHERE table_name=''deposits''; then align 0012. Nothing was changed.';
  END IF;

  -- 0011 creates a UNIQUE partial index on active rates; duplicates would break it
  SELECT count(*) INTO v_count FROM (
    SELECT application FROM exchange_rates WHERE active GROUP BY application HAVING count(*) > 1
  ) d;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'ABORT: % application(s) have more than one active exchange rate — deactivate duplicates first (UPDATE exchange_rates SET active=false WHERE id NOT IN (SELECT DISTINCT ON (application) id FROM exchange_rates WHERE active ORDER BY application, created_at DESC) AND active). Nothing was changed.', v_count;
  END IF;

  -- Columns the new code writes must exist on the POC tables
  SELECT count(*) INTO v_count FROM information_schema.columns
    WHERE table_schema='public' AND (
      (table_name='withdrawals' AND column_name IN ('solana_tx_signature','monime_payout_id','expires_at'))
      OR (table_name='deposits' AND column_name IN ('solana_tx_signature','amount_usdc','amount_sle')));
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'ABORT: expected 6 known columns on deposits/withdrawals, found % (0002-0006 drift). Nothing was changed.', v_count;
  END IF;

  RAISE NOTICE 'Pre-flight OK — applying 0009..0020';
END $$;


-- ================= 0009_lockdown_rls.sql =================
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

-- ================= 0010_deposit_guards.sql =================
-- Same guarantee withdrawals already have: one signature, one row, ever.
CREATE UNIQUE INDEX uq_deposits_solana_tx ON deposits (solana_tx_signature)
  WHERE solana_tx_signature IS NOT NULL;

-- ================= 0011_exchange_rate_guards.sql =================
-- Exactly one active rate per application, enforced by the database,
-- switched atomically inside one function/transaction.
CREATE UNIQUE INDEX uq_exchange_rates_one_active
  ON exchange_rates (application) WHERE active;

CREATE OR REPLACE FUNCTION set_exchange_rate(
  p_application uuid, p_rate numeric, p_set_by text
) RETURNS exchange_rates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row exchange_rates;
BEGIN
  IF p_rate <= 0 THEN RAISE EXCEPTION 'RATE_NOT_POSITIVE'; END IF;
  UPDATE exchange_rates SET active = false
    WHERE application = p_application AND active;
  INSERT INTO exchange_rates (application, rate, set_by, active)
    VALUES (p_application, p_rate, p_set_by, true)
    RETURNING * INTO v_row;
  RETURN v_row;
END $$;

REVOKE ALL ON FUNCTION set_exchange_rate(uuid, numeric, text) FROM anon, authenticated, public;

-- ================= 0012_state_machines.sql =================
-- Legal transitions. App code uses CAS; these triggers make illegal
-- writes impossible for every client including manual SQL.

ALTER TABLE deposits DROP CONSTRAINT deposits_status_check;
ALTER TABLE deposits ADD CONSTRAINT deposits_status_check CHECK (status IN
  ('pending','confirmed','processing','completed','failed','expired','amount_mismatch'));

CREATE OR REPLACE FUNCTION enforce_deposit_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'pending'    AND NEW.status IN ('confirmed','processing','expired','failed','amount_mismatch')) OR
    (OLD.status = 'confirmed'  AND NEW.status IN ('processing','failed')) OR
    (OLD.status = 'processing' AND NEW.status IN ('completed','failed'))
  ) THEN
    RAISE EXCEPTION 'ILLEGAL_DEPOSIT_TRANSITION: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_deposit_transition BEFORE UPDATE OF status ON deposits
  FOR EACH ROW EXECUTE FUNCTION enforce_deposit_transition();

CREATE OR REPLACE FUNCTION enforce_withdrawal_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'pending_deposit' AND NEW.status IN ('received','expired')) OR
    (OLD.status = 'received'        AND NEW.status IN ('processing','failed','completed')) OR -- 'completed' direct from 'received': payout.completed webhook may win the race against the received->processing CAS (F8)
    (OLD.status = 'processing'      AND NEW.status IN ('completed','failed')) OR
    (OLD.status = 'failed'          AND NEW.status IN ('processing'))   -- payout retry path
  ) THEN
    RAISE EXCEPTION 'ILLEGAL_WITHDRAWAL_TRANSITION: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_withdrawal_transition BEFORE UPDATE OF status ON withdrawals
  FOR EACH ROW EXECUTE FUNCTION enforce_withdrawal_transition();

-- ================= 0013_webhook_events.sql =================
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

-- ================= 0014_transfer_jobs.sql =================
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

-- ================= 0015_ledger.sql =================
-- Append-only double-entry ledger (F12). Every value movement across the
-- system posts one balanced journal here. Corrected by new journals, never
-- by edits — the immutability triggers below make that structural, not just
-- a convention. C1's reconciliation job reads `treasury_usdc` against the
-- chain; B6 builds the operator ledger views on top of this.

CREATE TABLE ledger_accounts (
  id smallint PRIMARY KEY,
  code text UNIQUE NOT NULL,
  currency text NOT NULL CHECK (currency IN ('USDC','SLE')),
  kind text NOT NULL CHECK (kind IN ('asset','liability','income','suspense','conversion'))
);
INSERT INTO ledger_accounts VALUES
  (1,'treasury_usdc','USDC','asset'),
  (2,'user_payable_usdc','USDC','liability'),
  (3,'monime_sle','SLE','asset'),
  (4,'user_payable_sle','SLE','liability'),
  (5,'fee_income_sle','SLE','income'),
  (6,'fx_usdc','USDC','conversion'),
  (7,'fx_sle','SLE','conversion'),
  (8,'suspense_usdc','USDC','suspense');

CREATE TABLE ledger_journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN (
    'deposit_collection','deposit_payout','withdrawal_receipt',
    'withdrawal_payout','suspense_in','suspense_release','adjustment')),
  resource_type text,
  resource_id uuid,
  idempotency_key text UNIQUE NOT NULL,   -- e.g. 'deposit_payout:<deposit_id>' — re-posting is a no-op
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  journal_id uuid NOT NULL REFERENCES ledger_journals (id),
  account smallint NOT NULL REFERENCES ledger_accounts (id),
  direction text NOT NULL CHECK (direction IN ('debit','credit')),
  amount bigint NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ledger_entries_account ON ledger_entries (account, created_at);

-- Append-only: the ledger is corrected by new journals, never by edits.
CREATE OR REPLACE FUNCTION forbid_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ledger is append-only'; END $$;
CREATE TRIGGER trg_entries_immutable  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_mutation();
CREATE TRIGGER trg_journals_immutable BEFORE UPDATE OR DELETE ON ledger_journals
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_mutation();

-- Every journal balances per currency, checked at COMMIT.
CREATE OR REPLACE FUNCTION assert_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM (
    SELECT a.currency,
           sum(CASE WHEN e.direction='debit'  THEN e.amount ELSE 0 END) AS d,
           sum(CASE WHEN e.direction='credit' THEN e.amount ELSE 0 END) AS c
    FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account
    WHERE e.journal_id = NEW.journal_id
    GROUP BY a.currency) t
  WHERE t.d <> t.c;
  IF bad > 0 THEN RAISE EXCEPTION 'unbalanced journal %', NEW.journal_id; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_journal_balanced
  AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

-- Atomic post: journal + entries in one tx (deferred balance check at commit).
CREATE OR REPLACE FUNCTION post_journal(
  p_kind text, p_resource_type text, p_resource_id uuid,
  p_idempotency_key text, p_entries jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_journal uuid; e jsonb;
BEGIN
  INSERT INTO ledger_journals (kind, resource_type, resource_id, idempotency_key)
    VALUES (p_kind, p_resource_type, p_resource_id, p_idempotency_key)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_journal;
  IF v_journal IS NULL THEN RETURN NULL; END IF;   -- already posted: no-op
  FOR e IN SELECT * FROM jsonb_array_elements(p_entries) LOOP
    INSERT INTO ledger_entries (journal_id, account, direction, amount)
      VALUES (v_journal,
              (SELECT id FROM ledger_accounts WHERE code = e->>'account'),
              e->>'direction', (e->>'amount')::bigint);
  END LOOP;
  RETURN v_journal;
END $$;
REVOKE ALL ON FUNCTION post_journal(text,text,uuid,text,jsonb) FROM anon, authenticated, public;

-- Withdrawals need the gross SLE to split fee income cleanly.
ALTER TABLE withdrawals ADD COLUMN amount_sle_gross bigint;

-- ================= 0016_guarded_withdrawal.sql =================
CREATE OR REPLACE FUNCTION create_withdrawal_guarded(p jsonb, p_daily_cap bigint)
RETURNS withdrawals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_total bigint; v_row withdrawals; v_lock_phone bigint; v_lock_wallet bigint;
BEGIN
  -- Serialise per phone AND per wallet: concurrent creates for one phone, or
  -- for one wallet (even across different phones), queue here (F10). Two
  -- locks are needed because the dup check below is GLOBAL by
  -- (wallet, amount) while the cap check is per-phone — locking only the
  -- phone left a cross-phone/same-wallet race on the dup check. Acquired in
  -- deterministic hash order (smaller first) so no ordering permutation
  -- across concurrent transactions can deadlock; a hash collision just
  -- serializes the two lock acquisitions instead.
  v_lock_phone  := hashtext('wd:'  || (p->>'phone_number'))::bigint;
  v_lock_wallet := hashtext('wdw:' || (p->>'from_wallet_address'))::bigint;
  IF v_lock_phone <= v_lock_wallet THEN
    PERFORM pg_advisory_xact_lock(v_lock_phone);
    PERFORM pg_advisory_xact_lock(v_lock_wallet);
  ELSE
    PERFORM pg_advisory_xact_lock(v_lock_wallet);
    PERFORM pg_advisory_xact_lock(v_lock_phone);
  END IF;

  SELECT COALESCE(sum(amount_usdc), 0) INTO v_total FROM withdrawals
    WHERE phone_number = p->>'phone_number'
      AND application  = (p->>'application')::uuid
      AND created_at  >= now() - interval '24 hours'
      AND status NOT IN ('failed','expired');
  IF v_total + (p->>'amount_usdc')::bigint > p_daily_cap THEN
    RAISE EXCEPTION 'DAILY_CAP_EXCEEDED used=%', v_total;
  END IF;

  -- Global (wallet, amount) uniqueness — load-bearing for Helius matching.
  -- Covered by both locks above: the wallet lock serializes same-wallet
  -- attempts regardless of phone, and the phone lock serializes same-phone
  -- attempts regardless of wallet.
  IF EXISTS (SELECT 1 FROM withdrawals
             WHERE from_wallet_address = p->>'from_wallet_address'
               AND amount_usdc = (p->>'amount_usdc')::bigint
               AND status = 'pending_deposit' AND expires_at > now()) THEN
    RAISE EXCEPTION 'DUPLICATE_OPEN_WITHDRAWAL';
  END IF;

  INSERT INTO withdrawals (application, phone_number, from_wallet_address, provider_code,
    amount_usdc, amount_sle, amount_sle_gross, fee_bps, exchange_rate, expires_at, metadata, status)
  VALUES ((p->>'application')::uuid, p->>'phone_number', p->>'from_wallet_address', p->>'provider_code',
    (p->>'amount_usdc')::bigint, (p->>'amount_sle')::bigint, (p->>'amount_sle_gross')::bigint,
    (p->>'fee_bps')::int, (p->>'exchange_rate')::numeric, (p->>'expires_at')::timestamptz,
    COALESCE(p->'metadata','{}'::jsonb), 'pending_deposit')
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;
REVOKE ALL ON FUNCTION create_withdrawal_guarded(jsonb, bigint) FROM anon, authenticated, public;

-- ================= 0017_unmatched_transfers.sql =================
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

-- ================= 0018_idempotency_keys.sql =================
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

-- ================= 0019_audit_log.sql =================
-- Append-only audit log for operator/admin actions (F12 audit slice).
-- Every admin mutation (API key create/deactivate, exchange rate set, ...)
-- writes one row here via src/repos/audit-log.js's writeAudit(). Corrected
-- by new rows, never by edits — same append-only shape as the ledger (0015).
--
-- Depends on forbid_ledger_mutation(), defined in 0015_ledger.sql — that
-- migration must be applied before this one for the trigger below to
-- resolve.

CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor         text NOT NULL,          -- admin key label (see below) or 'system:<job>'
  action        text NOT NULL,          -- 'api_key.create' | 'api_key.deactivate' | 'rate.set' | ...
  resource_type text,
  resource_id   text,
  before        jsonb,
  after         jsonb,
  ip            text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_mutation();  -- reuse B4's guard

-- ================= 0020_lockdown_new_tables.sql =================
-- ============================================================
-- 0020: Extend 0009's least-privilege posture to every table created
-- since (0013-0019). Same deny-all shape: RLS enabled, no policies —
-- the service-role key the API runs as bypasses RLS entirely, so this
-- is the second line of defence if a grant ever reappears on anon/
-- authenticated, not the primary access control.
-- ============================================================

ALTER TABLE webhook_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfer_jobs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_accounts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_journals     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries      ENABLE ROW LEVEL SECURITY;
ALTER TABLE unmatched_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys    ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log           ENABLE ROW LEVEL SECURITY;

-- Depends on forbid_ledger_mutation(), defined in 0015_ledger.sql — that
-- migration must be applied before this one for the triggers below to
-- resolve. 0015 already guards ledger_entries/ledger_journals against
-- UPDATE/DELETE and 0019 guards audit_log the same way; TRUNCATE bypasses
-- row-level triggers entirely (it's a statement-level operation on the
-- whole relation), so it needs its own BEFORE TRUNCATE trigger reusing the
-- same guard function — a service-role connection can otherwise
-- `TRUNCATE ledger_entries` and erase the append-only history in one
-- statement without ever touching a row-level UPDATE/DELETE trigger.
CREATE TRIGGER trg_entries_no_truncate  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_mutation();
CREATE TRIGGER trg_journals_no_truncate BEFORE TRUNCATE ON ledger_journals
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_mutation();
CREATE TRIGGER trg_audit_no_truncate    BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_mutation();

-- ---------- POST-APPLY VERIFICATION (any failure rolls back EVERYTHING) ----------
DO $$
DECLARE v_count int;
BEGIN
  -- All 13 tables must have RLS enabled (5 POC + 8 new)
  SELECT count(*) INTO v_count FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity
    AND c.relname IN ('auth_api_keys','deposits','withdrawals','exchange_rates','derived_wallets',
                      'webhook_events','transfer_jobs','ledger_accounts','ledger_journals',
                      'ledger_entries','unmatched_transfers','idempotency_keys','audit_log');
  IF v_count <> 13 THEN RAISE EXCEPTION 'VERIFY FAILED (rolling back): % of 13 tables have RLS', v_count; END IF;

  -- The four functions must exist
  SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('set_exchange_rate','create_withdrawal_guarded','post_journal','forbid_ledger_mutation');
  IF v_count < 4 THEN RAISE EXCEPTION 'VERIFY FAILED (rolling back): % of 4 functions present', v_count; END IF;

  -- Ledger accounts seeded
  SELECT count(*) INTO v_count FROM ledger_accounts;
  IF v_count <> 8 THEN RAISE EXCEPTION 'VERIFY FAILED (rolling back): % of 8 ledger accounts seeded', v_count; END IF;

  -- State-machine + immutability + truncate triggers
  SELECT count(*) INTO v_count FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE NOT t.tgisinternal AND c.relname IN ('deposits','withdrawals','ledger_entries','ledger_journals','audit_log');
  IF v_count < 8 THEN RAISE EXCEPTION 'VERIFY FAILED (rolling back): only % triggers found on guarded tables', v_count; END IF;

  -- Unique guards
  SELECT count(*) INTO v_count FROM pg_indexes WHERE schemaname='public'
    AND indexname IN ('uq_deposits_solana_tx','uq_exchange_rates_one_active');
  IF v_count <> 2 THEN RAISE EXCEPTION 'VERIFY FAILED (rolling back): unique guard indexes missing (%/2)', v_count; END IF;

  RAISE NOTICE '=== ALL VERIFIED — 0009..0020 applied atomically. Next: Vercel env vars, deploy, smoke test. ===';
END $$;
