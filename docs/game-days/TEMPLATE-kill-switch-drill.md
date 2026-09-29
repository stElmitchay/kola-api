# Game day: kill switch drill

**TEMPLATE — run and rename with the date**
(`docs/game-days/<YYYY-MM-DD>-kill-switch-drill.md`)

## What this proves

`KOLA_PAUSE=1` (`src/middleware/kill-switch.js`) is the emergency stop for
every money-moving route. This drill proves it actually stops traffic (503,
not silently no-op), that Monime's webhook redelivers rather than being
dropped (the handler must never see `200` while paused), and that unpausing
recovers cleanly with no lost or duplicated events.

## Preconditions

- A staging/scratch deploy of this branch on Vercel (kill switch is
  read from `process.env.KOLA_PAUSE` on every request — no caching — but
  changing a Vercel env var still requires a redeploy or an env-group flip
  to take effect on already-running instances; local `vercel dev` picks up
  `.env` changes on restart).
- `CRON_SECRET` set (Step 2 checks `/internal/*` too).
- A seeded test application + active exchange rate.
- **Never run this against production** unless it IS a real incident this
  drill is deliberately rehearsing ahead of — this literally halts all
  money movement.

## Step 1 — pause

```bash
# Vercel: vercel env add KOLA_PAUSE production  (value "1"), then redeploy
#         or flip the env group per your deployment process.
# Local:  KOLA_PAUSE=1 in the .env the process loads, then restart.
```

## Step 2 — expected observation: every gated route 503s with Retry-After

The kill switch is mounted on `/v1/deposits/*`, `/v1/withdrawals/*`,
`/webhooks/*`, and `/internal/*` (see `api/index.js`) — NOT on
`/v1/wallets/*`, `/v1/public/*`, or `/v1/admin/*` (balance reads and admin
operations are deliberately left open during a pause).

```bash
curl -si -X POST "$API_BASE_URL/api/v1/deposits" \
  -H "Content-Type: application/json" -H "X-API-Key: $TEST_API_KEY" \
  -d '{"amount":50000,"currency":"SLE","paymentMethod":"ussd","phoneNumber":"+23276000333","walletAddress":"<a devnet wallet>"}'
# Expected: HTTP/1.1 503, Retry-After: 300,
# body {"error":{"code":"ServiceUnavailable","message":"Service temporarily paused for maintenance","request_id":"..."}}

curl -si -X POST "$API_BASE_URL/api/v1/withdrawals" \
  -H "Content-Type: application/json" -H "X-API-Key: $TEST_API_KEY" \
  -d '{"amountUsdc":500000,"phoneNumber":"+23276000333","providerCode":"m17","fromWalletAddress":"<a devnet wallet>"}'
# Expected: same 503 shape.

curl -si -X POST "$API_BASE_URL/api/internal/transfer-tick" -H "X-Cron-Secret: $CRON_SECRET"
curl -si -X POST "$API_BASE_URL/api/internal/reconcile-tick" -H "X-Cron-Secret: $CRON_SECRET"
# Expected: same 503 shape on both — a 503 to the cron invoker is harmless,
# it just retries next tick (no auth check even runs — killSwitch is
# mounted before the route handler).

# Confirm balance reads and public endpoints are UNAFFECTED (deliberately
# not gated):
curl -si "$API_BASE_URL/api/v1/wallets/<any address>/balance" -H "X-API-Key: $TEST_API_KEY"
curl -si "$API_BASE_URL/api/v1/public/health"
# Expected: normal 200s, not 503.
```

## Step 3 — Monime webhook redelivery (does not silently drop)

If you have a live Monime sandbox pointed at this staging deploy, trigger
any event that would hit `/api/webhooks/monime` (e.g. complete a real
sandbox USSD/checkout payment). Expected: Monime's delivery log shows a
`503` response for the attempt made while paused, and Monime's own retry
policy schedules a redelivery — check the dashboard's delivery/retry
history for that event.

If no live Monime sandbox is available for this run, simulate it instead by
POSTing a validly-signed webhook body while paused and confirming the 503,
then keep that exact same request (same body, same `Monime-Signature`
header — do not regenerate the signature, since it's a fixed-timestamp HMAC
and reuse is the point) ready to resend in Step 5:

```bash
BODY='{"event":{"id":"kill-switch-drill-<uuid>","name":"payment_code.completed"},"data":{"reference":"<a real pending deposit id>","amount":{"currency":"SLE","value":50000}}}'
SIG=$(node -e "
  const c = require('crypto');
  const ts = Math.floor(Date.now()/1000);
  const v1 = c.createHmac('sha256', process.env.MONIME_WEBHOOK_SECRET).update(\`\${ts}_\${process.argv[1]}\`).digest('base64');
  console.log(\`t=\${ts},v1=\${v1}\`);
" "$BODY")

curl -si -X POST "$API_BASE_URL/api/webhooks/monime" \
  -H "Content-Type: application/json" -H "Monime-Signature: $SIG" -d "$BODY"
# Expected: 503 (killSwitch runs before signature verification and before
# recordWebhookEvent — so no row is written to webhook_events yet; confirm:)
```

```sql
select count(*) from webhook_events where event_id = 'kill-switch-drill-<uuid>';
-- Expected: 0 — the event gate never ran while paused.
```

## Step 4 — unpause

```bash
# Reverse Step 1: remove/flip KOLA_PAUSE, redeploy/restart.
```

Confirm normal routes are back to 200/normal behavior with the same curl
commands from Step 2 (deposits/withdrawals should now succeed or fail on
their own normal validation, not 503).

## Step 5 — redeliver and confirm exactly one processed event

If Step 3 used a live Monime sandbox, wait for its automatic redelivery and
skip to the verification query below. Otherwise, resend the EXACT same
signed request captured in Step 3 (same signature header, same body — this
simulates Monime's redelivery of the same `event.id`):

```bash
curl -si -X POST "$API_BASE_URL/api/webhooks/monime" \
  -H "Content-Type: application/json" -H "Monime-Signature: $SIG" -d "$BODY"
# Expected: 200 {"received": true} (first successful delivery — the
# event gate is now open again).
```

Then resend it a SECOND time (simulating Monime's own duplicate-delivery
behavior, or a second real redelivery) to prove the exactly-once gate still
holds independent of the pause:

```bash
curl -si -X POST "$API_BASE_URL/api/webhooks/monime" \
  -H "Content-Type: application/json" -H "Monime-Signature: $SIG" -d "$BODY"
# Expected: 200 {"received": true, "duplicate": true}
```

Verify exactly one row landed:

```sql
select count(*) from webhook_events where event_id = 'kill-switch-drill-<uuid>';
-- Expected: 1
```

## Rollback

- Confirm `KOLA_PAUSE` is unset (or `"0"`/absent) in every environment
  touched by this drill before finishing — an accidentally-left-on kill
  switch is its own incident.
- If Step 3/5 used a real pending deposit, confirm its final state matches
  what the payload implied (e.g. `confirmed` if the amount matched) and
  clean up any drill-only rows from the scratch project.

## Results (fill in after running)

| Field | Value |
|---|---|
| Date run | |
| Environment | |
| All four gated routes 503'd with Retry-After during pause? (Y/N) | |
| Wallets/public routes stayed 200 during pause? (Y/N) | |
| `webhook_events` row count during pause for the drill event | |
| Redelivery method used (live Monime / manual resend) | |
| `webhook_events` row count after redelivery + duplicate resend | |
| Surprises / deviations from expected | |
