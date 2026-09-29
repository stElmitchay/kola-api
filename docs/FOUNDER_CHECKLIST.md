# Founder checklist — live infrastructure steps

This checklist covers the steps in the production-hardening plan that
require access to live infrastructure (the Supabase CLI, a linked
Supabase project, `psql`/`SUPABASE_DB_URL`, or Vercel credentials) that
were not available in the sandboxed environment this work was done in.
Everything else in the referenced tasks (code, migrations, tests, docs)
has already been written and committed — these are the remaining manual
steps to actually apply and verify them against production.

## Task A1 — apply & verify

1. **Apply the lockdown migration** (after unpausing the project if it's
   paused):

   ```bash
   supabase db push
   # or, applied directly against the prod connection string:
   psql "$SUPABASE_DB_URL" -f supabase/migrations/0009_lockdown_rls.sql
   ```

2. **Prove the anon key is now useless:**

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" \
     "$SUPABASE_URL/rest/v1/auth_api_keys?select=id&limit=1" \
     -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY"
   ```

   Expected: `401`, `403`, or an empty/permission-denied body — anything
   but `200` with rows.

3. **Set the service-role key in Vercel** (production + preview
   environments) and in local `.env`:

   ```bash
   vercel env add SUPABASE_SERVICE_ROLE_KEY production
   vercel env add SUPABASE_SERVICE_ROLE_KEY preview
   ```

   Then remove `SUPABASE_ANON_KEY` from both environments and from local
   `.env` — it must not remain configured anywhere this API runs.

4. **Confirm one authenticated API call still works end-to-end**, e.g.:

   ```bash
   curl -s "$API_BASE_URL/api/v1/deposits" -H "X-API-Key: <a valid key>"
   ```

5. **Run the exposure review.** Execute the four SQL queries in
   `docs/incidents/2026-09-open-db-review.md` against the live database
   (Supabase SQL editor, with the service role) and record each
   `RESULT:` line in that file.

6. **Rotate credentials** and record what was rotated and when in the
   rotation table in `docs/incidents/2026-09-open-db-review.md`:
   - Supabase JWT secret (dashboard → Settings → API → rotate; this
     invalidates the old anon + service-role keys — update Vercel and
     any other consumer immediately after)
   - `ADMIN_SECRET_KEY`
   - Monime access token (request a new one via Monime)

   Git history was verified clean (finding C1) — no history rewrite is
   needed.

## Task A2 — schema baseline dump

1. **Dump the real production schema:**

   ```bash
   supabase db dump --db-url "$SUPABASE_DB_URL" --schema public -f supabase/schema_baseline_2026-09.sql
   ```

2. **Diff it against what the migrations produce**, to confirm the
   migration chain can rebuild the database from scratch:

   ```bash
   # Spin up a scratch local db, apply 001 + 0007 + 0008 + 0009, dump, diff:
   supabase start && supabase db reset
   supabase db dump --local --schema public -f /tmp/from-migrations.sql
   diff /tmp/from-migrations.sql supabase/schema_baseline_2026-09.sql || true
   ```

   Expected: differences corresponding to the ghost migrations 0002–0006
   (see `supabase/migrations/README.md`). Record every difference
   (columns, indexes, constraints) under "Applied out-of-band before
   0009" in that README. If a difference is load-bearing (e.g. an index
   the code assumes exists), create it explicitly in a new migration so
   the chain becomes self-sufficient going forward.

3. **Commit the baseline dump:**

   ```bash
   git add supabase/schema_baseline_2026-09.sql supabase/migrations/README.md
   git commit -m "chore: capture production schema baseline, document migration gap 0002-0006"
   ```

## Task A3 — apply migration 0010

1. **Apply the deposit guards migration:**

   ```bash
   supabase db push
   # or, applied directly against the prod connection string:
   psql "$SUPABASE_DB_URL" -f supabase/migrations/0010_deposit_guards.sql
   ```

2. **Confirm the unique index exists and rejects a duplicate signature:**

   ```sql
   select indexname from pg_indexes
     where tablename = 'deposits' and indexname = 'uq_deposits_solana_tx';
   ```

   Expected: one row. A second `UPDATE ... SET solana_tx_signature = '<same value>'`
   on a different deposit row should then fail with a unique-violation.

## Task A6 — apply migration 0011

1. **Apply the exchange-rate guards migration** (partial unique index +
   `set_exchange_rate` function, atomic active-rate switch — F6):

   ```bash
   supabase db push
   # or, applied directly against the prod connection string:
   psql "$SUPABASE_DB_URL" -f supabase/migrations/0011_exchange_rate_guards.sql
   ```

2. **Confirm the unique index exists:**

   ```sql
   select indexname from pg_indexes
     where tablename = 'exchange_rates' and indexname = 'uq_exchange_rates_one_active';
   ```

   Expected: one row. If any application currently has more than one
   `active = true` row (shouldn't happen, but the old code path wasn't
   atomic), the `CREATE UNIQUE INDEX` will fail — deactivate the extra
   rows first, then re-run.

3. **Confirm the grants landed** (only the service role should be able to
   call the function; anon/authenticated must not):

   ```sql
   select has_function_privilege('anon', 'set_exchange_rate(uuid, numeric, text)', 'execute');
   -- Expected: false
   ```

4. **Set the new env vars** (`RATE_MAX_AGE_MINUTES`, `RATE_MAX_MOVE_BPS` —
   see `.env.example`) in Vercel for every environment before this
   deploys; the code falls back to 1440 / 500 if unset, but an explicit
   value avoids surprise operator friction on the first rate change
   after go-live.

## Task B1 — apply migration 0012 + run transition verification

1. **Apply the state-machine migration** (after unpausing the project if it's
   paused):

   ```bash
   supabase db push
   # or, applied directly against the prod connection string:
   psql "$SUPABASE_DB_URL" -f supabase/migrations/0012_state_machines.sql
   ```

2. **Verify the state-machine constraints** by running the three SQL
   statements in `__tests__/db/state-machine.sql.test.md` against a
   scratch Postgres instance (or local via `supabase db reset`). Record
   the output in that file's TODO block:
   - First two UPDATEs must fail with `ILLEGAL_DEPOSIT_TRANSITION` and
     `ILLEGAL_WITHDRAWAL_TRANSITION` errors.
   - Third UPDATE must succeed (legal `pending → processing` transition).

## Task B2 — capture Monime fixtures + verify field paths + apply migration 0013

1. **Capture the fixtures.** Live capture wasn't possible in the
   sandboxed environment this work was done in. Follow
   `docs/fixtures/monime/README.md`: point a devnet/test Monime webhook
   at a capture endpoint (or pull from the dashboard event log) and save
   one verbatim JSON body each for `checkout_session.completed`,
   `payment_code.completed`, `payment_code.processed` (if it exists),
   `payout.completed`, and `payout.failed` into `docs/fixtures/monime/`.

2. **Verify the two field-path assumptions the code currently makes**
   (both marked `// ASSUMPTION(V-A)` in
   `src/routes/webhooks/monime.js` — grep for `ASSUMPTION(V-A)`):
   - Event id is read from `payload.event.id`.
   - Collected amount is read from `payload.data.amount.value`, treated
     as SLE minor units.

   **The fixture wins.** If a captured payload contradicts either path
   or the units, fix the code at that `ASSUMPTION(V-A)` line to match
   the fixture — do not adjust the fixture to match the code. Also
   confirm whether `payment_code.processed` and `payment_code.completed`
   both fire for a single payment; see the "Standing decision" section
   in `docs/fixtures/monime/README.md` for why `processed` was kept in
   `successEvents` without this confirmation, and revisit it once
   confirmed.

3. **Apply the webhook-events migration:**

   ```bash
   supabase db push
   # or, applied directly against the prod connection string:
   psql "$SUPABASE_DB_URL" -f supabase/migrations/0013_webhook_events.sql
   ```

4. **Confirm the table and unique constraint exist:**

   ```sql
   select indexname from pg_indexes
     where tablename = 'webhook_events';
   ```

   Expected: the primary key index plus a unique index covering
   `(provider, event_id)`.

5. **Prove the exactly-once gate works end-to-end** by replaying the
   same signed webhook body (same `Monime-Signature` header and body) at
   the live endpoint twice. Expected: both requests return `200`; the
   second response body is `{"received": true, "duplicate": true}`; only
   one row for that event appears in `webhook_events`; and no duplicate
   USDC transfer occurs.

## Task B3 — apply 0014 + devnet kill-mid-send drill

1. **Apply the transfer-jobs migration:**

   ```bash
   supabase db push
   # or, applied directly against the prod connection string:
   psql "$SUPABASE_DB_URL" -f supabase/migrations/0014_transfer_jobs.sql
   ```

2. **Confirm the table and open-jobs index exist:**

   ```sql
   select indexname from pg_indexes
     where tablename = 'transfer_jobs' and indexname = 'idx_transfer_jobs_open';
   ```

   Expected: one row (plus the primary key index and the `deposit_id`
   unique constraint index).

3. **Set `CRON_SECRET`** in Vercel (production + preview) and confirm the
   `crons` entry in `vercel.json` (`POST /api/internal/transfer-tick`,
   `* * * * *`) is deployed. Vercel signs its own cron requests with
   `Authorization: Bearer $CRON_SECRET`; `X-Cron-Secret` also works for a
   manual trigger, e.g.:

   ```bash
   curl -s -X POST "$API_BASE_URL/api/internal/transfer-tick" \
     -H "X-Cron-Secret: $CRON_SECRET"
   ```

4. **Run the devnet kill-mid-send drill** — this is the proof that F9
   (ambiguous RPC timeouts must never double-pay) actually holds against
   a real cluster, not just mocks. Use devnet config (`USDC_MINT` +
   `HELIUS_URL` devnet values, a funded devnet treasury) for all of this.

   a. **Enqueue a job manually** against a real (devnet) deposit row that
      is `confirmed`, e.g. via `psql`/SQL editor:

      ```sql
      insert into transfer_jobs (deposit_id, destination, amount_usdc)
      values ('<a confirmed devnet deposit id>', '<a devnet wallet address>', 1000000);
      ```

   b. **Interrupt the process after `recordSignature` but before
      confirmation lands.** The simplest way: temporarily set
      `MAX_ATTEMPTS=1`-equivalent by killing the local `vercel dev` /
      the deployed function process (e.g. `Ctrl-C` the dev server, or
      redeploy mid-request) right after the worker log line showing the
      signature was persisted (`recordSignature` succeeded) and before
      `sendSerializedTransaction` / `finish` complete. Confirm via SQL
      that the job is now `status = 'sending'` with a non-null
      `signature`, `blockhash`, and `last_valid_block_height`:

      ```sql
      select id, status, signature, blockhash, last_valid_block_height
        from transfer_jobs where deposit_id = '<the deposit id>';
      ```

   c. **Re-run the tick** (either wait for the next cron minute, or
      trigger it manually with the curl command above).

   d. **Verify exactly one transfer landed:**
      - The job's `status` is `sent` and `signature` is unchanged from
        step (b) — proving the worker completed the *original* signed
        transaction rather than building a new one.
      - The linked deposit is `completed` with `solana_tx_signature`
        matching that same signature.
      - On the devnet explorer (`https://explorer.solana.com/?cluster=devnet`),
        search the signature: exactly one transaction exists, and the
        destination wallet's USDC balance increased by exactly the
        enqueued `amount_usdc` — not double.
      - `buildSignedUsdcTransfer` was NOT called a second time (no second
        signature ever appears on the job row).

   e. **Concurrent-tick step (B3 review, Critical finding 1).** Enqueue a
      second fresh job the same way as step (a). With the job sitting
      `queued`, fire two tick requests at the same instant (e.g. two
      parallel `curl` processes, or `xargs -P2`):

      ```bash
      for i in 1 2; do
        curl -s -X POST "$API_BASE_URL/api/internal/transfer-tick" \
          -H "X-Cron-Secret: $CRON_SECRET" &
      done
      wait
      ```

      Verify: exactly one `signature` was ever persisted on the job row
      (check `transfer_jobs.signature` — it should never have changed
      value mid-drill, i.e. no second UPDATE ever matched), the job ends
      `sent`, the deposit ends `completed`, and the devnet explorer shows
      exactly one transaction moving USDC to the destination wallet — not
      two. This exercises `recordSignature`'s fence on observed
      `(status, signature)`, which is what prevents two overlapping ticks
      (the 1-minute cron overlapping the webhook's `waitUntil` kick, or
      two cron invocations overlapping each other under load) from both
      broadcasting a valid signed transaction for the same job.

## Task B4 — apply 0015 + ledger verification queries

1. **Apply the ledger migration:**

   ```bash
   supabase db push
   # or, applied directly against the prod connection string:
   psql "$SUPABASE_DB_URL" -f supabase/migrations/0015_ledger.sql
   ```

2. **Confirm the tables, triggers, and function landed, and that the
   posting RPC is locked down to the service role:**

   ```sql
   select table_name from information_schema.tables
     where table_name in ('ledger_accounts', 'ledger_journals', 'ledger_entries');
   -- Expected: 3 rows

   select trigger_name from information_schema.triggers
     where event_object_table in ('ledger_entries', 'ledger_journals');
   -- Expected: 5 rows. information_schema.triggers emits one row per
   -- (trigger, event) pair, and the two immutability triggers each fire on
   -- two events (BEFORE UPDATE OR DELETE) -> trg_entries_immutable x2 +
   -- trg_journals_immutable x2 + trg_journal_balanced (single AFTER INSERT
   -- event) x1 = 5 rows total, naming only those 3 distinct trigger names.

   select has_function_privilege('anon', 'post_journal(text,text,uuid,text,jsonb)', 'execute');
   -- Expected: false
   ```

3. **Run one full deposit and one full withdrawal** end-to-end on devnet
   (`USDC_MINT` + `HELIUS_URL` devnet values), then run the proof queries
   below (Supabase SQL editor, service role).

   **Every journal balances per currency** (must return zero rows — the
   deferred constraint trigger should already make this impossible, but
   confirm no journal slipped through with mismatched debits/credits):

   ```sql
   select j.id, j.kind, a.currency,
          sum(case when e.direction = 'debit'  then e.amount else 0 end) as debits,
          sum(case when e.direction = 'credit' then e.amount else 0 end) as credits
     from ledger_journals j
     join ledger_entries e on e.journal_id = j.id
     join ledger_accounts a on a.id = e.account
    group by j.id, j.kind, a.currency
   having sum(case when e.direction = 'debit'  then e.amount else 0 end)
       <> sum(case when e.direction = 'credit' then e.amount else 0 end);
   ```

   **`treasury_usdc` ledger balance vs. on-chain delta.** Compute the
   ledger-side net movement of the `treasury_usdc` account since the drill
   started (a `deposit_payout` CREDITS treasury when a USDC payout leaves
   it to a user's wallet; a `withdrawal_receipt` DEBITS treasury when
   incoming USDC from a user is verified and lands in it):

   ```sql
   select
     sum(case when e.direction = 'debit' then e.amount else -e.amount end)
       as treasury_usdc_ledger_net_minor
     from ledger_entries e
     join ledger_accounts a on a.id = e.account
    where a.code = 'treasury_usdc'
      and e.created_at >= '<drill start timestamp>';
   ```

   Compare `treasury_usdc_ledger_net_minor` against the treasury wallet's
   actual USDC balance delta over the same window (devnet explorer, or
   `getTreasuryUsdcBalanceMinor` sampled before/after the drill). Expected:
   they match exactly — the deposit payout's debit and the withdrawal
   receipt's credit should account for every USDC minor unit that moved
   on-chain.

4. **Spot-check the `withdrawal_receipt` gross-fallback path is not
   silently firing in production.** Any withdrawal created before this
   migration landed lacks `amount_sle_gross`, and its receipt journal posts
   the USDC leg only (by design — see the ruling in `src/repos/ledger.js`).
   Confirm none of the withdrawals settled during the drill hit this path:

   ```sql
   select id from withdrawals where amount_sle_gross is null and status <> 'pending_deposit';
   ```

   Expected: no rows for withdrawals created after 0015 was applied. Any
   pre-existing rows found here are expected and already logged via
   `console.error` at posting time — no action required unless an operator
   wants to manually backfill their SLE-side ledger entries.
