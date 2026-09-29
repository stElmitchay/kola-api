# Runbook: database restore (PITR)

This is the real-incident version of
`docs/game-days/TEMPLATE-db-restore-pitr.md` — rehearse that drill against a
scratch project BEFORE you ever need this runbook for real. If it hasn't
been rehearsed, budget significantly more time than the drill's recorded
RTO — the first time through any restore procedure is always slower.

## Symptoms

- Data corruption that application-level guards didn't catch: a bad
  manual `UPDATE`/`DELETE` run directly against the database, a
  migration that ran incorrectly, or a confirmed credential compromise
  where an attacker with database access may have altered rows (the ledger
  and audit-log immutability triggers from 0015/0019 block `UPDATE`/`DELETE`
  through PostgREST, but a `service_role` connection via `psql` bypasses
  RLS and is not blocked by those triggers either — if that credential was
  compromised, assume rows could have been altered).
- `proveBalance.result.mismatch = true` from `/internal/reconcile-tick`
  that cannot be explained by `docs/runbooks/unmatched-transfer.md`'s
  normal suspense flow, and which persists across multiple ticks.
- Any scenario where the honest answer to "can we trust this data" is no.

## First command

**Pause first.** A restore takes the database offline and is not something
to attempt while money is actively moving through it:

```bash
# See docs/runbooks/kill-switch.md for the full procedure.
vercel env add KOLA_PAUSE production   # value "1"
vercel --prod
```

Then capture the current state for comparison — you need to know what
"before" looked like even if it's already suspect:

```sql
select 'deposits' as t, count(*) from deposits
union all select 'withdrawals', count(*) from withdrawals
union all select 'ledger_journals', count(*) from ledger_journals
union all select 'ledger_entries', count(*) from ledger_entries;
```

## Decision tree

### 1. Is this actually a database-integrity problem, or an application bug?

Before reaching for PITR (which is destructive to everything since the
restore point — including legitimate transactions), rule out the cheaper
explanation. Check whether the balance mismatch or the suspicious row(s)
are explained by a known, already-shipped bug rather than external
tampering or an operator mistake. A PITR restore erases every write since
the restore point, legitimate or not — it is not a targeted fix.

### 2. Can the damage be scoped and reversed with a targeted fix instead?

If the bad write is a small, identifiable set of rows (e.g. one bad manual
`UPDATE` you can name precisely), a hand-written corrective transaction is
faster and doesn't lose legitimate traffic since the incident started.
Only escalate to PITR when the scope is unknown or too broad to hand-fix
confidently.

### 3. Confirm PITR is provisioned and pick the restore point

```
Supabase dashboard → Project Settings → Add-ons → Point in Time Recovery
```

If it isn't provisioned, it cannot be used for this incident — see
`docs/FOUNDER_CHECKLIST.md`'s launch-gate section, which requires
provisioning PITR before launch precisely so this isn't discovered during
an actual incident.

Pick the restore timestamp: the latest point you're confident predates the
corruption. Err earlier rather than later — the recovery-from-data-loss
cost (replaying/reconciling legitimate transactions since the restore
point) is much cheaper than restoring again because the first attempt still
included the bad data.

### 4. Restore

Follow `docs/game-days/TEMPLATE-db-restore-pitr.md` Steps 3–5 verbatim
(initiate in the dashboard, measure the outage, verify). This is a
production incident, not a drill — do not skip the verification queries
because time pressure feels urgent; a restore you haven't verified is not
a completed restore.

### 5. Reconcile the gap

Every legitimate deposit/withdrawal that happened between the restore point
and the moment the pause took effect is now missing from the database but
may already be reflected on-chain (USDC sent) or at Monime (a payout
dispatched). Before unpausing:

- Cross-check the treasury ATA's on-chain transaction history (Solscan/
  Solana explorer) against what the restored `deposits`/`withdrawals` show
  for that gap window — any on-chain movement with no matching row needs
  manual reconstruction (a corrective ledger entry via `post_journal`, and
  the corresponding `deposits`/`withdrawals` row if the user needs their
  status to reflect it).
- Cross-check recent Monime payouts (dashboard, by date range) against
  `withdrawals` for the same gap window.

This step has no single query — it's a manual reconciliation against two
external sources of truth. Budget real time for it; it's usually the
longest part of the incident, not the restore itself.

## Verification query

```sql
select 'deposits' as t, count(*) from deposits
union all select 'withdrawals', count(*) from withdrawals
union all select 'ledger_journals', count(*) from ledger_journals
union all select 'ledger_entries', count(*) from ledger_entries;
-- Compare against the "First command" baseline and the gap-window
-- reconciliation from Step 5 — the difference should now be fully
-- accounted for (restored rows + manually reconstructed rows for the gap).
```

```sql
select j.id, j.kind, a.currency,
       sum(case when e.direction = 'debit'  then e.amount else 0 end) as debits,
       sum(case when e.direction = 'credit' then e.amount else 0 end) as credits
  from ledger_journals j
  join ledger_entries e on e.journal_id = j.id
  join ledger_accounts a on a.id = e.account
 group by j.id, j.kind, a.currency
having sum(case when e.direction = 'debit'  then e.amount else 0 end)
    <> sum(case when e.direction = 'credit' then e.amount else 0 end);
-- Expected: 0 rows.
```

```bash
curl -s -X POST "$API_BASE_URL/api/internal/reconcile-tick" -H "X-Cron-Secret: $CRON_SECRET" | jq .proveBalance
# Expected: mismatch = false, before unpausing.
```

Only unpause (`docs/runbooks/kill-switch.md`) once `proveBalance` is clean
and the gap-window reconciliation in Step 5 is complete.
