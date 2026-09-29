# 0001: Derived wallets — freeze the burn path, choose the v1 model

## Status

Accepted for v1 (Option 1, below). Founder sign-off required before launch.

## Context

Finding F4: `deriveWalletFromPhone` (`src/utils/solana.js`) derives a Solana
keypair-shaped address from a phone number, but the API never persists or
derives a usable private key for it — the address is generated for lookup
purposes only. Any USDC sent to a `derived_wallets` row's `wallet_address`
before this task landed has no corresponding signer, so it is **permanently
unspendable**. This was the fallback path on `POST /v1/deposits` whenever a
caller omitted `walletAddress`, and the only path on `POST /v1/wallets/derive`.

This task (B8) freezes the burn path: `walletAddress` is now required and
schema-validated (`src/schemas/deposit.js`) on deposit creation, and the
`/v1/wallets/derive` endpoint returns `410 Gone`. `scripts/audit-derived-wallets.js`
quantifies how much, if anything, is already stuck in existing derived
wallets — see `docs/FOUNDER_CHECKLIST.md` for the run instructions and what
to do with a non-zero result. This document is the decision record for what
replaces the derived-wallet model going forward.

## Options considered

1. **Require a user wallet (recommended for v1, implemented by this task).**
   The caller supplies a real Solana address it controls (already true for
   the withdrawal flow's `fromWalletAddress`, and kola-app's deposit UI
   already has the wallet-address input for the `provided` path). Deposits
   are paid out directly to that address.
   - Non-custodial: the API never holds a private key on the user's behalf.
   - Zero key-management liability — no keys to generate, rotate, or lose.
   - Matches the withdrawal flow's existing assumption that the user
     already controls a wallet.
   - Cost: kola-app must collect a wallet address before initiating a
     deposit (breaking API change — see `docs/FOUNDER_CHECKLIST.md`).

2. **Custodial balances.** Keep all funds in the treasury wallet and track
   per-user balances as ledger liabilities (e.g. a `user_payable_usdc`
   account per subject in the double-entry ledger from B4), with no
   on-chain per-user account at all.
   - Avoids the wallet-collection UX cost entirely.
   - Regulatory weight: this is plainly custody of user funds. **Do not
     build this before counsel signs off** — it changes the product's
     licensing and compliance posture materially.

3. **On-chain program with PDAs.** A dedicated Solana program creates a
   program-derived address per user, controllable only by a program
   instruction the treasury authority signs to release.
   - Correct in the sense that it gives non-custodial per-user accounts
     without asking users to bring their own wallet.
   - Real cost: weeks of Anchor development plus a security audit before
     it can hold mainnet funds. Out of scope for v1 — this is v2 material.

## Decision

Ship Option 1 for v1: `walletAddress` is required on deposit, validated as a
real base58 Solana address (`new PublicKey(v)` must not throw). This is the
minimum change that stops new unspendable burns and requires no new
infrastructure. Options 2 and 3 remain open for a later version — Option 2
specifically must not be implemented without legal/compliance sign-off given
its custody implications.

## Founder sign-off

- [ ] Founder has reviewed this decision and approves Option 1 for v1 launch.

Signed: ______________________  Date: ______________________
