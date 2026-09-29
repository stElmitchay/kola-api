# Game day: Helius outage, C1 missed-event sweep recovery

**TEMPLATE — run and rename with the date**
(`docs/game-days/<YYYY-MM-DD>-helius-outage-sweep.md`)

## What this proves

If Helius never delivers a webhook for a real on-chain USDC transfer into
the treasury (dashboard outage, webhook disabled, delivery silently
dropped), the withdrawal it was meant to settle does not sit stuck forever.
`sweepMissedEvents` (`src/routes/internal/reconcile-tick.js`, pass 1 of
`runReconcile`) walks the treasury ATA's recent on-chain signatures every 5
minutes (`vercel.json`'s `*/5 * * * *` cron) and replays anything
`hasProcessedSignature` doesn't already know about through the same
`handleHeliusEvent` the webhook itself calls. This drill proves:

1. A transfer with no webhook delivery is picked up by the sweep and the
   withdrawal advances normally.
2. When Helius eventually redelivers (or is manually replayed) for the SAME
   signature, nothing double-processes — `hasProcessedSignature` short-
   circuits it.

## Preconditions

- **Devnet only.** `USDC_MINT` + `HELIUS_URL` set to devnet values
  (`.env.devnet`), a funded devnet treasury keypair, and a real Helius
  webhook configured against a devnet-reachable deploy of this branch (or
  `vercel dev` tunneled — Helius needs a public URL to call back to; a
  local-only `vercel dev` will not receive webhooks, which is fine for this
  drill since the whole point is that the webhook does NOT fire).
- `CRON_SECRET` set, so the manual reconcile-tick trigger in Step 4 works.
- A seeded test application + active exchange rate on the scratch/devnet
  Supabase project.
- Access to the Helius dashboard for the project's webhook config (to
  disable/re-enable delivery).

## Step 1 — create and fund a withdrawal, but do NOT confirm it

```bash
curl -s -X POST "$API_BASE_URL/api/v1/withdrawals" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $TEST_API_KEY" \
  -d '{
    "amountUsdc": 500000,
    "phoneNumber": "+23276000222",
    "providerCode": "m17",
    "fromWalletAddress": "<a devnet wallet you control>"
  }'
# Note `id` and `treasuryAddress`. Do NOT call /:id/confirm — the point of
# this drill is the AUTO-confirm path (Helius), not the manual one.
```

## Step 2 — disable the Helius webhook

In the Helius dashboard, disable (or delete) the webhook pointed at this
deploy's `/api/webhooks/helius`. Confirm it's off (send a throwaway
transaction to any other address first if unsure, and confirm no webhook
request reaches your logs).

## Step 3 — send the USDC transfer, then wait past the outage window

Send exactly `amountUsdc` of devnet USDC from `fromWalletAddress` to the
withdrawal's `treasuryAddress`. Note the transaction signature.

Wait ~10 minutes with the webhook still disabled (long enough to prove this
isn't a race — the sweep alone must do the work).

Confirm the withdrawal is still stuck (expected — no webhook delivery
happened):

```sql
select id, status, solana_tx_signature from withdrawals where id = '<id>';
-- Expected: status = 'pending_deposit', solana_tx_signature is null.
```

## Step 4 — trigger the sweep

Either wait for the next `*/5 * * * *` cron tick, or trigger it manually:

```bash
curl -s -X POST "$API_BASE_URL/api/internal/reconcile-tick" \
  -H "X-Cron-Secret: $CRON_SECRET" | jq .
```

## Step 5 — expected observation: the sweep found and replayed it

In the response JSON, `sweepMissedEvents.result.replayed` should contain
the transfer's signature:

```json
{
  "sweepMissedEvents": { "ok": true, "result": { "checked": <=50, "replayed": ["<the signature>"] } },
  ...
}
```

Function logs should show an `alert:true` line:
`[Reconcile] ALERT: replayed 1 missed signature(s): <signature>` — this is
page-worthy by design (a Helius delivery gap is real signal, even though
this pass safely recovers from it).

Confirm the withdrawal advanced through the same path a live webhook would
have taken:

```sql
select id, status, solana_tx_signature, monime_payout_id
  from withdrawals where id = '<id>';
-- Expected: solana_tx_signature = the sent transfer's signature,
-- status in ('processing', 'completed') (depending on how fast the Monime
-- payout + its own webhook complete), monime_payout_id set.
```

Confirm exactly one `withdrawal_receipt` journal was posted (no
double-booking from the replay path):

```sql
select count(*) from ledger_journals
 where resource_type = 'withdrawal' and resource_id = '<id>' and kind = 'withdrawal_receipt';
-- Expected: 1
```

## Step 6 — re-enable Helius and confirm no double-processing on redelivery

Re-enable the webhook in the Helius dashboard. If Helius retries/redelivers
the original event for the same signature (Helius's own redelivery policy —
not always guaranteed on a UI toggle; if it does not redeliver
automatically, use the dashboard's "resend"/"replay" action for that
delivery if available, or POST the same Enhanced-Webhook body manually with
the real static bearer to `/api/webhooks/helius` to simulate a late
redelivery):

Expected observation: `handleHeliusEvent` runs `findPendingByWalletAndAmount`
for `(fromWalletAddress, amountUsdc)` — the withdrawal is no longer
`pending_deposit` (the sweep already claimed it in Step 5), so no open match
is found. It then checks `hasProcessedSignature(signature)`, which is now
`true` (the signature is recorded on the withdrawal row) — the handler logs
`[Helius] transfer already processed via manual confirm, skipping` (the log
message's wording is written for the manual-confirm race; it fires
identically here — same code path, different original claimant) and takes
no further action. **No** second `unmatched_transfers` row, **no** second
ledger journal, **no** second Monime payout.

Verify:

```sql
select count(*) from unmatched_transfers where signature = '<the signature>';
-- Expected: 0

select count(*) from ledger_journals
 where resource_type = 'withdrawal' and resource_id = '<id>' and kind = 'withdrawal_receipt';
-- Expected: still 1 (unchanged from Step 5)
```

## Rollback

- Re-enable the Helius webhook if not already done in Step 6.
- No treasury/ledger cleanup needed if everything matched expected — this
  drill's whole point is that the system self-heals without operator
  intervention. If any check in Step 5/6 came back wrong, stop and treat it
  as a real finding — do not paper over it by manually fixing rows.

## Results (fill in after running)

| Field | Value |
|---|---|
| Date run | |
| Withdrawal id used | |
| Signature | |
| Outage duration (webhook disabled) | |
| Time from sweep trigger to `replayed` containing the signature | |
| Time from sweep trigger to withdrawal reaching `processing`/`completed` | |
| Redelivery method used in Step 6 (real Helius redelivery / manual replay) | |
| Double-processing observed? (must be N) | |
| Surprises / deviations from expected | |
