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
