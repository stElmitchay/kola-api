# Game day: DB restore (PITR)

**TEMPLATE — run and rename with the date**
(`docs/game-days/<YYYY-MM-DD>-db-restore-pitr.md`)

## What this proves

Point-in-Time Recovery (PITR) is Supabase's mechanism for restoring the
database to an earlier timestamp — the last resort if a bad migration, a
bad manual `UPDATE`, or a compromised credential corrupts data faster than
application-level guards can catch it. This drill proves PITR is actually
provisioned and working, measures the real RTO (time from "we need to
restore" to "the database is queryable and verified again"), and confirms
the post-restore data passes the same invariant checks the app relies on
(ledger balance, journal balance, migration chain state).

**PITR requires the Supabase Pro plan** (or higher) with the PITR add-on
enabled — confirm this is provisioned before scheduling the drill (Supabase
dashboard → Project Settings → Add-ons → Point in Time Recovery). If it
isn't provisioned yet, provisioning it IS the first action item, not
something this drill can work around.

## Preconditions

- **Run this against a disposable scratch Supabase project that mirrors
  production's migration chain (all of `001` + `0007`–`0019` applied in the
  order documented in `docs/testing.md`), never against the production
  project**, unless this drill is being run in a live incident. Supabase's
  PITR restore is an **in-place** operation on the project it's enabled on
  (it takes that project offline for the duration of the restore) — as of
  this writing there is no dashboard action that restores PITR history into
  a brand-new separate project. If the Supabase dashboard offers a
  "restore to new project" option at drill time, note that in the Results
  section below (product capabilities change).
- The scratch project should have a realistic volume of seeded data before
  the drill starts — an empty database makes the timing numbers useless.
  Reuse the integration suite's seed helpers (`__tests__/integration/
  helpers.js`'s `seedApplication`) or run a handful of real deposit/
  withdrawal cycles against it first (devnet Solana + a Monime sandbox, or
  the integration suite's mocks driven manually).
- Someone with dashboard/owner access to the scratch project's Supabase
  organization (PITR restores are initiated from the dashboard, not the
  CLI, as of this writing).

## Step 1 — capture a "known good" baseline (T0)

Before doing anything destructive, record the current state so you have
something to diff the restored data against.

```bash
date -u +%Y-%m-%dT%H:%M:%SZ   # record as T0
```

```bash
curl -s -X POST "$SCRATCH_API_BASE_URL/api/internal/reconcile-tick" \
  -H "X-Cron-Secret: $CRON_SECRET" | jq .
# Record the full output — especially proveBalance.result (onchain/ledger
# balances) — this is the exact invariant the restored data must still
# satisfy.
```

```sql
-- Row counts, for a coarse before/after diff.
select 'deposits' as t, count(*) from deposits
union all select 'withdrawals', count(*) from withdrawals
union all select 'ledger_journals', count(*) from ledger_journals
union all select 'ledger_entries', count(*) from ledger_entries
union all select 'transfer_jobs', count(*) from transfer_jobs
union all select 'webhook_events', count(*) from webhook_events
union all select 'audit_log', count(*) from audit_log;
```

```sql
-- Ledger balance invariant (same query as Task B4's verification —
-- must return zero rows before AND after restore).
select j.id, j.kind, a.currency,
       sum(case when e.direction = 'debit'  then e.amount else 0 end) as debits,
       sum(case when e.direction = 'credit' then e.amount else 0 end) as credits
  from ledger_journals j
  join ledger_entries e on e.journal_id = j.id
  join ledger_accounts a on a.id = e.account
 group by j.id, j.kind, a.currency
having sum(case when e.direction = 'debit'  then e.amount else 0 end)
    <> sum(case when e.direction = 'credit' then e.amount else 0 end);
-- Expected before AND after: 0 rows.
```

## Step 2 — mark the restore target and create a distinguishable "after T0" change

To make the restore's effect unambiguous, do something after T0 that should
NOT exist once you restore to T0:

```sql
insert into audit_log (actor, action, resource_type, resource_id, before, after)
values ('drill', 'db_restore_drill.marker', 'drill', gen_random_uuid(),
        '{}'::jsonb, '{"note": "should NOT survive a restore to before this point"}'::jsonb);
```

Note the exact timestamp this insert landed (`select now()`) — call it T1.
Confirm it's there:

```sql
select id, created_at from audit_log where action = 'db_restore_drill.marker' order by created_at desc limit 1;
```

## Step 3 — initiate the restore

```bash
# Start the clock.
date -u +%Y-%m-%dT%H:%M:%SZ   # record as RESTORE_START
```

In the Supabase dashboard, for the scratch project: Project Settings →
Database → Backups → Point in Time Recovery → restore to a timestamp
**between T0 and T1** (before the marker row was inserted). Confirm the
restore and follow the dashboard's progress indicator.

## Step 4 — measure RTO

```bash
# Poll until the project answers again (Supabase takes the project offline
# during the restore).
until curl -s -o /dev/null -w '%{http_code}' "$SCRATCH_SUPABASE_URL/rest/v1/" \
    -H "apikey: $SCRATCH_SERVICE_ROLE_KEY" | grep -qE '^(200|401|404)$'; do
  sleep 10
done
date -u +%Y-%m-%dT%H:%M:%SZ   # record as RESTORE_DB_UP
```

`RESTORE_DB_UP - RESTORE_START` is the raw database-layer RTO. Then confirm
the API layer is healthy against the restored database (redeploy or point a
local `vercel dev` at the restored project's credentials if they changed):

```bash
curl -s "$SCRATCH_API_BASE_URL/api/v1/public/health"
date -u +%Y-%m-%dT%H:%M:%SZ   # record as RESTORE_API_UP
```

`RESTORE_API_UP - RESTORE_START` is the full operational RTO — the number
that actually matters for an incident.

## Step 5 — verify the restore landed at the right point and data is intact

```sql
-- The marker from Step 2 must be GONE (proves the restore point was before T1).
select count(*) from audit_log where action = 'db_restore_drill.marker';
-- Expected: 0
```

Re-run the Step 1 row-count query and the ledger balance-invariant query.
Expected: row counts match what they were at T0 (not T1), and the balance
invariant still returns zero rows (PITR restores a transactionally
consistent snapshot — it cannot produce a half-written journal).

```sql
-- Confirm the migration chain's schema objects survived the restore
-- (PITR restores the whole database, including schema — this should
-- always pass, but confirm rather than assume):
select table_name from information_schema.tables
 where table_name in ('ledger_accounts','ledger_journals','ledger_entries',
                       'webhook_events','transfer_jobs','unmatched_transfers',
                       'idempotency_keys','audit_log');
-- Expected: 8 rows.

select proname from pg_proc
 where proname in ('create_withdrawal_guarded','post_journal','set_exchange_rate');
-- Expected: 3 rows.
```

Re-run `reconcile-tick` once more and confirm `proveBalance.result.mismatch`
is `false` against the restored data — this is the strongest end-to-end
signal that the restore is sound from the application's point of view:

```bash
curl -s -X POST "$SCRATCH_API_BASE_URL/api/internal/reconcile-tick" \
  -H "X-Cron-Secret: $CRON_SECRET" | jq .proveBalance
```

## Rollback

- This drill's "damage" (the marker row) is undone BY the restore itself —
  there is nothing further to roll back on the data side.
- If the restore was run against anything other than the disposable scratch
  project, stop and escalate immediately — do not attempt a second restore
  to "fix" a restore run against the wrong target without confirming the
  blast radius first.
- Rotate the scratch project's service-role key if it was shared with
  anyone outside the drill for troubleshooting.

## Results (fill in after running)

| Field | Value |
|---|---|
| Date run | |
| Supabase plan / PITR retention window confirmed | |
| T0 (baseline timestamp) | |
| T1 (marker insert timestamp) | |
| Restore target timestamp requested | |
| RESTORE_START | |
| RESTORE_DB_UP (raw DB RTO) | |
| RESTORE_API_UP (full operational RTO) | |
| Marker row absent post-restore? (Y/N) | |
| Row counts matched T0? (Y/N, list any diffs) | |
| Ledger balance invariant clean post-restore? (Y/N) | |
| `proveBalance.result.mismatch` post-restore | |
| "Restore to new project" available in dashboard at drill time? (Y/N) | |
| Surprises / deviations from expected | |
