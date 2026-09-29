# Runbook: unmatched inbound USDC transfer (F11 suspense)

## Symptoms

- A paged alert fires with the message `[Helius] UNMATCHED transfer booked
  to suspense sig=<signature>` (logged at `console.error` in
  `src/routes/webhooks/helius-handler.js`, `handleHeliusEvent`).
- The treasury's on-chain USDC balance is higher than the sum of open
  withdrawal obligations would predict.
- `unmatched_transfers` has one or more rows with `status = 'open'`.

USDC landed on the treasury wallet that didn't match any open
`pending_deposit` withdrawal by `(from_wallet_address, amount_usdc)` — most
commonly a user sending from a different wallet than the one they
registered for the withdrawal, sending the wrong amount, sending after
their withdrawal already expired, or a stray/unsolicited transfer. The
webhook handler booked it to the `suspense_usdc` ledger account (via
`post_journal('suspense_in', ...)`) instead of silently dropping it.

## First command

Pull every open case, newest first:

```sql
select id, signature, from_wallet, amount_usdc, reason, created_at
  from unmatched_transfers
 where status = 'open'
 order by created_at desc;
```

Or via the admin API:

```bash
curl -s "$API_BASE_URL/api/v1/admin/unmatched-transfers?status=open" \
  -H "X-Admin-Key: $ADMIN_KEY_SECRET"   # one operator's secret half of an ADMIN_KEYS "name:secret" pair
```

For one specific case, note its `id`, `signature`, `from_wallet`, and
`amount_usdc` — every step below refers back to that row.

## Decision tree

### 1. Identify the sender

```sql
-- Any withdrawal (any status) ever created for this wallet — the sender
-- likely intended to settle one of these.
select id, status, amount_usdc, from_wallet_address, expires_at, created_at
  from withdrawals
 where from_wallet_address = 'SENDER_WALLET_FROM_THE_ROW_ABOVE'
 order by created_at desc
 limit 20;
```

If a phone number surfaces from a withdrawal row on that wallet, that's
the contact channel — reach out to confirm intent before refunding.

### 2. Near-match search

Look for an open withdrawal the amount is close to (off-by-fee, off-by-one
exchange rate, or the withdrawal expired minutes before the transfer
landed):

```sql
select id, status, amount_usdc, from_wallet_address, phone_number, expires_at
  from withdrawals
 where status in ('pending_deposit', 'expired')
   and amount_usdc between 4800000 and 5200000   -- +/-4% band around the unmatched amount (5,000,000 example)
 order by created_at desc;
```

Replace the `between` band with ±4% (or whatever tolerance is
operationally sane) of the unmatched row's `amount_usdc`. If a clear match
turns up:

```sql
update withdrawals
   set status = 'received', solana_tx_signature = 'THE_UNMATCHED_ROWS_SIGNATURE'
 where id = 'THE_MATCHING_WITHDRAWAL_ID'
   and status = 'pending_deposit';
```

Then trigger the normal payout path for that withdrawal (the same code
path `handleHeliusEvent` would have taken —
`triggerPayoutForWithdrawal(withdrawal)` from
`src/routes/withdrawals/withdrawals.js`, invoked via a one-off script or
the existing `/withdrawals/:id/confirm` admin/manual path with that
signature), then mark the suspense row `matched` (skip the refund + release
steps below — no reversing journal is needed since the funds correctly
belong to `treasury_usdc`, not to suspense; `suspense_usdc` still needs a
reversing entry since the original `suspense_in` credited it):

```sql
update unmatched_transfers
   set status = 'matched',
       resolution_note = 'Matched to withdrawal THE_MATCHING_WITHDRAWAL_ID after near-match review',
       resolved_at = now()
 where id = 'THE_UNMATCHED_ROWS_ID';
```

Then post the reversing journal exactly as in "Verification" below
(`suspense_release`), since `suspense_in` already moved the money into
`suspense_usdc` — it must be moved back out regardless of whether the
resolution is a match or a refund.

### 3. No match found — refund on-chain from treasury

Ops-signed, **devnet-rehearsed first** (never test a new refund script
against mainnet treasury funds). Rehearse against devnet with the
`.env.devnet` `USDC_MINT` + `HELIUS_URL` values and a devnet-funded
treasury keypair before touching mainnet.

```bash
node scripts/refund-unmatched-transfer.mjs \
  --to SENDER_WALLET_FROM_THE_ROW_ABOVE \
  --amount-usdc 5000000 \
  --memo "Refund of unmatched transfer THE_UNMATCHED_ROWS_SIGNATURE"
```

(This is a one-off ops script, not part of the app — build it from the
same signed-transfer helpers `src/utils/solana.js` already exposes for
outbound treasury transfers, e.g. the same primitives
`buildSignedUsdcTransfer` in the transfer-jobs worker uses, run manually
against `SENDER_WALLET_FROM_THE_ROW_ABOVE` for `amount_usdc`. Do not add
this to the app's own webhook/cron paths — it is a manual, ops-triggered
action.)

Confirm the refund lands (devnet or mainnet explorer):

```
https://explorer.solana.com/tx/REFUND_TX_SIGNATURE?cluster=devnet
```

### 4. Mark refunded

```sql
update unmatched_transfers
   set status = 'refunded',
       resolution_note = 'Refunded on-chain, tx REFUND_TX_SIGNATURE',
       resolved_at = now()
 where id = 'THE_UNMATCHED_ROWS_ID';
```

`resolution_note` must include the refund's on-chain signature — that's
the audit trail tying the suspense entry back to the outbound transfer
that cleared it.

### 5. Post the `suspense_release` journal (reverses the original entries)

Whether the case resolved as `matched` or `refunded`, the original
`suspense_in` journal moved `amount_usdc` from `treasury_usdc` into
`suspense_usdc`. Reverse it (same amount, entries flipped) so
`suspense_usdc` returns to zero for this case:

```sql
select post_journal(
  'suspense_release',
  'unmatched_transfer',
  'THE_UNMATCHED_ROWS_ID'::uuid,
  'suspense_release:THE_UNMATCHED_ROWS_SIGNATURE',
  '[
    {"account": "suspense_usdc", "direction": "debit",  "amount": "5000000"},
    {"account": "treasury_usdc", "direction": "credit", "amount": "5000000"}
  ]'::jsonb
);
```

Substitute the real `id`, `signature`, and `amount_usdc` from the
unmatched row. `post_journal` is idempotent on the key
(`suspense_release:<signature>`), so re-running this after a mistake is
safe — it no-ops on the second call rather than double-reversing.

Note the direction split by resolution:
- **refunded**: the USDC actually left the treasury wallet on-chain, so
  this journal's `treasury_usdc` credit brings the ledger back in line
  with the lower on-chain balance.
- **matched**: the USDC stays on the treasury wallet (it settles the
  matched withdrawal), so this journal's `treasury_usdc` credit here is
  paired with the `withdrawal_receipt` journal's `treasury_usdc` debit
  posted when the matching withdrawal was claimed in step 2 above — net
  effect: one debit, one credit, treasury unchanged, suspense cleared.

## Verification query

Confirm the case is fully closed — no open `suspense_usdc` balance remains
attributable to it, and the row is resolved:

```sql
-- 1. The unmatched row itself is resolved, not open.
select id, status, resolution_note, resolved_at
  from unmatched_transfers
 where id = 'THE_UNMATCHED_ROWS_ID';
-- Expected: status in ('matched','refunded'), resolution_note set, resolved_at not null.

-- 2. suspense_usdc balance is back to whatever it was before this case
--    (zero, if this was the only open suspense case).
select
  sum(case when e.direction = 'debit' then -e.amount else e.amount end)
    as suspense_usdc_balance_minor
  from ledger_entries e
  join ledger_accounts a on a.id = e.account
 where a.code = 'suspense_usdc';
-- Expected: 0, assuming no other unmatched cases are still open. If other
-- cases remain open, this should equal the sum of their amount_usdc.

-- 3. Both journals for this case exist and balance.
select j.kind, e.account, a.code, e.direction, e.amount
  from ledger_journals j
  join ledger_entries e on e.journal_id = j.id
  join ledger_accounts a on a.id = e.account
 where j.idempotency_key in (
   'suspense_in:THE_UNMATCHED_ROWS_SIGNATURE',
   'suspense_release:THE_UNMATCHED_ROWS_SIGNATURE'
 )
 order by j.created_at;
-- Expected: 4 rows total (2 entries per journal x 2 journals), suspense_in
-- debiting treasury_usdc/crediting suspense_usdc, suspense_release doing
-- the exact reverse.
```
