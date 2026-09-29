# Founder checklist — live infrastructure steps

This checklist covers the steps in the production-hardening plan that
require access to live infrastructure (the Supabase CLI, a linked
Supabase project, `psql`/`SUPABASE_DB_URL`, or Vercel credentials) that
were not available in the sandboxed environment this work was done in.
Everything else in the referenced tasks (code, migrations, tests, docs)
has already been written and committed — these are the remaining manual
steps to actually apply and verify them against production.

## Task A1 — apply & verify

1. **Apply the lockdown migration** (after unpausing the project if it's
   paused):

   ```bash
   supabase db push
   # or, applied directly against the prod connection string:
   psql "$SUPABASE_DB_URL" -f supabase/migrations/0009_lockdown_rls.sql
   ```

2. **Prove the anon key is now useless:**

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" \
     "$SUPABASE_URL/rest/v1/auth_api_keys?select=id&limit=1" \
     -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY"
   ```

   Expected: `401`, `403`, or an empty/permission-denied body — anything
   but `200` with rows.

3. **Set the service-role key in Vercel** (production + preview
   environments) and in local `.env`:

   ```bash
   vercel env add SUPABASE_SERVICE_ROLE_KEY production
   vercel env add SUPABASE_SERVICE_ROLE_KEY preview
   ```

   Then remove `SUPABASE_ANON_KEY` from both environments and from local
   `.env` — it must not remain configured anywhere this API runs.

4. **Confirm one authenticated API call still works end-to-end**, e.g.:

   ```bash
   curl -s "$API_BASE_URL/api/v1/deposits" -H "X-API-Key: <a valid key>"
   ```

5. **Run the exposure review.** Execute the four SQL queries in
   `docs/incidents/2026-09-open-db-review.md` against the live database
   (Supabase SQL editor, with the service role) and record each
   `RESULT:` line in that file.

6. **Rotate credentials** and record what was rotated and when in the
   rotation table in `docs/incidents/2026-09-open-db-review.md`:
   - Supabase JWT secret (dashboard → Settings → API → rotate; this
     invalidates the old anon + service-role keys — update Vercel and
     any other consumer immediately after)
   - `ADMIN_SECRET_KEY`
   - Monime access token (request a new one via Monime)

   Git history was verified clean (finding C1) — no history rewrite is
   needed.

## Task A2 — schema baseline dump

1. **Dump the real production schema:**

   ```bash
   supabase db dump --db-url "$SUPABASE_DB_URL" --schema public -f supabase/schema_baseline_2026-09.sql
   ```

2. **Diff it against what the migrations produce**, to confirm the
   migration chain can rebuild the database from scratch:

   ```bash
   # Spin up a scratch local db, apply 001 + 0007 + 0008 + 0009, dump, diff:
   supabase start && supabase db reset
   supabase db dump --local --schema public -f /tmp/from-migrations.sql
   diff /tmp/from-migrations.sql supabase/schema_baseline_2026-09.sql || true
   ```

   Expected: differences corresponding to the ghost migrations 0002–0006
   (see `supabase/migrations/README.md`). Record every difference
   (columns, indexes, constraints) under "Applied out-of-band before
   0009" in that README. If a difference is load-bearing (e.g. an index
   the code assumes exists), create it explicitly in a new migration so
   the chain becomes self-sufficient going forward.

3. **Commit the baseline dump:**

   ```bash
   git add supabase/schema_baseline_2026-09.sql supabase/migrations/README.md
   git commit -m "chore: capture production schema baseline, document migration gap 0002-0006"
   ```
