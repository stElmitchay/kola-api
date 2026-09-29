# Runbook: kill switch (emergency pause)

## Symptoms — when to use this

Use the kill switch when money is actively at risk faster than a targeted
fix can land: a suspected treasury key compromise, a reconciliation
mismatch (`proveBalance.result.mismatch = true` from `/internal/reconcile-
tick`) that isn't yet understood, a Monime or Helius integration behaving
unexpectedly in a way that risks a double-pay, or any incident where the
right first move is "stop all money movement, then investigate." This is
not for a single stuck row — see `docs/runbooks/stuck-withdrawal.md` or
`docs/runbooks/monime-outage.md` for those; this is the last resort that
stops everything.

## First command

```bash
# Vercel:
vercel env add KOLA_PAUSE production   # value: "1"
vercel env add KOLA_PAUSE preview       # value: "1", if preview also serves traffic
vercel --prod                           # redeploy so the new env value is live
```

`KOLA_PAUSE=1` is read live on every request (`src/middleware/
kill-switch.js`, no caching) — but a running serverless instance only sees
an env var change on its next cold start, so a redeploy (or an equivalent
env-group flip your deployment process supports) is required to guarantee
it takes effect immediately rather than whenever instances happen to recycle.

## Decision tree

### 1. What's actually gated?

`killSwitch` is mounted on `/v1/deposits/*`, `/v1/withdrawals/*`,
`/webhooks/*`, and `/internal/*` (see `api/index.js`). It returns `503` with
`Retry-After: 300` and the standard error envelope
(`{"error":{"code":"ServiceUnavailable","message":"Service temporarily
paused for maintenance","request_id":"..."}}`).

**Deliberately NOT gated**: `/v1/wallets/*` (balance reads), `/v1/public/*`,
and `/v1/admin/*`. Balance reads are read-only and harmless during a pause;
admin routes stay open because you need `PUT /v1/admin/exchange-rates`,
`GET /v1/admin/unmatched-transfers`, and API key management to keep working
WHILE the money paths are paused — that's how you investigate and prepare
the fix during the incident.

### 2. What happens to in-flight traffic?

- **Webhooks** (Monime, Helius): return 503 instead of 200. Both vendors
  retry failed deliveries on their own schedule — nothing is dropped, it's
  just delayed until unpause. No `webhook_events` row is written for a
  request that hits the kill switch (`recordWebhookEvent` never runs — the
  gate is upstream of it), so there's no phantom "processed" state to clean
  up.
- **Cron workers** (`/internal/transfer-tick`, `/internal/reconcile-tick`):
  also 503. Harmless — the next cron tick just retries. Note this also
  pauses `reconcile-tick`'s own alerting passes (`proveBalance`,
  `sweepStuckRows`) — if the incident that triggered the pause is itself
  something `reconcile-tick` would have caught, you lose that signal while
  paused. Keep manually running the balance-proof query from
  `docs/runbooks/monime-outage.md`/`unmatched-transfer.md` by hand during
  an extended pause if that matters to your incident.
- **In-flight requests already past the kill switch middleware** when it
  flips on are NOT interrupted — they run to completion. The pause only
  affects requests that haven't reached the middleware yet.

### 3. Communicate before pausing (when there's time)

If the incident allows a few minutes' warning, tell integrating partners
before pausing — a `503` on `POST /v1/deposits`/`POST /v1/withdrawals` for
an unannounced maintenance window looks like an outage on their side too.

### 4. When to unpause

Only after the underlying issue is either fixed or well enough understood
that resuming traffic won't recreate it. For a reconciliation mismatch
specifically, do not unpause until you can explain the mismatch — see
`docs/runbooks/unmatched-transfer.md` and the balance-proof query in
`docs/runbooks/monime-outage.md`.

```bash
vercel env rm KOLA_PAUSE production
vercel env rm KOLA_PAUSE preview        # if it was set there too
vercel --prod
```

## Verification query

**While paused**, confirm the gate is actually active (do this immediately
after pausing, not just trust the deploy log):

```bash
curl -si -X POST "$API_BASE_URL/api/v1/deposits" \
  -H "Content-Type: application/json" -H "X-API-Key: $ANY_VALID_API_KEY" -d '{}'
# Expected: HTTP/1.1 503, Retry-After: 300, ServiceUnavailable envelope —
# even with an empty/invalid body, since killSwitch runs before schema
# validation.
```

**After unpausing**, confirm normal traffic resumed and nothing was lost
during the pause:

```bash
curl -si -X POST "$API_BASE_URL/api/v1/deposits" \
  -H "Content-Type: application/json" -H "X-API-Key: $ANY_VALID_API_KEY" -d '{}'
# Expected: back to normal validation errors (400), not 503.
```

```sql
-- Any webhook deliveries that arrived during the pause window should show
-- up here now, timestamped AFTER the unpause (their FIRST successful
-- delivery), not lost:
select provider, event_id, event_name, received_at
  from webhook_events
 where received_at > '<unpause timestamp>'
 order by received_at asc
 limit 50;
```

```bash
curl -s -X POST "$API_BASE_URL/api/internal/reconcile-tick" -H "X-Cron-Secret: $CRON_SECRET" | jq .
# Expected: proveBalance.result.mismatch = false, sweepMissedEvents.result.replayed
# reflects anything genuinely missed during the pause (should be small/empty
# if vendors redelivered normally), sweepStuckRows shows nothing new
# specifically attributable to the pause window itself.
```
