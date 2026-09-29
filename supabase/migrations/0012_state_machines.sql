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
    (OLD.status = 'received'        AND NEW.status IN ('processing','failed')) OR
    (OLD.status = 'processing'      AND NEW.status IN ('completed','failed')) OR
    (OLD.status = 'failed'          AND NEW.status IN ('processing'))   -- payout retry path
  ) THEN
    RAISE EXCEPTION 'ILLEGAL_WITHDRAWAL_TRANSITION: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_withdrawal_transition BEFORE UPDATE OF status ON withdrawals
  FOR EACH ROW EXECUTE FUNCTION enforce_withdrawal_transition();
