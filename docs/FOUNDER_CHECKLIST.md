## Breaking changes pending client updates

- **`walletAddress` is now required on `POST /v1/deposits`** (task B8, F4).
  Previously, an omitted `walletAddress` silently fell back to a
  phone-derived address with no private key — any USDC sent there was
  permanently unspendable. kola-app must collect a wallet address before
  calling this endpoint; its deposit flow already has the input field used
  for the `provided` path, so this should be a matter of always sending it
  rather than building new UI. Coordinate the client-side rollout with
  kola-app before this deploys to production, since a client still omitting
  `walletAddress` will now get a `400` instead of a derived wallet.
- **`POST /v1/wallets/derive` now returns `410 Gone`** with
  `{ "error": { "code": "Gone", "message": "Derived wallets are discontinued. Supply walletAddress on deposit.", "request_id": "..." } }`
  (task C4 moved every error response — this one included — onto the
  unified `{ error: { code, message, request_id } }` envelope). Any client
  still calling this endpoint must be updated to stop calling it.
  `GET /v1/wallets/:address/balance` is unaffected and still works.

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

## Task B5 — apply 0016 + concurrency proof

1. **Apply the guarded-withdrawal migration:**

   ```bash
   supabase db push
   # or, applied directly against the prod connection string:
   psql "$SUPABASE_DB_URL" -f supabase/migrations/0016_guarded_withdrawal.sql
   ```

2. **Confirm the function landed and is locked down to the service role:**

   ```sql
   select proname from pg_proc where proname = 'create_withdrawal_guarded';
   -- Expected: 1 row

   select has_function_privilege('anon', 'create_withdrawal_guarded(jsonb,bigint)', 'execute');
   select has_function_privilege('authenticated', 'create_withdrawal_guarded(jsonb,bigint)', 'execute');
   -- Expected: both false
   ```

   Note: 0016 takes two `pg_advisory_xact_lock`s per call — one keyed on
   phone, one keyed on `from_wallet_address` — acquired in deterministic
   hash order so concurrent transactions can never deadlock against each
   other; this closes a cross-phone/same-wallet race on the duplicate-open
   check that a phone-only lock would have missed.

3. **Concurrency proof — two scenarios, run against a real (devnet-pointed)
   Supabase project with the service-role key.** There is no local Postgres
   in this environment, so both have to be run by hand. They talk to the
   database directly via the RPC — no live Solana or Monime calls happen, so
   they're safe to run repeatedly.

   **Scenario A — same phone, cap enforcement:** 10 parallel creates at
   cap−1 remaining, exactly one succeeds.

   **Scenario B — same wallet + amount, different phones, dup-check
   enforcement:** 10 parallel creates for the same `from_wallet_address` and
   `amount_usdc` but 10 distinct phone numbers → exactly one succeeds, the
   other nine fail with `DUPLICATE_OPEN_WITHDRAWAL`. This is the scenario the
   dual-lock fix (above) closes — under the old phone-only lock, all 10 could
   race past the dup check and insert, since none of them held the same
   phone lock.

   Save as `scripts/b5-concurrency-proof.mjs`:

   ```js
   // One-off founder verification for F10 (TOCTOU). Not part of the app —
   // delete after running, or leave under scripts/ since it's inert without
   // being invoked directly.
   import { createClient } from '@supabase/supabase-js';

   const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
     auth: { persistSession: false, autoRefreshToken: false }
   });

   const APPLICATION = process.env.B5_PROOF_APPLICATION; // an existing application uuid, test app preferred
   const PHONE = '+23276000999'; // throwaway phone, not used elsewhere
   const WALLET_PREFIX = 'B5PROOF';
   const DAILY_CAP = 500_000_000; // must match WITHDRAWAL_DAILY_CAP_USDC (or the deployed default)
   const ATTEMPT_AMOUNT = 50_000_000; // 50 USDC per attempt
   const SEED_USED = DAILY_CAP - ATTEMPT_AMOUNT; // leaves room for exactly ONE attempt to fit

   function baseWithdrawal({ i, phone, wallet, amount = ATTEMPT_AMOUNT }) {
     const now = new Date();
     return {
       application: APPLICATION,
       phone_number: phone,
       from_wallet_address: wallet,
       provider_code: 'm17',
       amount_usdc: amount,
       amount_sle: 1,
       amount_sle_gross: 1,
       fee_bps: 100,
       exchange_rate: '25',
       expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
       metadata: { b5_concurrency_proof: true, i }
     };
   }

   async function scenarioA_sameCap() {
     // Same phone, cap enforcement: 10 parallel creates at cap-1 remaining
     // -> exactly one succeeds, nine hit DAILY_CAP_EXCEEDED.
     await supabase.from('withdrawals').delete().eq('phone_number', PHONE);

     const { error: seedErr } = await supabase.from('withdrawals').insert({
       application: APPLICATION,
       phone_number: PHONE,
       from_wallet_address: `${WALLET_PREFIX}SEED`.padEnd(44, '0'),
       provider_code: 'm17',
       amount_usdc: SEED_USED,
       amount_sle: 1,
       amount_sle_gross: 1,
       fee_bps: 100,
       exchange_rate: '25',
       status: 'received', // counts toward the cap (NOT IN ('failed','expired'))
       expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
     });
     if (seedErr) throw seedErr;

     const results = await Promise.allSettled(
       Array.from({ length: 10 }, (_, i) =>
         supabase.rpc('create_withdrawal_guarded', {
           p: baseWithdrawal({ i, phone: PHONE, wallet: `${WALLET_PREFIX}${String(i).padStart(37, '0')}` }),
           p_daily_cap: DAILY_CAP
         })
       )
     );

     const outcomes = results.map((r, i) => {
       if (r.status === 'rejected') return { i, ok: false, reason: String(r.reason) };
       const { data, error } = r.value;
       return { i, ok: !error && !!data, reason: error?.message ?? null };
     });
     const successes = outcomes.filter(o => o.ok);
     const capFailures = outcomes.filter(o => !o.ok && /DAILY_CAP_EXCEEDED/.test(o.reason || ''));

     console.log('--- Scenario A: same phone, cap enforcement ---');
     console.log(JSON.stringify(outcomes, null, 2));
     console.log(`successes=${successes.length} capFailures=${capFailures.length}`);
     console.log(
       successes.length === 1 && capFailures.length === 9
         ? 'PASS: exactly one create succeeded, nine hit DAILY_CAP_EXCEEDED'
         : 'FAIL: expected exactly 1 success and 9 DAILY_CAP_EXCEEDED failures — investigate before shipping'
     );

     await supabase.from('withdrawals').delete().eq('phone_number', PHONE);
   }

   async function scenarioB_sameWalletDifferentPhones() {
     // Same wallet + amount, 10 DIFFERENT phones: dup-check enforcement.
     // Exercises the dual-lock fix — a phone-only lock would let all 10
     // race past the (wallet, amount) EXISTS check since no two of them
     // share a phone lock.
     const wallet = `${WALLET_PREFIX}DUPW`.padEnd(44, '0');
     const phones = Array.from({ length: 10 }, (_, i) => `+2327600${String(1000 + i).slice(-4)}`);

     await supabase.from('withdrawals').delete().eq('from_wallet_address', wallet);

     const results = await Promise.allSettled(
       phones.map((phone, i) =>
         supabase.rpc('create_withdrawal_guarded', {
           p: baseWithdrawal({ i, phone, wallet, amount: ATTEMPT_AMOUNT }),
           p_daily_cap: DAILY_CAP // plenty of headroom — this scenario isn't testing the cap
         })
       )
     );

     const outcomes = results.map((r, i) => {
       if (r.status === 'rejected') return { i, ok: false, reason: String(r.reason) };
       const { data, error } = r.value;
       return { i, ok: !error && !!data, reason: error?.message ?? null };
     });
     const successes = outcomes.filter(o => o.ok);
     const dupFailures = outcomes.filter(o => !o.ok && /DUPLICATE_OPEN_WITHDRAWAL/.test(o.reason || ''));

     console.log('--- Scenario B: same wallet+amount, different phones, dup-check enforcement ---');
     console.log(JSON.stringify(outcomes, null, 2));
     console.log(`successes=${successes.length} dupFailures=${dupFailures.length}`);
     console.log(
       successes.length === 1 && dupFailures.length === 9
         ? 'PASS: exactly one create succeeded, nine hit DUPLICATE_OPEN_WITHDRAWAL'
         : 'FAIL: expected exactly 1 success and 9 DUPLICATE_OPEN_WITHDRAWAL failures — the dual-lock fix in 0016 did not land correctly'
     );

     await supabase.from('withdrawals').delete().eq('from_wallet_address', wallet);
   }

   async function main() {
     if (!APPLICATION) throw new Error('Set B5_PROOF_APPLICATION to a real application uuid');
     await scenarioA_sameCap();
     await scenarioB_sameWalletDifferentPhones();
   }

   main().catch((err) => { console.error(err); process.exit(1); });
   ```

   Run it:

   ```bash
   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... B5_PROOF_APPLICATION=<test-app-uuid> \
     node scripts/b5-concurrency-proof.mjs
   ```

   Expected output: `successes=1 capFailures=9` + `PASS` for Scenario A, and
   `successes=1 dupFailures=9` + `PASS` for Scenario B. Paste the full
   transcript (both scenarios) here once run:

   ```
   <paste the script's JSON output + PASS/FAIL lines for both scenarios here>
   ```

   If either scenario ever prints more than one success, the corresponding
   advisory lock isn't doing its job — stop and re-check that migration 0016
   applied cleanly (step 2, including both locks) before shipping withdrawals
   traffic.

## Task B6 — apply 0017

1. **Apply the unmatched-transfers migration:**

   ```bash
   supabase db push
   # or, applied directly against the prod connection string:
   psql "$SUPABASE_DB_URL" -f supabase/migrations/0017_unmatched_transfers.sql
   ```

2. **Confirm the table exists:**

   ```sql
   select table_name from information_schema.tables
     where table_name = 'unmatched_transfers';
   -- Expected: 1 row
   ```

3. **Capture a Helius fixture and verify the amount-parse assumption.**
   Follow `docs/fixtures/helius/README.md`: trigger one real USDC transfer
   into the treasury wallet (devnet is fine) and save the verbatim
   Enhanced Webhook body to `docs/fixtures/helius/transfer.json`. Confirm
   `rawTokenAmount.tokenAmount` is an integer string in minor units (and
   that `rawTokenAmount.decimals` is `6`), per the
   `// ASSUMPTION(V-D-adjacent)` marker in
   `src/routes/webhooks/helius-handler.js`. **The fixture wins** — fix that
   line if the live payload disagrees.

4. **Rehearse the suspense runbook once on devnet** before it's needed for
   real: follow `docs/runbooks/unmatched-transfer.md` end to end against a
   deliberately-unmatched devnet transfer (send USDC to the devnet
   treasury from a wallet with no open withdrawal), confirming the
   `suspense_in` journal posts, the admin endpoint
   (`GET /v1/admin/unmatched-transfers`) lists it, and the runbook's
   verification queries return the expected balances after resolving it.

## Task B7 — apply 0018

1. **Apply the idempotency-keys migration:**

   ```bash
   supabase db push
   # or, applied directly against the prod connection string:
   psql "$SUPABASE_DB_URL" -f supabase/migrations/0018_idempotency_keys.sql
   ```

2. **Confirm the table exists:**

   ```sql
   select table_name from information_schema.tables
     where table_name = 'idempotency_keys';
   -- Expected: 1 row
   ```

3. **Document the client contract** in kola-docs (D4): clients send
   `Idempotency-Key: <uuid>` on `POST /v1/deposits` and
   `POST /v1/withdrawals`; a replay with the same key and body returns the
   original response, the same key with a different body returns `422`,
   and a key still in flight returns `409` with `Retry-After: 2`.

4. **Wire the >24h cleanup into C1's cron** when that task lands — this
   task only creates the table; nothing currently prunes old rows. Done:
   task C1's `cleanupIdempotencyKeys` pass (`src/repos/reconciliation.js`'s
   `deleteExpiredIdempotencyKeys`) now runs every 5 minutes via
   `POST /internal/reconcile-tick` — see "Task C1" below for the first-run
   verification steps.

## Task B8 — run stranded-funds audit against mainnet

`POST /v1/deposits` now requires a real `walletAddress` and
`POST /v1/wallets/derive` returns `410 Gone` — this closes finding F4 (a
phone-derived address has no private key, so USDC sent to it is
permanently unspendable) going forward. What's still unknown is whether any
*existing* `derived_wallets` rows already received USDC before this landed.

1. **Run the audit script** against production (read-only; does not touch
   any tables):

   ```bash
   node --env-file=.env scripts/audit-derived-wallets.js
   ```

   It lists every row in `derived_wallets` with its wallet address and
   on-chain USDC ATA balance, then prints a `TOTAL LOCKED` figure in minor
   units and USDC.

2. **If `TOTAL LOCKED` is `0`:** nothing is stranded — no further action,
   note the result (and the date run) in
   `docs/incidents/2026-09-open-db-review.md` for the record.

3. **If `TOTAL LOCKED > 0`:** that amount is real customer money that is
   **not recoverable** — there is no private key for these addresses, on
   Solana or anywhere else.
   - Record the full script output and the total in
     `docs/incidents/2026-09-open-db-review.md` as a loss.
   - Once migration `0015` (the ledger, task B4) is applied, post an
     `adjustment` journal for the locked amount so the ledger reflects the
     loss rather than silently understating it — see `src/repos/ledger.js`
     for the posting helpers. Do not attempt any code path that tries to
     "recover" or re-derive these funds; the decision record
     (`docs/decisions/0001-derived-wallets.md`) exists precisely because
     this path is closed.

## Task C1 — enable reconcile cron + first-run verification

Task C1 adds no new migration — `POST /internal/reconcile-tick` reads
tables created by earlier migrations (0015 ledger, 0017 unmatched
transfers, 0018 idempotency keys) and requires no schema change. What's
outstanding is deploying it and watching the first few live runs.

1. **Set `STUCK_THRESHOLD_MINUTES`** in Vercel (production + preview) if
   the default of 30 isn't right for launch traffic; confirm the
   `crons` entry in `vercel.json`
   (`POST /api/internal/reconcile-tick`, `*/5 * * * *`) is deployed. It
   shares `CRON_SECRET` with the transfer-tick cron (task B3) via the same
   `src/utils/cron-auth.js` guard — no new secret to provision.

2. **Trigger one manual run** and confirm the per-pass summary:

   ```bash
   curl -s -X POST "$API_BASE_URL/api/internal/reconcile-tick" \
     -H "X-Cron-Secret: $CRON_SECRET" | jq .
   ```

   Expected: a JSON body with `sweepMissedEvents`, `proveBalance`,
   `sweepStuckRows`, `cleanupIdempotencyKeys`, each `{ ok: true, result:
   {...} }` (a pass that threw instead reports `{ ok: false, error: "..."
   }` without taking the other three passes down with it).

3. **Confirm the balance proof passes clean on a fresh production
   treasury** — `proveBalance.result.mismatch` should be `false`. If it's
   `true`, this is a live `RECONCILIATION_MISMATCH` — do not silence or
   widen the tolerance (it's intentionally 0, per the brief: gas is paid in
   SOL, not USDC, so on-chain and ledger USDC balances must match exactly).
   Investigate via `docs/runbooks/unmatched-transfer.md`-style manual query
   before doing anything else with the treasury.

4. **Deliberately create one stuck row** to prove pass 3 actually surfaces
   something (devnet is fine): enqueue a `transfer_jobs` row, wait past
   `STUCK_THRESHOLD_MINUTES` without letting the transfer-tick cron run
   (e.g. temporarily disable that cron, or set an artificially low
   threshold for the test), then trigger reconcile-tick manually and
   confirm `sweepStuckRows.result` contains that row's id with
   `table: "transfer_jobs"` and the function logs `[Reconcile] ALERT: STUCK
   <id> ...` to the Vercel function logs.

5. **Confirm the missed-event sweep is a true no-op in the common case** —
   on a treasury with no dropped Helius deliveries, `sweepMissedEvents.
   result.replayed` should be `[]` on every run. If it's ever non-empty in
   steady state, that's a real finding: Helius silently dropped a webhook
   delivery for that signature, and this pass is what caught it instead of
   the transfer sitting unprocessed indefinitely — no further action is
   needed (the replay path is safe by construction, CAS/unique-keyed all
   the way down) beyond noting it happened.

6. **Confirm idempotency-key housekeeping is actually pruning** — check
   `cleanupIdempotencyKeys.result.deleted` is non-zero after the table has
   had >24h to accumulate rows in production traffic (it will read `0` on
   a fresh deploy with no rows old enough yet — that's expected, not a
   failure).

## Task C2 — apply 0019 + set ADMIN_KEYS

1. **Apply the audit-log migration** (requires 0015's `forbid_ledger_mutation()`
   — already applied under Task B4):

   ```bash
   supabase db push
   # or, applied directly against the prod connection string:
   psql "$SUPABASE_DB_URL" -f supabase/migrations/0019_audit_log.sql
   ```

2. **Confirm the table and immutability trigger landed:**

   ```sql
   select table_name from information_schema.tables where table_name = 'audit_log';
   -- Expected: 1 row

   select trigger_name from information_schema.triggers
     where event_object_table = 'audit_log';
   -- Expected: trg_audit_immutable, x2 rows (fires on both UPDATE and DELETE)
   ```

3. **Set `ADMIN_KEYS`** in Vercel (production + preview) and in local
   `.env` — one named key per operator, format:

   ```
   ADMIN_KEYS="mitchel:<long-random-secret>,ops2:<another-long-random-secret>"
   ```

   Every admin action (API key create/deactivate, exchange rate set) is
   now attributed to the matching name in `audit_log.actor`, closing the
   blast-radius gap where all admin traffic was indistinguishable under
   one shared secret (F14). Generate each secret the same way the old
   `ADMIN_SECRET_KEY` was generated (long random string, not a password);
   give each operator their own `name:secret` pair and their own
   `X-Admin-Key` value — never share one pair across two people.

4. **`ADMIN_SECRET_KEY` is now deprecated** — it is still accepted for one
   release as a fallback (requests using it are attributed to actor
   `'legacy'` in `audit_log`), so existing automation keeps working during
   the migration window. Once every operator/script has a named key in
   `ADMIN_KEYS`, remove `ADMIN_SECRET_KEY` from Vercel and delete the
   legacy-key branch in `src/middleware/admin-auth.js`.

5. **Confirm attribution end-to-end**: with a named key set, call
   `PUT /v1/admin/exchange-rates` (or any admin mutation) and check the
   latest `audit_log` row — `actor` should be the key's name (not
   `'legacy'`), and `before`/`after` should hold the previous/new rate
   with no key hashes or raw keys anywhere in the row.

6. **`setBy` in the exchange-rate request body is now ignored.** The
   schema still accepts it for wire-compat with existing clients, but the
   authenticated admin key's name is what gets written to
   `exchange_rates.set_by` and to `audit_log.actor`. No client change is
   required immediately, but `setBy` can be dropped from future client
   requests — it does nothing.

## Task C3 — provision Upstash + set env

1. **Provision Upstash Redis** via the Vercel Marketplace integration and
   land `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` in Vercel
   (production + preview) and in local `.env` — see `.env.example`.

2. Per-key rate limiting (`auth_api_keys.rate_limit`, requests/minute,
   default 100) is enforced by `src/middleware/rate-limit.js` on the
   `wallets`, `deposits`, and `withdrawals` routers, mounted after
   `apiKeyAuth` and before the per-route idempotency middleware. Until the
   env vars above are set, the middleware fails open (passes every request
   through, logs one `logger.warn` line) — no client-visible change happens
   until Upstash is actually provisioned.

3. **Confirm enforcement end-to-end** once the env vars are set: fire
   requests past a key's `rate_limit` within a minute and confirm a `429`
   with `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`
   and `Retry-After` headers, then confirm the count resets after the
   sliding window rolls over.

## Task C4 — structured logging, config validation, Sentry, error envelope

1. **`api/index.js` now validates every required env var at startup**
   (`validateConfig()` in `src/utils/config.js`, called before any route
   module loads). A deploy missing any of `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `MONIME_ACCESS_TOKEN`, `MONIME_SPACE_ID`,
   `MONIME_WEBHOOK_SECRET`, `MONIME_FINANCIAL_ACCOUNT_ID`, `HELIUS_URL`,
   `TREASURY_SECRET_KEY`, `USDC_MINT`, `HELIUS_WEBHOOK_AUTH_HEADER`,
   `API_KEY_SALT`, or `CRON_SECRET` now fails to boot with one error
   listing every missing var, instead of surfacing later as an opaque
   failure the first time a request touches the missing var. Nothing to
   provision here if Vercel env is already complete — this only changes
   *when* a misconfiguration is caught (deploy time, not first request).

2. **(Optional) Provision Sentry**: set `SENTRY_DSN` in Vercel
   (production + preview) to start receiving 5xx errors
   (`DatabaseError`/`MonimeError`/`OnChainError`/unknown) in Sentry —
   `src/utils/sentry.js` is a no-op without it, so this is safe to skip
   initially. See `.env.example`.

3. **Every error response now uses one envelope**:
   `{ "error": { "code": "...", "message": "...", "request_id": "..." } }`.
   This replaces the previous mix of `{ "success": false, "message": "..." }`
   (global error handler) and ad-hoc `{ "error": "some string" }` shapes
   (auth 401s, kill-switch 503, idempotency 409/422, rate-limit 429, and
   several route-level 400/404/410/500s). Any client parsing error bodies
   by string-matching `error` as a plain string must be updated to read
   `error.message` (and can key retry/UI logic off `error.code`, which is
   stable — e.g. `'ValidationError'`, `'Unauthorized'`, `'RateLimited'`,
   `'ServiceUnavailable'`, `'InternalError'`). Webhook acks
   (`{ "received": true, ... }`) are unaffected — they were never errors.

4. **Structured logging (pino) with PII redaction** is now the only
   logging path in `src/` and `api/` — every `console.log`/`console.error`/
   `console.warn` call site was swept onto `logger` (`src/utils/logger.js`).
   `phone_number`/`phoneNumber`/`wallet_address`/`walletAddress`/
   `destination`/`from_wallet` are redacted to `"[redacted]"` wherever they
   appear as a structured field. Page-worthy lines (reconciliation
   mismatches, stuck rows, unmatched transfers, amount mismatches, ledger/
   audit posting failures, permanent transfer-job failures) are logged as
   `logger.error({ alert: true, ... }, 'MESSAGE')` — wire a Better
   Stack/Sentry/PagerDuty alert rule on `alert:true` in whatever log sink
   Vercel logs are shipped to.

5. **Every request now carries a `request_id`** (`src/middleware/
   request-context.js`, mounted first, before the kill switch), and one
   access-log line (`route`, `method`, `status`, `latency_ms`,
   `request_id`) is emitted per request on completion. The same
   `request_id` is echoed in every error envelope above — useful for
   correlating a client-reported error with the corresponding server log
   line.

## Task C5 — set SOLANA_RPC_FALLBACK_URL + verify failover

1. **Provision a second Solana RPC provider** (any provider other than the
   one behind `HELIUS_URL`) and set `SOLANA_RPC_FALLBACK_URL` in Vercel
   (production + preview) and local `.env` — see `.env.example`. Leaving
   it unset is safe: `withRpcFailover()` (`src/utils/connection.js`) just
   rethrows the primary's error with no retry, which is today's behavior.

2. **Verify failover end-to-end** once the env var is set: point
   `HELIUS_URL` at an unreachable/invalid endpoint temporarily (or block it
   at the network level) in a non-production environment and confirm a
   read (e.g. `GET /v1/wallets/:address/balance`) still succeeds via the
   fallback, and that a `[RPC] primary failed, trying fallback` line with
   `alert:true` appears in the log stream.

3. **Commitment level changed:** the connection (both primary and
   fallback) now defaults to `'finalized'` instead of `'confirmed'` (B3
   deferral, F17) — deposits/payouts already had several call sites pinned
   to `'finalized'` individually; this closes the gap for the rest.
   Finalized confirmation is slower than confirmed (waits for a
   supermajority-rooted block, typically several more seconds), so expect
   slightly higher latency on balance checks and signature-status polling.
   No action needed — this is a correctness fix, flagging the latency
   change in case it shows up in monitoring.

4. **Helius dashboard check (V-D):** log into the Helius dashboard and
   check whether the current plan supports webhook HMAC/request signing.
   Record the outcome in `docs/fixtures/helius/AUTH.md`:
   - If available: enable it, then extend `verifyHeliusAuth`
     (`src/utils/helius.js`) to verify the signature header instead of the
     static bearer.
   - If not available: no action needed — `docs/fixtures/helius/AUTH.md`
     already documents why the static bearer is an acceptable posture
     (the handler never trusts the payload's money claims; see that file).

## Task D1 — enable branch protection on main requiring the 'test' check

## Task D2 — run the integration suite

The money-path integration suite (`__tests__/integration/`) exists and is
committed, but it **has never been executed**: this environment had no
Supabase CLI and no Docker, so there was no Postgres to run it against.
Everything in it was written directly against the real routes, repos and
migration files, but first-run breakage is expected and normal. This is the
single highest-value item on this checklist — it is the only thing that
exercises `create_withdrawal_guarded`'s advisory locks, the compare-and-swap
claims, the state-machine triggers and the ledger balance trigger against a
real database.

1. **Install the prerequisites** (once): Docker Desktop, and the Supabase
   CLI (`brew install supabase/tap/supabase`).

2. **Follow `docs/testing.md` → "Integration suite"** end to end. The short
   version:

   ```bash
   supabase start                      # note the printed service_role key
   export SUPABASE_SERVICE_ROLE_KEY='<service_role key>'
   # apply the migration chain in TRUE numeric order — see the caveat below
   psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
     -v ON_ERROR_STOP=1 -f supabase/migrations/001_initial_schema.sql -f ...
   npm run test:integration
   ```

3. **Do not use `supabase db reset` on a fresh stack without checking the
   order first.** The CLI sorts migrations lexicographically by their
   numeric prefix, and `001` sorts *after* `0009`, so a reset tries to
   create `withdrawals` before `auth_api_keys` exists and stops with
   `relation "auth_api_keys" does not exist`. Verify with
   `supabase migration list`. `docs/testing.md` gives the explicit ordered
   `psql` apply that sidesteps the question. **Do not rename
   `001_initial_schema.sql`** to fix the sort — production's migration
   history records that exact version string, so a rename would make
   `supabase db push` treat it as a new migration. If you want the chain
   renumbered, that needs a decision record and a coordinated history
   repair, not a quiet rename.

4. **Expect to iterate.** When a spec fails, the failure is evidence about
   one of three things, in this order of likelihood:
   - a harness assumption (a synthetic payload field, a seeded env value) —
     fix `__tests__/integration/helpers.js`;
   - a schema difference introduced out-of-band in the missing `0002`–`0006`
     gap (`supabase/migrations/README.md`) — promote it into a real
     migration numbered `>= 0009` so the chain becomes self-sufficient;
   - an actual bug in the money path — which is the point of the suite.
     Fix the code, not the assertion.

5. **Consider wiring it into CI** once it is green locally. It needs a
   Postgres service container plus the migration apply, and
   `INTEGRATION_REQUIRE_STACK=1` so a missing stack fails the job instead of
   silently skipping every spec (the default behaviour, chosen so that
   `npm run test:integration` on a laptop without Docker exits 0 rather than
   dumping 25 connection errors).

6. **Follow-up flagged by the suite (not a blocker).** The dual-racer fuzz
   documents a real operational wart: when a manual `POST /:id/confirm`
   wins the compare-and-swap, the losing Helius callback for the *same*
   on-chain transfer no longer matches an open withdrawal and books that
   transfer to `unmatched_transfers` + a `suspense_in` journal. No money is
   lost or double-paid (the spec asserts every such row corresponds to a
   withdrawal already in `processing`), but it raises a phantom suspense
   item for an operator to chase. The fix is for the no-match path in
   `src/routes/webhooks/helius-handler.js` to check whether the signature is
   already recorded on a withdrawal or deposit — `hasProcessedSignature()`
   in `src/repos/reconciliation.js` is exactly that query — before booking
   to suspense.
