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
