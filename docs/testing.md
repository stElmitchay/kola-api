# Testing kola-api

Two suites, deliberately separate.

| | command | needs | runs in CI |
|---|---|---|---|
| **Unit** | `npm test` | nothing | yes (`.github/workflows`) |
| **Integration** | `npm run test:integration` | a local Supabase stack | not yet — see below |

`npm test` never runs the integration specs: `jest.config.json` ignores
`__tests__/integration/`. The integration script overrides that ignore and
adds `--runInBand` (every spec shares one database, so they must not
interleave) plus `INTEGRATION=1`.

---

## Unit suite (`npm test`)

Pure, fast, hermetic. Everything below the unit under test is mocked with
`jest.unstable_mockModule` + dynamic `import()` (ESM has no `jest.mock`
hoisting). No network, no database, no clock control.

Add a unit test when the thing you want to pin is a decision your code
makes — a bound, a branch, a CAS argument, a redaction path. Files live
beside their subject: `__tests__/<area>/<subject>.test.js`.

---

## Integration suite (`npm run test:integration`)

### What it is

Four spec files under `__tests__/integration/`, driving the **real Hono app**
(`api/index.js` exports the raw `app`, which the specs call via
`app.request()` — same routers, same middleware chain, same error handlers)
against a **real Postgres**.

Only the three external vendors are faked, and each at the narrowest
possible boundary:

| Vendor | How | What still runs for real |
|---|---|---|
| Monime | `globalThis.fetch` is wrapped; only `https://api.monime.io` is answered locally, everything else (all PostgREST traffic) passes through | all of `src/utils/monime.js` — request building, auth headers, `Idempotency-Key`, timeout signal, error-detail extraction, and `verifyWebhookSignature`'s HMAC |
| Helius | nothing is mocked | the real `/api/webhooks/helius` route, the real static-bearer check, the real amount parse — synthetic Enhanced-Webhook payloads are POSTed in |
| Solana | `src/utils/solana.js` is replaced via `jest.unstable_mockModule` | everything else; the mock records a tiny in-memory "chain" tally (inbound verified, outbound broadcast) that the ledger spec asserts against |

`@vercel/functions`' `waitUntil` is also stubbed. It is not a vendor — it is
the platform — but the best-effort sweep it kicks off from the deposit
webhook is a latency optimization whose completion is unobservable from a
test. The specs therefore drive the sweep explicitly through the real
`POST /api/internal/transfer-tick` cron route (real `CRON_SECRET` auth), so
"exactly one broadcast" is an assertion about the sweep's claim fence, not
about background timing.

**Everything else is real**: `src/repos/*`, the RPCs
(`create_withdrawal_guarded`, `post_journal`, `set_exchange_rate`), the
state-machine triggers (0012), the ledger immutability + deferred balance
triggers (0015), and every unique index.

### First-time setup

You need the Supabase CLI and Docker. Neither was available in the
environment this suite was written in, which is why it has never been
executed — expect to iterate on the first run.

```bash
# 1. Start the local stack (Postgres on 54322, PostgREST on 54321)
supabase start
```

`supabase start` prints an `anon key` and a `service_role key`. **Copy the
service_role key** — the API only ever uses the service-role key (RLS is
deny-all with no policies after migration 0009, and `anon` has no grants on
`public`), so the suite needs it too:

```bash
export SUPABASE_SERVICE_ROLE_KEY='<service_role key from supabase start>'
# optional — this is the default
export SUPABASE_URL='http://127.0.0.1:54321'
```

Nothing else needs exporting. `__tests__/integration/helpers.js` seeds every
other required env var itself (fake Monime credentials, a fixed treasury
keypair, a fixed `CRON_SECRET`, and the deposit/withdrawal bounds the specs
assert against), and it deletes `KOLA_PAUSE`, `UPSTASH_REDIS_REST_*` and
`SENTRY_DSN` so a paused kill switch, a live rate limiter, or a real Sentry
project cannot interfere.

### Applying the schema — do NOT use `supabase db reset` blindly

Read `supabase/migrations/README.md` first. Two facts make the local apply
non-obvious:

1. **Migrations `0002`–`0006` do not exist.** They were applied by hand
   against production and were never captured as files. The chain in this
   repo (`001` + `0007` + `0008` + `0009`…`0019`) therefore does **not**
   reproduce production exactly. For the integration suite that is fine —
   every table, column, index, trigger and function the suite touches is
   defined by a file that IS in the chain (the mapping is in
   `.superpowers/sdd/PRODUCTION_FIX_PLAN/task-D2-report.md`). It matters
   only if a spec ever fails with "column does not exist" on something the
   report does not list: that would be one of the out-of-band changes, and
   it belongs in a new migration numbered `>= 0009`.

2. **File order is not numeric order.** Migrations are applied in
   lexicographic filename order, and `001_initial_schema.sql` sorts **last**
   — after every one of `0007`–`0019`. Two separate reasons, both from
   byte-wise comparison:
   - vs `0007`/`0008`/`0009`: they differ at the third character, where
     `1` (0x31) > `0` (0x30).
   - vs `0010`–`0019`: the first three characters are identical (`001`), so
     the comparison lands on the fourth, where `_` (0x5F) outranks every
     digit `0`–`9` (0x30–0x39).

   Effective order: `0007, 0008, …, 0019, 001`. So `supabase db reset` on a
   FRESH stack will try to create `withdrawals` (which references
   `auth_api_keys`) first and stop immediately with
   `relation "auth_api_keys" does not exist` — `001_initial_schema.sql`,
   the file that creates `auth_api_keys`, never gets a chance to run.
   Confirm with `supabase migration list` before trusting a reset.

   Renaming `001_initial_schema.sql` → `0001_…` would fix the ordering, but
   the version string is what production's `supabase_migrations` history
   already records, so renaming it in the repo makes `supabase db push`
   treat it as a brand-new migration. That is a decision for the founder,
   not a local convenience — leave the filename alone.

**Apply the chain explicitly instead**, in true numeric order:

```bash
DB='postgresql://postgres:postgres@127.0.0.1:54322/postgres'

psql "$DB" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/001_initial_schema.sql \
  -f supabase/migrations/0007_create_withdrawals.sql \
  -f supabase/migrations/0008_disable_rls_withdrawals.sql \
  -f supabase/migrations/0009_lockdown_rls.sql \
  -f supabase/migrations/0010_deposit_guards.sql \
  -f supabase/migrations/0011_exchange_rate_guards.sql \
  -f supabase/migrations/0012_state_machines.sql \
  -f supabase/migrations/0013_webhook_events.sql \
  -f supabase/migrations/0014_transfer_jobs.sql \
  -f supabase/migrations/0015_ledger.sql \
  -f supabase/migrations/0016_guarded_withdrawal.sql \
  -f supabase/migrations/0017_unmatched_transfers.sql \
  -f supabase/migrations/0018_idempotency_keys.sql \
  -f supabase/migrations/0019_audit_log.sql
```

Order notes that matter:

- `0008` **disables** RLS on `withdrawals`; `0009` **re-enables** it on every
  table, deny-all with no policies. That reversal is intentional and the end
  state is what production runs. The suite is unaffected because the
  service-role key bypasses RLS — but it is exactly why a test (or a
  dashboard session) using the **anon** key will see zero rows and zero
  errors. If a spec suddenly reports empty tables, check which key is in
  `SUPABASE_SERVICE_ROLE_KEY`.
- `0019` reuses `forbid_ledger_mutation()`, defined in `0015`. `0015` must be
  applied first or the trigger will not resolve.
- Re-running this block on an already-migrated database will fail on
  `CREATE TABLE` (the migrations are not idempotent). To start over:
  `supabase db reset` to get a blank database (it will fail partway through
  the migration ordering described above — that is fine, it has already
  dropped and recreated the schema by then), then run the psql block. Or
  `supabase stop --no-backup && supabase start`.

### Running it

```bash
npm run test:integration
```

Expected: 4 suites, all tests passing. Output is very noisy — the
production pino logger writes to stdout at `info` and the concurrency specs
generate thousands of lines. Pipe it:

```bash
npm run test:integration 2>&1 | grep -v '^{"level"'
```

**With no stack running, the suite skips and exits 0.** Every spec is
wrapped in `describeIntegration`, which is `describe` only when
`INTEGRATION=1` *and* a one-shot probe of `$SUPABASE_URL/rest/v1/` answered.
A skip always prints its reason to stderr. To make a missing stack a hard
failure instead (do this if the suite is ever wired into CI):

```bash
INTEGRATION_REQUIRE_STACK=1 npm run test:integration
```

### What the specs cover

**`deposit-lifecycle.test.js`** — bounds rejection top and bottom;
`Idempotency-Key` replay (identical stored response, one Monime call, one
row) and reuse-with-a-different-body (422); then the full path: initiate →
signed `payment_code.completed` webhook → `confirmed` + exactly one
`transfer_jobs` row + `deposit_collection` journal → real transfer-tick
sweep → `completed` with the broadcast signature + `deposit_payout` journal
→ a replayed delivery (same `event.id`, swallowed by the 0013 gate) and a
fresh-id redelivery (passes the gate, short-circuits on the terminal
status), neither of which changes anything or broadcasts twice. Plus the
amount-mismatch path (edited amount, and a missing amount field) parking the
deposit at `amount_mismatch` with no job and no journal, the expiry path,
and an unsigned webhook rejected before the event gate.

**`withdrawal-lifecycle.test.js`** — quote → verify → payout → completion
webhook, with the SLE fee split asserted against the row
(`amount_sle_gross` 2500, `amount_sle` 2475, fee 25 at 100 bps); a failed
on-chain verification leaving the row untouched; the duplicate-open
`(wallet, amount)` refusal; a `payout.failed` webhook recording its reason;
and the two concurrency proofs:

- **Daily-cap boundary.** 10 creates fired at once for one phone (distinct
  wallets, so the global `(wallet, amount)` duplicate check is not what
  rejects them) against a cap with room for exactly 3. Exactly 3 get 201,
  7 get a 400 naming the cap, and the summed `amount_usdc` in the database
  equals the cap. This is the part that needs a real database: the cap sum,
  the duplicate check and the INSERT all run inside
  `create_withdrawal_guarded` under two ordered `pg_advisory_xact_lock`s
  (0016). Without the locks, concurrent creates read the same stale sum and
  both pass — a real over-cap payout.
- **Dual-racer CAS fuzz, 50 rounds.** A fresh withdrawal per round, then
  100 requests fired in one `Promise.all`: for every row, the manual
  `POST /:id/confirm` and a synthetic Helius callback, both carrying the
  **same** signature (in production they are two notifications of one
  on-chain transfer). Asserted: exactly one `POST /v1/payouts` per
  withdrawal id, all 50 rows land on `processing` with that signature, one
  `withdrawal_receipt` journal each, every journal balanced.

  Suspense bookkeeping is asserted rather than assumed: when the manual
  confirm wins the `pending_deposit → received` CAS, the losing Helius
  delivery no longer finds an open withdrawal for `(wallet, amount)` and
  books the transfer to `unmatched_transfers` + a `suspense_in` journal
  (0017/F11 — it never drops inbound USDC it cannot match). Those rows are
  expected, and the spec requires every one of them to be a *duplicate*
  booking of already-credited money: its signature must belong to a
  withdrawal now in `processing`. **This is a real operational defect worth
  a follow-up**: a Helius delivery for a transfer the manual confirm
  already accounted for raises a phantom suspense item for an operator to
  chase. A fix would be for the no-match path to check whether the
  signature is already recorded on a withdrawal/deposit (the
  `hasProcessedSignature` query already exists in
  `src/repos/reconciliation.js`) before booking to suspense.

**`deposit-fuzz.test.js`** — 50 distinct success deliveries for ONE deposit
fired at once (distinct `event.id`s, so the exactly-once gate lets all 50
through and the `pending → confirmed` CAS is the only thing in the way).
Asserted: 50 gate rows, exactly one `transfer_jobs` row (UNIQUE
`deposit_id`), exactly one `deposit_collection` journal (UNIQUE
`idempotency_key`), and after the sweep exactly ONE
`buildSignedUsdcTransfer` and ONE `sendSerializedTransaction` — the
double-pay proof. Then five overlapping ticks against one queued job
(`recordSignature` fences on the exact `(status, signature)` each tick
observed), and 50 deliveries spread over 10 deposits producing exactly 10
jobs.

**`ledger-invariants.test.js`** — after a full deposit leg and a full
withdrawal leg: the `treasury_usdc` ledger delta equals the mocked chain's
net movement (inbound verified receipts minus outbound broadcasts), every
journal in the database balances per currency, the withdrawal fee lands in
`fee_income_sle` as gross − net, both payable accounts return to flat once
their legs complete, and the append-only triggers reject an UPDATE and a
DELETE against `ledger_journals`/`ledger_entries`.

### Why the ledger is never truncated

`0015` installs `forbid_ledger_mutation()` as a statement-level
`BEFORE UPDATE OR DELETE` trigger on `ledger_entries`, `ledger_journals`
(and `0019` on `audit_log`). `TRUNCATE` is a different trigger event and is
deliberately **not** covered (a B4 deferral), but PostgREST cannot issue
`TRUNCATE` — and resetting the ledger between tests would quietly weaken the
very invariant this suite exists to prove. So:

- `resetMoneyTables()` clears `transfer_jobs`, `deposits`, `withdrawals`,
  `webhook_events`, `unmatched_transfers`, `idempotency_keys` (FK-safe
  order, `.not(col, 'is', null)` because PostgREST refuses an unfiltered
  DELETE). `resetAll()` additionally clears `exchange_rates`,
  `derived_wallets`, `auth_api_keys`.
- Ledger assertions are written to survive whatever earlier rows exist:
  "every journal balances" is a global invariant, and the treasury check is
  a before/after delta.
- **Consequence:** the ledger grows on every run. Aggregation happens in JS
  (PostgREST has no GROUP BY, and this task added no migration), so a
  database that has accumulated many runs will slow the ledger spec down.
  Re-apply the schema from scratch occasionally. The readers refuse to
  compute an invariant over a truncated PostgREST page — if you see
  "PostgREST truncated the page", lower `db-max-rows` is the cause.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Everything skips, exit 0 | No stack, or `SUPABASE_SERVICE_ROLE_KEY` unset. The reason is printed on stderr. |
| `relation "auth_api_keys" does not exist` during `supabase db reset` | The migration-ordering trap above. Use the ordered `psql` block. |
| Every table looks empty, no errors | You are using the **anon** key. RLS is deny-all after 0009. |
| `Missing required environment variables: …` at import | Something deleted an env var `helpers.js` seeds; it must be imported (statically) before `api/index.js`. |
| `unmocked Monime endpoint POST /v1/…` (501) | A new Monime call was added to `src/`; teach `monimeResult()` in `helpers.js` about it. |
| 429s / `RateLimited` | `UPSTASH_REDIS_REST_*` leaked in from a real shell env after `helpers.js` deleted them. |
| 503 `Service temporarily paused` | `KOLA_PAUSE=1` set after `helpers.js` deleted it. |
| Cap/fuzz specs time out | PostgREST connection-pool contention under 100 in-flight requests. Raise `db-pool` in `supabase/config.toml`, or lower `FUZZ_ROUNDS`. |
| A spec fails on a column the report's table does not list | Likely one of the out-of-band `0002`–`0006` changes. Promote it into a migration `>= 0009`. |

### Fixtures still outstanding

The Monime and Helius payloads the specs build are synthetic, shaped to the
field paths the handlers read — which are still marked
`ASSUMPTION(V-A)` / `ASSUMPTION(V-D-adjacent)` in the source. Capturing the
real bodies (`docs/fixtures/monime/README.md`,
`docs/fixtures/helius/README.md`) is still required, and **the fixture
wins**: if a captured body contradicts a path or unit, fix the handler AND
the builders in `helpers.js` to match it.
