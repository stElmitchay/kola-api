# Runbook: Monime outage

## Symptoms

- A spike of `502` responses with envelope
  `{"error":{"code":"MonimeError","message":"Internal error","request_id":"..."}}`
  from `POST /v1/deposits` (checkout session / payment code creation) and/or
  `POST /v1/withdrawals/:id/confirm` (payout dispatch).
- Function logs show `[Monime] request failed` lines
  (`src/utils/monime.js`'s `monimeRequest`) with `status` in the 5xx range,
  or `Monime request timed out after <n>ms — outcome unknown, do not assume
  failure` (a distinct failure mode — see step 2).
- Withdrawals piling up in `status = 'failed'` with `failure_reason`
  starting `Monime payout failed: ...`.
- New deposits stuck at `status = 'pending'` with no `ussdCode`/
  `redirectUrl` ever surfaced to the user (see "The idempotency-key trap on
  deposit creation" below — this is the dangerous one).

## First command

Scope the blast radius — how many withdrawals/deposits are affected and
since when:

```sql
select count(*), min(updated_at), max(updated_at)
  from withdrawals
 where status = 'failed' and failure_reason like 'Monime payout failed:%'
   and updated_at > now() - interval '1 hour';

select count(*), min(created_at), max(created_at)
  from deposits
 where status = 'pending' and monime_resource_id is null
   and created_at > now() - interval '1 hour';
-- deposits stuck with no monime_resource_id at all means initiateDeposit's
-- createCheckoutSession/createPaymentCode call never completed.
```

Check Monime's own status page / dashboard for an acknowledged incident
before assuming the failure is ours.

## Decision tree

### 1. Is it a hard failure (5xx/connection error) or a timeout?

`monimeRequest` distinguishes these on purpose (`src/utils/monime.js`): a
non-2xx response is a definite failure — the row is safe to mark `failed`
and retry. A **timeout** (`err.name === 'TimeoutError'`) means the outcome
is genuinely unknown — Monime may have processed the request before the
timeout fired. Grep the function logs for the exact error message on the
affected rows' timestamps to tell which one happened; if it was a timeout,
treat every affected payout as "verify before retrying" (see the payout
lookup in `docs/runbooks/stuck-withdrawal.md`, section "`status =
'received'`, `monime_payout_id` is null" or "`status = 'processing'`" as
applicable) rather than blindly resubmitting.

### 2. Is this the payout leg (withdrawals) or the collection leg (deposits)?

**Payouts (withdrawals)**: no special action needed at the platform level —
`triggerPayoutForWithdrawal` already catches the failure and lands the row
on `status = 'failed'` with the reason recorded, so nothing is stuck in an
ambiguous state on our side (the money already left the user's wallet and
is verified in `treasury_usdc`, so failing safe here means the payout can
be retried once Monime recovers, not that funds are lost). Once Monime
recovers, work the backlog via `docs/runbooks/stuck-withdrawal.md`'s retry
path (re-submit the same `solanaTxSignature` to `/:id/confirm`).

**Deposit creation (collections)**: this is the more dangerous leg. Walk
through `initiateDeposit` (`src/routes/deposits/deposits.js`): the deposit
ROW is inserted into the database BEFORE `createCheckoutSession`/
`createPaymentCode` is called. If that Monime call then fails, the deposit
row exists in `pending` with no `monime_resource_id` and — critically — the
user was never shown a USSD code or checkout URL, because the route handler
threw before returning a response.

#### The idempotency-key trap on deposit creation

If the client sent an `Idempotency-Key` header on that `POST /v1/deposits`
call, the request/response is gated by `src/middleware/idempotency.js`. On
a Monime failure the route still returns a response (the 502 from
`errorHandler`), and the idempotency middleware stores THAT 502 under the
key regardless of status code. **If the client retries with the SAME key,
they get the cached 502 back forever — the handler never runs again, so no
new attempt at Monime is ever made, and the orphaned `pending` deposit row
is never revisited.** This is why the client contract (documented in
kola-docs) is: reuse a key only to disambiguate whether an earlier request
was received; use a FRESH key for a deliberate new attempt. If you're
fielding a partner's "my deposit never got a USSD code" ticket during this
outage, the first question is whether their retry logic reused the same
`Idempotency-Key` — if so, that explains the client-visible hang even after
Monime recovers, and the fix on their side is a new key, not a raw retry.

On the operator side, find every deposit orphaned this way and let them be
cleanly abandoned (they will separately expire from a user's perspective;
there's no on-chain funds risk since no USDC was ever quoted-and-sent for a
row that never got a payment link):

```sql
select id, application, phone_number, amount_sle, created_at
  from deposits
 where status = 'pending' and monime_resource_id is null
   and created_at < now() - interval '15 minutes';
```

Advise affected partners to have their users retry deposit creation
end-to-end (a brand-new `POST /v1/deposits` call, new `Idempotency-Key` if
they use one) once Monime is confirmed recovered — do not try to
"resurrect" an orphaned row by manually calling Monime for it, since the
row's `amount_sle`/exchange rate may now be stale.

### 3. Is the outage prolonged (minutes) or extended (the money paths need to pause)?

If Monime is down long enough that the failed-payout and orphaned-deposit
backlogs are growing faster than they can be worked, or if partners are
being told to stop sending traffic, consider `docs/runbooks/kill-switch.md`
— pausing deposits/withdrawals at the API layer stops new orphans from
being created while you work the existing backlog, though note the kill
switch does NOT stop in-flight retries against Monime itself (it only gates
this API's own routes).

## Verification query

Confirm the backlog is draining once Monime is confirmed recovered:

```sql
-- Should trend to 0 as the stuck-withdrawal runbook's retry path is worked.
select count(*) from withdrawals
 where status = 'failed' and failure_reason like 'Monime payout failed:%'
   and updated_at > now() - interval '1 hour';

-- New deposits succeeding again (have a monime_resource_id shortly after creation):
select count(*) from deposits
 where status = 'pending' and monime_resource_id is null
   and created_at > now() - interval '5 minutes';
-- Expected: 0 once Monime is confirmed healthy and no client retry storms remain.
```

Confirm outbound calls are succeeding again directly:

```bash
curl -s "https://api.monime.io/v1/momos?country=SL" \
  -H "Authorization: Bearer $MONIME_ACCESS_TOKEN" -H "Monime-Space-Id: $MONIME_SPACE_ID"
-- Expected: 200 with a provider list, not a 5xx.
```
