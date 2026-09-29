# Runbook: stuck withdrawal

## Symptoms

- A paged alert fires with the message `[Reconcile] ALERT: STUCK <id>
  table=withdrawals status=<received|processing> age_minutes=<n>` (logged
  at `logger.error({alert:true}, ...)` in `sweepStuckRows`,
  `src/routes/internal/reconcile-tick.js`) — a withdrawal has sat in
  `received` or `processing` longer than `STUCK_THRESHOLD_MINUTES` (default
  30) without reaching a terminal state.
- A user reports their USDC left their wallet but they never received the
  SLE payout.

`pending_deposit` rows past their `expires_at` are **not** paged by this
sweep (`listStaleInflight` in `src/repos/reconciliation.js` only watches
`withdrawals` in `received`/`processing`) — a user simply never sending the
on-chain transfer is expected, benign behavior, not stuck money. See
"Abandoned pending_deposit rows" at the bottom if that's what you're
chasing instead.

## First command

```sql
select id, status, amount_usdc, monime_payout_id, failure_reason,
       from_wallet_address, phone_number, solana_tx_signature, updated_at,
       extract(epoch from (now() - updated_at)) / 60 as age_minutes
  from withdrawals
 where status in ('received', 'processing')
   and updated_at < now() - interval '30 minutes'   -- match STUCK_THRESHOLD_MINUTES
 order by updated_at asc;
```

For one specific case, note its `id`, `status`, `monime_payout_id`, and
`solana_tx_signature` — every step below refers back to that row.

## Decision tree

### 1. `status = 'received'`, `monime_payout_id` is null

The on-chain receipt was verified and the `withdrawal_receipt` ledger
journal posted (`postWithdrawalReceipt`, called right before
`triggerPayoutForWithdrawal` in both `confirmWithdrawal` and
`handleHeliusEvent`), but the Monime payout call itself never completed or
was never attempted — most likely the process was killed between the CAS
that set `status='received'` and `createPayout` resolving (a serverless
function timeout/crash, not a Monime error — a Monime error would have
already moved the row to `failed` via `triggerPayoutForWithdrawal`'s catch).

Check whether Monime actually received the request despite the local crash
(the payout call carries `Idempotency-Key: <withdrawal_id>`, so even a
resend is safe — see step below):

```bash
# Search the Monime dashboard/API for a payout whose metadata.withdrawal_id
# matches this withdrawal's id.
curl -s "https://api.monime.io/v1/payouts?reference=<withdrawal id if searchable>" \
  -H "Authorization: Bearer $MONIME_ACCESS_TOKEN" -H "Monime-Space-Id: $MONIME_SPACE_ID"
```

- **No matching payout found on Monime's side**: safe to retry. Re-submit
  the SAME `solanaTxSignature` to `/:id/confirm` — but `confirmWithdrawal`'s
  `isPayoutRetry` fast path only triggers when `status === 'failed'`, so for
  a `received` row you must first move it to `failed` (recording no new
  facts, just unblocking the retry path) before retrying:

  ```sql
  update withdrawals
     set status = 'failed', failure_reason = 'Manual: retriggering stalled payout (never reached Monime)'
   where id = 'THE_WITHDRAWAL_ID' and status = 'received';
  ```

  Then:

  ```bash
  curl -s -X POST "$API_BASE_URL/api/v1/withdrawals/THE_WITHDRAWAL_ID/confirm" \
    -H "Content-Type: application/json" -H "X-API-Key: $ANY_VALID_API_KEY" \
    -d '{"solanaTxSignature": "THE_ROWS_SOLANA_TX_SIGNATURE"}'
  ```

- **A matching payout WAS found on Monime's side**: it landed despite the
  local crash. Do not call `createPayout` again — instead backfill the row
  directly so the next `payout.completed`/`payout.failed` webhook (or a
  manual poll of `getPayout`) finds a row to update:

  ```sql
  update withdrawals
     set status = 'processing', monime_payout_id = 'THE_MONIME_PAYOUT_ID', failure_reason = null
   where id = 'THE_WITHDRAWAL_ID' and status = 'received';
  ```

### 2. `status = 'processing'`, `monime_payout_id` set

The payout was successfully dispatched to Monime but no `payout.completed`
or `payout.failed` webhook has arrived — either Monime hasn't delivered it
yet, delivery failed silently (no C1-style sweep exists for Monime payout
webhooks — `sweepMissedEvents` only walks the Solana treasury ATA), or the
payout itself is stuck on Monime's side (recipient's mobile money account
issue, provider outage).

```bash
curl -s "https://api.monime.io/v1/payouts/<monime_payout_id>" \
  -H "Authorization: Bearer $MONIME_ACCESS_TOKEN" -H "Monime-Space-Id: $MONIME_SPACE_ID"
```

- **`status: "completed"` on Monime's side, but our row is still
  `processing`**: the webhook never arrived or was dropped. Backfill
  manually (mirrors exactly what `handlePayoutEvent`'s `payout.completed`
  branch does in `src/routes/webhooks/monime.js`):

  ```sql
  update withdrawals set status = 'completed' where id = 'THE_WITHDRAWAL_ID' and status = 'processing';
  ```

  Then post the ledger journal that branch also posts
  (`postWithdrawalPayout` — see `src/repos/ledger.js` for the exact entries
  if doing this by hand instead of re-triggering the webhook path).

- **`status: "failed"`/`"rejected"` on Monime's side, our row still
  `processing`**: backfill the failure so it surfaces to the user/operator
  instead of sitting silently:

  ```sql
  update withdrawals
     set status = 'failed', failure_reason = 'Monime payout failed (backfilled from Monime API): <reason from the API response>'
   where id = 'THE_WITHDRAWAL_ID' and status = 'processing';
  ```

- **Still `pending`/in-flight on Monime's side**: this is a genuine Monime-
  side delay, not a bug here. Re-check in a few minutes; if it persists
  beyond Monime's normal payout SLA, escalate to Monime support with the
  payout id.

## Verification query

```sql
select id, status, monime_payout_id, failure_reason, solana_tx_signature, updated_at
  from withdrawals where id = 'THE_WITHDRAWAL_ID';
-- Expected: status is a TERMINAL state (completed/failed), consistent with
-- whatever ground truth Monime's API reported.
```

If the row moved to `completed`, confirm the `withdrawal_payout` ledger leg
landed (companion to the `withdrawal_receipt` leg posted earlier):

```sql
select j.kind, e.account, a.code, e.direction, e.amount
  from ledger_journals j
  join ledger_entries e on e.journal_id = j.id
  join ledger_accounts a on a.id = e.account
 where j.resource_type = 'withdrawal' and j.resource_id = 'THE_WITHDRAWAL_ID'
 order by j.created_at;
-- Expected: withdrawal_receipt AND withdrawal_payout journals both present, both balanced.
```

Confirm the sweep no longer pages this row:

```bash
curl -s -X POST "$API_BASE_URL/api/internal/reconcile-tick" -H "X-Cron-Secret: $CRON_SECRET" | jq .sweepStuckRows
```

## Abandoned `pending_deposit` rows

Not paged by the reconcile sweep — a normal, expected outcome when a user
creates a withdrawal but never sends the USDC (or sends it after
`expires_at`). These rows simply age out of `findPendingByWalletAndAmount`'s
matching window (`gt('expires_at', now())`) and stop being eligible for
auto-confirm, but nothing proactively flips their `status` to `expired` —
that only happens if someone later calls `/:id/confirm` against them (which
hits the expiry check and does the CAS itself). If back-office reporting
needs these visibly marked `expired` rather than silently stale:

```sql
update withdrawals
   set status = 'expired'
 where status = 'pending_deposit' and expires_at < now();
```

Safe to run any time — it only touches rows already past their matching
window, and `findPendingByWalletAndAmount` was already ignoring them.
