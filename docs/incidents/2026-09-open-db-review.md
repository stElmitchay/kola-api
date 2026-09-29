# Incident review: open production database (finding F1)

## Summary

The production Supabase project was reachable with the public `anon` key,
had Row Level Security disabled on `deposits`, `exchange_rates`,
`derived_wallets`, and `auth_api_keys` (and, per migration
`0008_disable_rls_withdrawals.sql`, `withdrawals` too), and the `anon` /
`authenticated` roles held default grants on the `public` schema. This
means any holder of the anon key — which is not a secret by Supabase
convention and may have been present in client bundles, logs, or the repo
history — could read and write every table directly via PostgREST,
bypassing the API entirely.

Migration `0009_lockdown_rls.sql` closes this: RLS is enabled deny-all
(no policies) on every table, and all grants on `public` are revoked from
`anon` and `authenticated`. The API itself moves to the service-role key
(`src/utils/supabase.js`), which bypasses RLS by design and is the only
credential going forward. See `docs/FOUNDER_CHECKLIST.md` for the exact
apply/verify steps, which could not be run in this environment (no
Supabase CLI, no live project access, no Vercel credentials).

This document records the exposure-review queries below to run against
the live database once access is available, and the credential rotation
that must accompany closing this finding.

## Exposure review

Run each query in the Supabase SQL editor (or via `psql`) with the
service-role connection. Record the actual output under each `RESULT`
line — replace `(pending)` — and flag anything unrecognised.

### 1. Unknown API keys — every row must be one you created

```sql
SELECT id, client_id, name, business_name, created_at, last_used_at
FROM auth_api_keys
ORDER BY created_at;
```

RESULT: (pending)

### 2. Rate history sane — no rows you didn't set

```sql
SELECT rate, set_by, active, created_at
FROM exchange_rates
ORDER BY created_at;
```

RESULT: (pending)

### 3. Withdrawal/deposit rows with impossible transitions

```sql
SELECT id, status, amount_usdc, solana_tx_signature, created_at
FROM withdrawals
ORDER BY created_at;
```

RESULT: (pending)

```sql
SELECT id, status, amount_usdc, solana_tx_signature, created_at
FROM deposits
ORDER BY created_at;
```

RESULT: (pending)

### 4. Cross-check every treasury outflow on-chain

Cross-check the treasury ATA's transfer history on Solscan against the
union of the `withdrawals` and `deposits` rows above. Any on-chain
outflow with no matching row is an incident.

RESULT: (pending)

## Credential rotation

Rotate every credential that could have been exposed alongside the open
database. Record what was rotated and when as each item is completed.

| secret | rotated on | by |
|---|---|---|
| Supabase JWT secret (dashboard → Settings → API → rotate; invalidates old anon + service keys) | (pending) | (pending) |
| `ADMIN_SECRET_KEY` | (pending) | (pending) |
| Monime access token (request new token via Monime) | (pending) | (pending) |

## Git history

Git history was checked and verified clean — no Supabase keys, service-role
keys, or other secrets were ever committed to this repository (finding
C1). **No history rewrite is needed.**
