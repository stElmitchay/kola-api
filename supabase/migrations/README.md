# Migrations

## Numbering

Migrations are numbered four-digit sequential, starting at `0009`
(`001_initial_schema.sql` predates this convention and is kept as-is).
Never edit an applied migration — write a new one.

## Applied out-of-band before 0009

Migrations `0002` through `0006` do not exist in this repository. The
production schema includes changes made directly against the database
(via the Supabase dashboard or SQL editor) between `001_initial_schema.sql`
and `0007_create_withdrawals.sql` that were never captured as migration
files. This gap is why `supabase/schema_baseline_2026-09.sql` exists: the
migration chain alone (`001` + `0007` + `0008` + `0009` + …) is not
sufficient to reproduce the current production schema exactly.

The specific columns/indexes/constraints introduced out-of-band in that
gap have not yet been diffed against the migration chain — this requires
a live Supabase project (`supabase db dump` against production, and a
local `supabase start && supabase db reset` to dump what the migrations
alone produce). See "Task A2 — schema baseline dump" in
`docs/FOUNDER_CHECKLIST.md` for the exact commands. Once that diff is
run, record every difference found here, and if any difference is
load-bearing (e.g. an index the code assumes exists), promote it into an
explicit migration numbered `>= 0009` so the chain becomes self-sufficient
going forward.

## Canonical rebuild path

To rebuild the database from scratch:

1. Apply `supabase/schema_baseline_2026-09.sql` (the production schema
   snapshot, once captured — see `docs/FOUNDER_CHECKLIST.md`).
2. Apply every migration in this directory numbered `0009` and above, in
   order.

`001_initial_schema.sql` through `0008_disable_rls_withdrawals.sql` are
superseded by the baseline dump for rebuild purposes; they remain in the
repo as history but should not be re-applied on top of the baseline.
