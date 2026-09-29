# Monime webhook fixtures

Live fixture capture was not possible in the sandboxed environment this
work was done in (no Monime account/devnet access). This directory is a
placeholder specifying exactly what the founder must capture before the
`// ASSUMPTION(V-A)` field paths in `src/routes/webhooks/monime.js` can be
treated as verified.

## What to capture

Point a devnet/test Monime webhook at a capture endpoint (or pull raw
bodies from Monime's dashboard event log) and save, **verbatim**, one JSON
body per event type into this directory:

- `checkout_session.completed.json`
- `payment_code.completed.json`
- `payment_code.processed.json` (if this event exists — confirm via the
  dashboard event-type list even if you can't trigger one)
- `payout.completed.json`
- `payout.failed.json`

Do not redact, reformat, or hand-transcribe these — save the exact bytes
Monime sent, since the whole point is pinning field paths and units.

## Questions to answer

Once the fixtures are captured, answer these in this file (replace this
section with the answers):

1. **Event-id field path.** The code currently reads `payload.event.id`
   (`src/routes/webhooks/monime.js`, top of `app.post('/')`, marked
   `// ASSUMPTION(V-A)`). Confirm this is where Monime actually puts a
   stable per-delivery id — not the payment/session id, which repeats
   across `processed` → `completed` for the same payment.

2. **Collected-amount field path + units.** The code currently reads
   `payload.data.amount.value` as SLE minor units (`src/routes/webhooks/
   monime.js`, inside `handleDepositEvent`, marked
   `// ASSUMPTION(V-A)`). Confirm the path and confirm the units match
   `deposits.amount_sle` (minor units, i.e. cents — SLE ×100 per
   `global-constraints.md`). If Monime sends major units or a different
   field, the comparison in `handleDepositEvent` breaks silently in the
   wrong direction (either false mismatches, parking every deposit, or
   worse, false matches).

3. **Does `payment_code.processed` and `payment_code.completed` both
   fire for one payment?** Check the dashboard event log timeline for a
   single completed payment-code payment.

4. **Retry behaviour on a non-2xx response.** Return a 500 from the
   capture endpoint once and observe whether/how many times Monime
   retries, and over what window. The live API now returns `503` (with
   `Retry-After: 60`) whenever the `recordWebhookEvent` exactly-once gate
   itself fails (e.g. a transient Supabase outage), specifically so Monime
   retries instead of the event being silently swallowed as a false
   duplicate — confirm Monime does in fact retry on `5xx` responses.

## THE FIXTURE WINS

If any captured fixture contradicts a path/unit assumption above, **fix
the code to match the fixture, not the other way around.** Exact
locations to correct if they differ:

- Event id: `src/routes/webhooks/monime.js`, `const eventId = payload.event?.id;`
- Collected amount: `src/routes/webhooks/monime.js`, inside
  `handleDepositEvent`, `const paid = payload.data?.amount?.value;`

Both lines are marked with `// ASSUMPTION(V-A): verify against
docs/fixtures/monime/ — fixture wins` comments — grep for `ASSUMPTION(V-A)`
to find every call site that needs revisiting.

## Standing decision: keep `payment_code.processed` in `successEvents`

The brief conditioned removing `payment_code.processed` from
`successEvents` on fixture evidence that `processed` and `completed` both
fire for the same payment (in which case `completed` alone would be the
settlement signal and `processed` would be redundant/riskier to keep).
Without that evidence, this task keeps `payment_code.processed` in
`successEvents`, for two reasons:

1. **Fail-closed principle.** The A3 CAS claim (`updateDepositIfStatus`
   `pending` → `processing`) makes a double-fire impossible even if both
   `processed` and `completed` arrive for the same deposit — only the
   first delivery to win the compare-and-swap ever calls
   `handleDepositSuccess`'s transfer path. Removing `processed` trades a
   real, already-covered risk (a harmless second success event) for an
   unverified one (breaking a payment path).
2. **USSD deposits may have no other terminal event.** Payment codes are
   used for the USSD/one-time flow; if `processed` is the only terminal
   success event Monime sends for that flow (i.e. `completed` never
   fires for payment-code payments), removing `processed` would silently
   break USSD deposits — they'd sit `pending` forever.

Once the fixtures above are captured and confirm `completed` always fires
for every payment-code payment (with `processed` merely preceding it),
this decision can be revisited and `processed` removed as redundant. Until
then, both event names stay in `successEvents` and rely on the A3 CAS
layer + the exactly-once event gate (this task, B2) to prevent any double
transfer.
