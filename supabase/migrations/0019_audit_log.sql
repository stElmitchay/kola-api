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
