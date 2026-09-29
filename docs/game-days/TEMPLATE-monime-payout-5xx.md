# Game day: Monime 5xx on payouts

**TEMPLATE — run and rename with the date**
(`docs/game-days/<YYYY-MM-DD>-monime-payout-5xx.md`)

## What this proves

`createPayout` (`src/utils/monime.js`) is called from
`triggerPayoutForWithdrawal` (`src/routes/withdrawals/withdrawals.js`) — first
automatically when Helius (or a manual `/:id/confirm`) advances a withdrawal
to `received`, and again on the operator-driven retry path. This drill proves:

1. A Monime 5xx during a payout attempt does not corrupt the withdrawal row
   — it lands cleanly on `status = 'failed'` with a `failure_reason`.
2. The retry path (`POST /:id/confirm` with the same `solanaTxSignature`,
   `isPayoutRetry` in `initiateWithdrawal`/`confirmWithdrawal`) pays out
   **exactly once** when Monime recovers — never twice.
3. `MONIME_BASE_URL` (added in this task so this drill is runnable at all —
   `src/utils/monime.js`'s `monimeBaseUrl()`, live-read, default unchanged
   `https://api.monime.io`) actually redirects outbound Monime calls.

## Preconditions

- A local or staging deploy of this branch, pointed at a **scratch/devnet**
  Supabase project and devnet Solana config (`USDC_MINT` + `HELIUS_URL`
  devnet values, `.env.devnet`) — never run this against production
  treasury funds or the production database.
- `npm run lint && npm test` green on this branch first (confirms
  `monimeBaseUrl()` itself is not the thing that's broken).
- A funded devnet treasury keypair (`TREASURY_SECRET_KEY`) and at least one
  seeded `auth_api_keys` row + active exchange rate for the test
  application (see `docs/testing.md` → `seedApplication` for the shape, or
  use the admin API against the scratch project).
- The API process you're testing against must read `MONIME_BASE_URL` from
  its own env — for local `vercel dev` / `npm start`, put it in the `.env`
  file that process loads; for a staging deploy, set it in that
  environment's Vercel env vars and redeploy before starting.

## Step 1 — start the local 500 server

```bash
node -e 'require("http").createServer((q,s)=>{s.writeHead(500);s.end()}).listen(9999)'
```

Leave this running in its own terminal. It answers every request — any
method, any path — with a bare `500` and an empty body, which is enough to
make `monimeRequest` (`src/utils/monime.js`) hit its `!response.ok` branch
and throw a `MonimeError`.

## Step 2 — point outbound Monime calls at it

In the `.env` the API process under test loads:

```bash
MONIME_BASE_URL="http://127.0.0.1:9999"
```

Restart/redeploy so the process picks it up (`envStr` is live-read on every
call, but the process still needs the var present in its own environment).

Confirm the override took: `__tests__/utils/monime-base-url.test.js` already
pins that `monimeBaseUrl()` returns the override when set — no need to
re-derive that here, just confirm your process actually has the var (log it
once at startup, or check `vercel env ls` / the shell that launched it).

## Step 3 — create and fund a withdrawal on devnet

```bash
# 1. Create the withdrawal (Monime is not called at creation time — only at
#    payout time — so this step succeeds regardless of MONIME_BASE_URL).
curl -s -X POST "$API_BASE_URL/api/v1/withdrawals" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $TEST_API_KEY" \
  -d '{
    "amountUsdc": 500000,
    "phoneNumber": "+23276000111",
    "providerCode": "m17",
    "fromWalletAddress": "<a devnet wallet you control>"
  }'
# Note the returned `id` and `treasuryAddress`.

# 2. Send exactly amountUsdc of devnet USDC from fromWalletAddress to
#    treasuryAddress, then note the transaction signature.

# 3. Confirm it — this is what fires the payout attempt:
curl -s -X POST "$API_BASE_URL/api/v1/withdrawals/<id>/confirm" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $TEST_API_KEY" \
  -d '{"solanaTxSignature": "<the devnet tx signature>"}'
```

## Step 4 — expected observation: payout fails cleanly

`confirmWithdrawal` verifies the on-chain transfer (real devnet RPC, unaffected
by `MONIME_BASE_URL`), advances `pending_deposit → received`, posts the
`withdrawal_receipt` ledger journal, then calls `triggerPayoutForWithdrawal`
→ `createPayout` → `monimeRequest('POST', '/v1/payouts', ...)` against
`http://127.0.0.1:9999`, which answers `500`.

Expected:
- The `/confirm` response is `502` with the envelope
  `{"error":{"code":"MonimeError","message":"Internal error","request_id":"..."}}`
  (the 500-server's body is opaque, so `monimeRequest`'s detail extraction
  falls through to `JSON.stringify(data)` or similar — client message is
  generic per `errorHandler`'s `isServerError` rule; the real detail is only
  in the server log line).
- The local 500-server's terminal shows one request landed (confirms the
  override actually routed the call there).
- SQL check:

  ```sql
  select id, status, failure_reason, solana_tx_signature, monime_payout_id
    from withdrawals where id = '<id>';
  ```

  Expected: `status = 'failed'`, `failure_reason` starts with
  `Monime payout failed: Monime API error 500: ...`,
  `solana_tx_signature` is set (the on-chain leg already succeeded — see
  `triggerPayoutForWithdrawal`'s catch, which only touches `status` and
  `failure_reason`), `monime_payout_id` is still `null`.
- Ledger check — the `withdrawal_receipt` journal already posted in step 3
  should NOT be reversed (the payout failure is a Monime-side failure, not a
  reason to unwind the verified on-chain receipt):

  ```sql
  select j.kind, e.account, a.code, e.direction, e.amount
    from ledger_journals j
    join ledger_entries e on e.journal_id = j.id
    join ledger_accounts a on a.id = e.account
   where j.resource_type = 'withdrawal' and j.resource_id = '<id>';
  ```

  Expected: one `withdrawal_receipt` journal, balanced.

## Step 5 — restore service and retry

```bash
# Kill the local 500 server (Ctrl-C), then unset/remove MONIME_BASE_URL
# from the API process's env (or point it at a working Monime sandbox) and
# restart/redeploy so the process picks up the real base URL again.
```

Re-submit the SAME signature to `/confirm` — this is the payout retry path
(`isPayoutRetry` in `confirmWithdrawal`: `status === 'failed'` AND
`solana_tx_signature` matches AND `monime_payout_id` is null):

```bash
curl -s -X POST "$API_BASE_URL/api/v1/withdrawals/<id>/confirm" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $TEST_API_KEY" \
  -d '{"solanaTxSignature": "<the SAME devnet tx signature>"}'
```

Expected observation: on-chain verification is SKIPPED on this path (already
proven in step 3 — see `confirmWithdrawal`'s `if (!isPayoutRetry)` guard), and
`triggerPayoutForWithdrawal` calls `createPayout` again — now against the
real base URL. Response is `200` with `status: "processing"` and a populated
`monimePayoutId`.

## Step 6 — verify exactly-once payout, not a double-pay

`createPayout` passes `params.withdrawalId` as the Monime `Idempotency-Key`
on every call for that withdrawal (see `src/utils/monime.js`'s
`createPayout` → `monimeRequest(..., params.withdrawalId)`) — this is the
mechanism that makes it safe to call twice for the same withdrawal even
without the local-side retry gating: Monime itself dedupes on that key.

Verify:

```sql
select id, status, monime_payout_id, failure_reason from withdrawals where id = '<id>';
-- Expected: status='processing' (or 'completed'/'failed' once the
-- payout.completed/payout.failed webhook lands), monime_payout_id set,
-- failure_reason still the OLD message from step 4 until overwritten —
-- triggerPayoutForWithdrawal only clears it on success (see the
-- `failure_reason: null` in the CAS update).
```

On the Monime dashboard (or sandbox equivalent), confirm exactly ONE payout
record exists for this withdrawal (search by the `withdrawal_id` metadata
field set in `createPayout`'s `metadata`) — not two.

## Rollback

- Kill the local 500-server process if still running.
- Remove `MONIME_BASE_URL` from every environment it was set in for this
  drill (leave it unset in production — see `.env.example`).
- If run against a scratch/devnet project, no production rollback is
  needed. If any step was accidentally run against production, immediately
  follow `docs/runbooks/monime-outage.md`'s decision tree from the "payout
  landed in `failed`" branch.

## Results (fill in after running)

| Field | Value |
|---|---|
| Date run | |
| Environment (scratch project / devnet config) | |
| Withdrawal id used | |
| Time from Step 2 (override set) to Step 4 observation (`failed` confirmed) | |
| Time from Step 5 (retry) to `processing`/`monimePayoutId` set | |
| Exactly one Monime payout record confirmed? (Y/N + evidence) | |
| Surprises / deviations from expected | |
