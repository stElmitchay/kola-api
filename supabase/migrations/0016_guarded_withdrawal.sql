CREATE OR REPLACE FUNCTION create_withdrawal_guarded(p jsonb, p_daily_cap bigint)
RETURNS withdrawals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_total bigint; v_row withdrawals;
BEGIN
  -- Serialise per phone: concurrent creates for one phone queue here (F10).
  PERFORM pg_advisory_xact_lock(hashtext('wd:' || (p->>'phone_number')));

  SELECT COALESCE(sum(amount_usdc), 0) INTO v_total FROM withdrawals
    WHERE phone_number = p->>'phone_number'
      AND application  = (p->>'application')::uuid
      AND created_at  >= now() - interval '24 hours'
      AND status NOT IN ('failed','expired');
  IF v_total + (p->>'amount_usdc')::bigint > p_daily_cap THEN
    RAISE EXCEPTION 'DAILY_CAP_EXCEEDED used=%', v_total;
  END IF;

  -- Global (wallet, amount) uniqueness — load-bearing for Helius matching.
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
