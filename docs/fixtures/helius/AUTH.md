# Helius webhook auth posture (V-D)

## Current implementation

`src/utils/helius.js`'s `verifyHeliusAuth` compares the incoming
`Authorization` header against `HELIUS_WEBHOOK_AUTH_HEADER` using
`crypto.timingSafeEqual` — a constant-time comparison of a **static shared
secret**, not a per-payload signature. Helius resends this exact
dashboard-configured string on every webhook callback; it doesn't change
per request and doesn't cover the request body.

## Dashboard check (pending)

Whether the current Helius plan supports webhook HMAC/request signing
requires live access to a provisioned Helius account, which was not
available in the sandboxed environment this work was done in (same
constraint noted in `docs/fixtures/helius/README.md` for the payload-shape
fixture). This is recorded as a founder follow-up in
`docs/FOUNDER_CHECKLIST.md`:

- **If HMAC/signing is available** on the plan: enable it in the
  dashboard, then extend `verifyHeliusAuth` (`src/utils/helius.js`) to
  verify the signature header (e.g. HMAC-SHA256 over the raw request body)
  instead of the static bearer.
- **If not available**: no code change is needed. The static bearer stays
  — see below for why that's an acceptable posture in the meantime.

## Why the static bearer is acceptable

A forged webhook call (someone who guesses or obtains
`HELIUS_WEBHOOK_AUTH_HEADER`) cannot move funds. The handler never trusts
the payload's money claims at face value:

1. **CAS-gated matching.** Every inbound transfer the webhook reports is
   matched against a **pre-existing** expected `(wallet, amount)` pair via
   a compare-and-swap on an already-`received`-eligible withdrawal. A
   forged payload can only "match" a pair that already existed before the
   call arrived — it cannot invent a new expected withdrawal, wallet, or
   amount.
2. **On-chain re-verification (C1).** Before anything is treated as
   settled, the claimed transaction is re-verified on-chain via
   `connection.getParsedTransaction` (through `withRpcFailover` as of task
   C5). A forged payload naming a transaction that doesn't exist, or one
   that doesn't actually carry the claimed transfer, fails
   re-verification and is never posted to the ledger.

So the worst outcome of a forged webhook call is a wasted lookup (and, if
it happens to name a real signature, a redundant re-verification that
still can't fabricate a transfer into a pair that wasn't already expected).
It cannot fabricate a transfer or move treasury funds on its own. This is
why the static-bearer comparison is an acceptable interim posture pending
the dashboard check above — it's a coarse gate against random callers, not
the thing standing between a forged request and moved funds.
