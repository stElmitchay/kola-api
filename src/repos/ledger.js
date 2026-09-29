//@ts-check

import { createSupabaseClient } from '../utils/supabase.js';

const supabase = createSupabaseClient();

/**
 * Post an append-only ledger journal (F12). Idempotent on `idempotencyKey` —
 * a repeat call with the same key is a no-op (`post_journal`'s
 * `ON CONFLICT (idempotency_key) DO NOTHING`). Amounts are stringified
 * before crossing into Postgres: they may be `number` or `bigint` in JS but
 * must never round-trip through `Number()` on the way to a bigint column.
 *
 * Never throws. A posting failure (RPC error or rejection) is
 * console.error'd at alert level and swallowed — the money movement this
 * journal describes has already happened and must never be rolled back or
 * blocked by a ledger write failing. The idempotency key makes a later
 * backfill safe once C1's reconciliation job (or an operator) notices the
 * gap.
 *
 * @param {string} kind
 * @param {object} params
 * @param {string} params.resourceType
 * @param {string} params.resourceId
 * @param {string} params.idempotencyKey
 * @param {{account: string, direction: 'debit'|'credit', amount: bigint|number}[]} params.entries
 */
export async function postJournal(kind, { resourceType, resourceId, idempotencyKey, entries }) {
  try {
    const { error } = await supabase.rpc('post_journal', {
      p_kind: kind,
      p_resource_type: resourceType,
      p_resource_id: resourceId,
      p_idempotency_key: idempotencyKey,
      p_entries: entries.map((e) => ({
        account: e.account,
        direction: e.direction,
        amount: String(e.amount)
      }))
    });
    if (error) {
      console.error(`[Ledger] ALERT: post_journal failed kind=${kind} resource=${resourceType}:${resourceId}: ${error.message}`);
    }
  } catch (e) {
    console.error(`[Ledger] ALERT: post_journal threw kind=${kind} resource=${resourceType}:${resourceId}: ${e.message}`);
  }
}

/**
 * Monime SLE collection confirmed. Cross-currency journal: the collected
 * SLE moves through the fx_sle conversion account, and the equivalent USDC
 * becomes payable to the user pending the on-chain transfer. Balances per
 * currency: monime_sle/fx_sle (SLE), fx_usdc/user_payable_usdc (USDC).
 * @param {{id: string, amount_sle: number|bigint, amount_usdc: number|bigint}} deposit
 */
export async function postDepositCollection(deposit) {
  await postJournal('deposit_collection', {
    resourceType: 'deposit',
    resourceId: deposit.id,
    idempotencyKey: `deposit_collection:${deposit.id}`,
    entries: [
      { account: 'monime_sle', direction: 'debit', amount: deposit.amount_sle },
      { account: 'fx_sle', direction: 'credit', amount: deposit.amount_sle },
      { account: 'fx_usdc', direction: 'debit', amount: deposit.amount_usdc },
      { account: 'user_payable_usdc', direction: 'credit', amount: deposit.amount_usdc }
    ]
  });
}

/**
 * USDC payout finalized on-chain — clears the user payable against treasury.
 * @param {{id: string, amount_usdc: number|bigint}} deposit
 */
export async function postDepositPayout(deposit) {
  await postJournal('deposit_payout', {
    resourceType: 'deposit',
    resourceId: deposit.id,
    idempotencyKey: `deposit_payout:${deposit.id}`,
    entries: [
      { account: 'user_payable_usdc', direction: 'debit', amount: deposit.amount_usdc },
      { account: 'treasury_usdc', direction: 'credit', amount: deposit.amount_usdc }
    ]
  });
}

/**
 * USDC receipt verified for a withdrawal. The USDC pair (treasury_usdc /
 * fx_usdc) balances on its own and always posts. The SLE trio that splits
 * fee income out of the gross only posts when `amount_sle_gross` is
 * present — rows created before migration 0015 lack that column, and a
 * one-sided SLE entry would break the per-currency balance invariant, so
 * those (expected to be rare on a clean slate) are logged for manual
 * backfill instead of guessed at.
 * @param {{id: string, amount_usdc: number|bigint, amount_sle: number|bigint, amount_sle_gross?: number|bigint|null}} withdrawal
 */
export async function postWithdrawalReceipt(withdrawal) {
  const entries = [
    { account: 'treasury_usdc', direction: 'debit', amount: withdrawal.amount_usdc },
    { account: 'fx_usdc', direction: 'credit', amount: withdrawal.amount_usdc }
  ];

  if (withdrawal.amount_sle_gross === null || withdrawal.amount_sle_gross === undefined) {
    console.error(
      `[Ledger] ALERT: withdrawal ${withdrawal.id} has no amount_sle_gross (pre-0015 row) — ` +
      'posted USDC leg only; SLE fee-split entries need manual backfill'
    );
  } else {
    const gross = BigInt(withdrawal.amount_sle_gross);
    const net = BigInt(withdrawal.amount_sle);
    entries.push(
      { account: 'fx_sle', direction: 'debit', amount: gross },
      { account: 'user_payable_sle', direction: 'credit', amount: net },
      { account: 'fee_income_sle', direction: 'credit', amount: gross - net }
    );
  }

  await postJournal('withdrawal_receipt', {
    resourceType: 'withdrawal',
    resourceId: withdrawal.id,
    idempotencyKey: `withdrawal_receipt:${withdrawal.id}`,
    entries
  });
}

/**
 * Monime SLE payout completed — clears the user payable against the
 * monime_sle float account.
 * @param {{id: string, amount_sle: number|bigint}} withdrawal
 */
export async function postWithdrawalPayout(withdrawal) {
  await postJournal('withdrawal_payout', {
    resourceType: 'withdrawal',
    resourceId: withdrawal.id,
    idempotencyKey: `withdrawal_payout:${withdrawal.id}`,
    entries: [
      { account: 'user_payable_sle', direction: 'debit', amount: withdrawal.amount_sle },
      { account: 'monime_sle', direction: 'credit', amount: withdrawal.amount_sle }
    ]
  });
}
