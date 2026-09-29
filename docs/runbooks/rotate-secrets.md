# Runbook: rotate secrets

## Symptoms — when to rotate

- A suspected or confirmed credential compromise (leaked in a log, a
  screenshot, a committed file, a former operator's laptop).
- Routine rotation per your own security policy.
- Offboarding an operator who held a named `ADMIN_KEYS` secret.
- Closing out `docs/incidents/2026-09-open-db-review.md`'s credential
  rotation table (Supabase JWT secret, `ADMIN_SECRET_KEY`, Monime access
  token) — required once, before launch, independent of any new incident.

## First command

Identify exactly which secret(s) are affected before touching anything —
rotating the wrong one wastes the downtime window this causes, and some of
these (`TREASURY_SECRET_KEY`, `API_KEY_SALT`) are expensive to rotate.
Check `.env.example` for the full inventory and what each one gates.

## Decision tree — by secret

### `ADMIN_KEYS` (named per-operator admin keys, C2)

The safe, frequent-rotation case — one operator's key can be replaced
without affecting anyone else's, because `ADMIN_KEYS` is a comma-separated
list of `name:secret` pairs (`src/middleware/admin-auth.js`).

1. Generate a new long random secret for the operator (same method as
   before — not a password, a long random string).
2. Add the NEW `name:secret` pair to `ADMIN_KEYS` in Vercel (all
   environments) alongside the existing entries — do not remove the old
   pair yet:
   ```
   ADMIN_KEYS="mitchel:OLD_SECRET,ops2:another,mitchel-new:NEW_SECRET"
   ```
   (Two entries for the same person during the handoff window is fine —
   `parseAdminKeys` just builds a list of candidates; there's no uniqueness
   constraint on `name`.)
3. Give the operator the new key, confirm they can authenticate:
   ```bash
   curl -s "$API_BASE_URL/api/v1/admin/api-keys" -H "X-Admin-Key: NEW_SECRET"
   # Expected: 200, not 401.
   ```
4. Remove the OLD `name:secret` pair from `ADMIN_KEYS`, redeploy.
5. Confirm the old key is now rejected:
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' "$API_BASE_URL/api/v1/admin/api-keys" -H "X-Admin-Key: OLD_SECRET"
   # Expected: 401.
   ```

### `ADMIN_SECRET_KEY` (legacy fallback, deprecated)

Every request using this lands in `audit_log` as actor `'legacy'` — if it's
still set, find out who/what is still using it before rotating, since
you can't tell which operator to notify:

```sql
select actor, action, resource_type, created_at
  from audit_log where actor = 'legacy'
 order by created_at desc limit 20;
```

If nothing has used it recently, the better fix is removing it entirely
(migrate whatever automation still references it onto a named `ADMIN_KEYS`
pair first) rather than rotating it. If it must stay temporarily, rotate it
the same way as any other Vercel env var (set new value, redeploy, confirm
old value 401s) — but treat this as a signal to finish the migration off of
it.

### Supabase JWT secret (invalidates anon + service-role keys)

Dashboard → Settings → API → rotate. This immediately invalidates the
CURRENT `SUPABASE_SERVICE_ROLE_KEY` this API authenticates with — rotating
it without immediately updating Vercel env is a self-inflicted outage.

1. **Before rotating**: confirm you can update Vercel env and redeploy
   immediately after — do this during a low-traffic window if possible, and
   consider `docs/runbooks/kill-switch.md` first if the rotation is urgent
   enough that a brief pause is preferable to a possible gap.
2. Rotate in the Supabase dashboard.
3. Immediately update `SUPABASE_SERVICE_ROLE_KEY` in Vercel (all
   environments) with the new key and redeploy:
   ```bash
   vercel env rm SUPABASE_SERVICE_ROLE_KEY production
   vercel env add SUPABASE_SERVICE_ROLE_KEY production
   vercel --prod
   ```
4. Confirm the API works again:
   ```bash
   curl -s "$API_BASE_URL/api/v1/public/health"
   curl -s "$API_BASE_URL/api/v1/deposits" -H "X-API-Key: $ANY_VALID_API_KEY"
   ```
5. `SUPABASE_ANON_KEY` should not be configured anywhere this API runs
   (Task A1) — confirm it wasn't reintroduced as a side effect:
   ```bash
   vercel env ls production | grep SUPABASE_ANON_KEY
   # Expected: no output.
   ```

### Monime access token

Request a new token via Monime (dashboard or account manager). Set
`MONIME_ACCESS_TOKEN` in Vercel, redeploy, confirm outbound calls succeed:

```bash
curl -s "https://api.monime.io/v1/momos?country=SL" \
  -H "Authorization: Bearer $NEW_TOKEN" -H "Monime-Space-Id: $MONIME_SPACE_ID"
# Expected: 200 with a provider list.
```

The old token typically remains valid until Monime explicitly revokes it —
confirm with Monime support whether the old token should be explicitly
revoked as part of this rotation (compromise) or simply left to expire
(routine rotation).

### `MONIME_WEBHOOK_SECRET`

Coordinate with Monime — the webhook secret must be changed on BOTH sides
in the same window, or every webhook delivery in between fails signature
verification (`verifyWebhookSignature` in `src/utils/monime.js`) and gets
rejected with `401`. Monime redelivers failed webhooks on their own
schedule, so a short mismatch window self-heals once both sides agree, but
minimize it:

1. Generate/obtain the new secret from Monime without yet activating it on
   their side (if Monime's dashboard supports a "next secret" concept —
   otherwise this has to be a coordinated instant flip).
2. Set `MONIME_WEBHOOK_SECRET` in Vercel, redeploy.
3. Confirm with Monime the new secret is active on their side.
4. Send a test event (or wait for the next real one) and confirm `200`, not
   `401`, in the function logs.

### `HELIUS_WEBHOOK_AUTH_HEADER`

1. Update the webhook's configured auth header value in the Helius
   dashboard.
2. Set the SAME new value for `HELIUS_WEBHOOK_AUTH_HEADER` in Vercel,
   redeploy.
3. These two must change together — a mismatch means every Helius
   delivery gets `401` from `verifyHeliusAuth` (`src/utils/helius.js`)
   until both sides agree. Withdrawals relying on auto-confirm will fall
   back to the `sweepMissedEvents` reconcile pass (5-minute cadence) during
   any gap, so a brief mismatch is not data-lossy, just slower.

### `TREASURY_SECRET_KEY` (highest-impact rotation — plan this separately)

This is the Solana keypair that holds and moves the treasury's SOL and
USDC. Rotating it means moving to a NEW keypair, not just swapping an
env var — the new key needs to be funded (SOL for fees, USDC balance
matching the ledger's `treasury_usdc` account) before it can serve any
payout, and the OLD wallet's funds need to be swept to it. This is not a
same-runbook operation:

1. Generate the new keypair offline (never in a shell whose history is
   logged anywhere near production credentials).
2. Fund it: enough SOL for fees, then transfer the OLD treasury's full
   USDC balance to the NEW address on-chain.
3. Pause (`docs/runbooks/kill-switch.md`) before the cutover — no payout
   should be signed against the wrong key mid-migration.
4. Update `TREASURY_SECRET_KEY` in Vercel, redeploy.
5. Confirm `getTreasuryAddress()` now reports the NEW address (e.g. via
   `GET /v1/wallets/<new address>/balance`, or `scripts/
   print-treasury-ata.js` if run against the new key locally) and that its
   USDC balance matches what the ledger's `treasury_usdc` account expects:
   ```sql
   select sum(case when e.direction = 'debit' then e.amount else -e.amount end) as treasury_usdc_ledger_minor
     from ledger_entries e join ledger_accounts a on a.id = e.account
    where a.code = 'treasury_usdc';
   ```
6. Unpause. Any withdrawal whose `treasuryAddress` was already shown to a
   user with the OLD address before the cutover is now pointed at a
   deprecated wallet — that response payload is not stored/re-servable, but
   in-flight `pending_deposit` rows created before the rotation still carry
   whatever `treasuryAddress` was computed at creation time in their
   original API response; confirm there are none open before pausing in
   step 3, or handle them as a special case (their on-chain transfer would
   land at the OLD address and need a manual sweep before the OLD key is
   ever discarded).

### `API_KEY_SALT` (rotating this invalidates EVERY existing API key)

`hashApiKey` (`src/utils/crypto.js`) is `HMAC-SHA256(API_KEY_SALT,
rawKey)`. `auth_api_keys.key_hash` was computed with the OLD salt for every
key ever issued — rotating the salt makes every existing raw key hash to a
different value, so `apiKeyAuth`'s lookup (`.eq('key_hash', keyHash)`)
misses for all of them simultaneously. **This is equivalent to revoking
every partner's API key at once.** Only rotate this on confirmed compromise
of the salt itself (not of an individual key — deactivate that one key
instead via `DELETE /v1/admin/api-keys/:id`), and only with a plan to
reissue keys to every partner:

1. Notify every partner first if at all possible — this is a breaking
   change for all of them simultaneously, not a silent rotation.
2. Set the new `API_KEY_SALT` in Vercel, redeploy.
3. Every partner's existing key now returns `401 Invalid API key`.
4. Issue new keys via `POST /v1/admin/api-keys` for every partner and
   distribute them through your normal secure channel.

### `CRON_SECRET`

Gates `/internal/transfer-tick` and `/internal/reconcile-tick`
(`src/utils/cron-auth.js`). Rotate freely — Vercel's own cron invocations
read the Vercel-managed value automatically once updated in env; only
manual/operator triggers using the old value need to be told the new one.

```bash
vercel env rm CRON_SECRET production
vercel env add CRON_SECRET production
vercel --prod
curl -s -X POST "$API_BASE_URL/api/internal/reconcile-tick" -H "X-Cron-Secret: $NEW_SECRET" | jq .
# Expected: 200 with the pass summary, not 401.
```

### Upstash (`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`)

Lowest-stakes rotation — `src/middleware/rate-limit.js` fails OPEN (passes
every request through, logs a warning) if these are missing or wrong, so a
rotation mistake here degrades to "rate limiting temporarily disabled," not
an outage. Rotate via the Upstash/Vercel Marketplace dashboard, update the
two env vars, redeploy.

## Verification query

For any admin-adjacent rotation (`ADMIN_KEYS`, `ADMIN_SECRET_KEY`), confirm
attribution still works end-to-end with the new key:

```bash
curl -s -X PUT "$API_BASE_URL/api/v1/admin/exchange-rates" \
  -H "Content-Type: application/json" -H "X-Admin-Key: $NEW_KEY" \
  -H "X-Application-Id: $TEST_APPLICATION_ID" -d '{"rate": 25}'
```

```sql
select actor, action, before, after, created_at
  from audit_log order by created_at desc limit 1;
-- Expected: actor is the NEW key's name (not 'legacy', not the old name).
```

For any rotation that touches API authentication (`SUPABASE_SERVICE_ROLE_KEY`,
`API_KEY_SALT`), confirm the full request path still works:

```bash
curl -s "$API_BASE_URL/api/v1/deposits" -H "X-API-Key: $A_VALID_KEY_POST_ROTATION"
# Expected: 200, not 401/500.
```

Whatever secret was rotated, record it in
`docs/incidents/2026-09-open-db-review.md`'s rotation table (or a new
incident doc, for a rotation triggered by a fresh incident) — date, who did
it, and why.
