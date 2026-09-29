# SQL Verification: Deposit and Withdrawal State Machines

This document contains the SQL statements from Task B1 that verify the state-machine constraints are correctly enforced at the database level.

## Verification Statements

The following three SQL statements must be executed against a Postgres instance with the `0012_state_machines.sql` migration applied:

### Statement 1: Illegal deposit transition (must FAIL)

```sql
UPDATE deposits SET status='completed' WHERE status='pending' AND id = '<any test row>';
```

Expected: `ERROR: ILLEGAL_DEPOSIT_TRANSITION: pending -> completed`

### Statement 2: Illegal withdrawal transition (must FAIL)

```sql
UPDATE withdrawals SET status='expired' WHERE status='processing' AND id = '<any test row>';
```

Expected: `ERROR: ILLEGAL_WITHDRAWAL_TRANSITION: processing -> expired`

### Statement 3: Legal deposit transition (must SUCCEED)

```sql
UPDATE deposits SET status='processing' WHERE status='pending' AND id = '<any test row>';
```

Expected: `UPDATE 1` or similar success response; query returns successfully.

---

## TODO (founder): run against a scratch project and paste actual psql output here

Copy the three SQL statements above into your local `psql` client (after running `supabase db reset` or against a scratch Supabase project with the full migration chain applied), and record the actual output below:

```
[paste actual psql output here]
```

---
