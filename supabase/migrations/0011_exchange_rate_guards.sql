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
