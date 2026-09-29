//@ts-check

import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { getConnection } from '../utils/connection.js';
import { getTreasuryAddress } from '../utils/solana.js';
import { createSupabaseClient } from '../utils/supabase.js';

const supabase = createSupabaseClient();

/**
 * Treasury USDC associated token account (ATA) — the address whose
 * signature history the missed-event sweep walks. Derived from the same
 * inputs (`getTreasuryAddress`, `USDC_MINT`) used everywhere else, not a
 * new private key path.
 * @returns {Promise<PublicKey>}
 */
async function getTreasuryAta() {
  const treasury = new PublicKey(getTreasuryAddress());
  const usdcMint = new PublicKey(process.env.USDC_MINT);
  return getAssociatedTokenAddress(usdcMint, treasury);
}

/**
 * Most recent signatures touching the treasury USDC ATA, newest first
 * (Solana RPC's default order for `getSignaturesForAddress`). Covers both
 * inbound receipts and outbound payouts — the missed-event sweep filters
 * out anything already accounted for via `hasProcessedSignature`.
 * @param {number} [limit]
 * @returns {Promise<string[]>}
 */
export async function getRecentTreasurySignatures(limit = 50) {
  const connection = getConnection();
  const ata = await getTreasuryAta();
  const sigs = await connection.getSignaturesForAddress(ata, { limit });
  return (sigs || []).map((s) => s.signature);
}

/**
 * Has this treasury-bound signature already been accounted for by the
 * normal webhook-driven paths? Checks the three tables any Helius-
 * processed transfer can land in: `deposits.solana_tx_signature` (an
 * outbound payout, set by transfer-tick's `finish()`), `withdrawals.
 * solana_tx_signature` (an inbound receipt, set by `handleHeliusEvent`'s
 * matched path), and `unmatched_transfers.signature` (an inbound transfer
 * with no matching open withdrawal, booked to suspense).
 *
 * `webhook_events` is deliberately NOT queried here — its Helius rows only
 * carry the signature buried inside the `payload` jsonb column, not as an
 * indexed field, and every Helius-processed inbound transfer already lands
 * in `withdrawals` or `unmatched_transfers` as a side effect of
 * `handleHeliusEvent`. The three-table check above is therefore complete;
 * adding a jsonb scan over `webhook_events` would only slow this down for
 * no additional signal.
 * @param {string} signature
 * @returns {Promise<boolean>}
 */
export async function hasProcessedSignature(signature) {
  const [deposit, withdrawal, unmatched] = await Promise.all([
    supabase.from('deposits').select('id').eq('solana_tx_signature', signature).maybeSingle(),
    supabase.from('withdrawals').select('id').eq('solana_tx_signature', signature).maybeSingle(),
    supabase.from('unmatched_transfers').select('id').eq('signature', signature).maybeSingle()
  ]);
  return Boolean(deposit.data || withdrawal.data || unmatched.data);
}

/**
 * Adapt a `connection.getParsedTransaction` result into the Enhanced-
 * webhook shape `handleHeliusEvent` expects: `{ signature, tokenTransfers:
 * [...] }`. Walks top-level + inner parsed instructions for an SPL
 * `transfer`/`transferChecked` landing in the treasury ATA — the same walk
 * already proven in `verifyIncomingUsdcTransfer` (src/utils/solana.js).
 *
 * Field-by-field mapping (documented because none of it is a direct
 * 1:1 copy from the parsed instruction):
 *  - `toUserAccount`: `handleHeliusEvent` matches on
 *    `toUserAccount === treasury WALLET address`, not the ATA — but a
 *    parsed instruction only ever gives ATAs. Since this function is only
 *    ever called for transfers whose `destination` is the treasury ATA,
 *    that mapping is exact: set unconditionally to the treasury wallet
 *    address (`getTreasuryAddress()`).
 *  - `mint`: fixed to the caller-supplied `usdcMint` — we only sweep the
 *    treasury's USDC ATA in the first place, so every transfer found here
 *    is already known to be USDC.
 *  - `fromUserAccount`: cannot be derived reliably from the source ATA
 *    alone (that would need an extra RPC round-trip to resolve ATA ->
 *    owner, which this sweep intentionally avoids). Parsed spl-token
 *    `transfer`/`transferChecked` instructions carry an `authority` (or
 *    `multisigAuthority`) field naming the signer/owner when present — use
 *    that. When neither is present, fall back to the source ATA string;
 *    that value will not match any real wallet address in
 *    `findPendingByWalletAndAmount`, so the adapted transfer safely falls
 *    through to the suspense (`unmatched_transfers`) path instead of being
 *    silently dropped or mis-attributed to the wrong withdrawal. This is
 *    the safe failure mode by design.
 *  - `rawTokenAmount`: `{ tokenAmount: <amount string>, decimals: 6 }` —
 *    USDC is always 6 decimals.
 *
 * @param {string} signature
 * @param {any} parsedTx - `connection.getParsedTransaction` result
 * @param {string} usdcMint
 * @param {string} treasuryAta
 * @returns {{signature: string, tokenTransfers: object[]}}
 */
export function adaptParsedTransaction(signature, parsedTx, usdcMint, treasuryAta) {
  const treasuryWallet = getTreasuryAddress();
  const allIxs = [
    ...(parsedTx?.transaction?.message?.instructions || []),
    ...((parsedTx?.meta?.innerInstructions || []).flatMap((g) => g.instructions))
  ];

  const tokenTransfers = [];
  for (const ix of allIxs) {
    const parsed = ix?.parsed;
    if (!parsed || (parsed.type !== 'transfer' && parsed.type !== 'transferChecked')) continue;

    const info = parsed.info || {};
    if (info.destination !== treasuryAta) continue;

    const amountStr = info.amount ?? info.tokenAmount?.amount;
    if (!amountStr) continue;

    const fromUserAccount = info.authority || info.multisigAuthority || info.source;

    tokenTransfers.push({
      mint: usdcMint,
      toUserAccount: treasuryWallet,
      fromUserAccount,
      rawTokenAmount: { tokenAmount: String(amountStr), decimals: 6 }
    });
  }

  return { signature, tokenTransfers };
}

/**
 * Fetch and adapt the parsed transaction for a single treasury-bound
 * signature into `handleHeliusEvent`'s expected shape. Returns `[]` (not a
 * throw) when the transaction isn't found, failed on-chain, or carries no
 * matching USDC transfer into the treasury ATA — the caller can then skip
 * it without special-casing.
 * @param {string} signature
 * @returns {Promise<{signature: string, tokenTransfers: object[]}[]>}
 */
export async function getParsedTransfersForSignature(signature) {
  const connection = getConnection();
  const usdcMint = process.env.USDC_MINT;
  const treasuryAta = (await getTreasuryAta()).toBase58();

  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'finalized'
  });
  if (!tx || tx.meta?.err) return [];

  const event = adaptParsedTransaction(signature, tx, usdcMint, treasuryAta);
  return event.tokenTransfers.length ? [event] : [];
}

/**
 * Ledger-side treasury_usdc balance (account id 1, migration 0015):
 * sum(debit) - sum(credit), reduced in JS with BigInt from raw
 * `{account, direction, amount}` rows. supabase-js can't aggregate
 * server-side without a bespoke RPC, and this task adds no new migration —
 * at expected v1 volumes (a handful of journals per minute) pulling every
 * row and reducing client-side is acceptable. A materialized balance view
 * (or an aggregate RPC) should replace this once row counts make the
 * client-side reduce noticeably slow.
 * @returns {Promise<bigint>}
 */
export async function getLedgerTreasuryBalanceMinor() {
  const { data, error } = await supabase
    .from('ledger_entries')
    .select('direction, amount')
    .eq('account', 1);
  if (error) throw error;

  return (data || []).reduce((sum, row) => {
    const amount = BigInt(row.amount);
    return row.direction === 'debit' ? sum + amount : sum - amount;
  }, 0n);
}

/**
 * Non-terminal rows older than `thresholdMinutes` across the three tables
 * that carry an in-flight money state: `deposits` (confirmed/processing),
 * `withdrawals` (received/processing), `transfer_jobs` (queued/sending).
 * Three separate queries, concatenated with a `table` tag identifying
 * which one each row came from.
 * @param {number} thresholdMinutes
 * @returns {Promise<{table: string, id: string, status: string, age_minutes: number}[]>}
 */
export async function listStaleInflight(thresholdMinutes) {
  const cutoff = new Date(Date.now() - thresholdMinutes * 60_000);
  const cutoffIso = cutoff.toISOString();

  const targets = [
    { table: 'deposits', statuses: ['confirmed', 'processing'] },
    { table: 'withdrawals', statuses: ['received', 'processing'] },
    { table: 'transfer_jobs', statuses: ['queued', 'sending'] }
  ];

  const stale = [];
  for (const { table, statuses } of targets) {
    const { data, error } = await supabase
      .from(table)
      .select('id, status, updated_at')
      .in('status', statuses)
      .lt('updated_at', cutoffIso);
    if (error) {
      console.error(`[Reconcile] ALERT: listStaleInflight query failed for ${table}: ${error.message}`);
      continue;
    }
    for (const row of data || []) {
      const ageMinutes = Math.floor((Date.now() - new Date(row.updated_at).getTime()) / 60_000);
      stale.push({ table, id: row.id, status: row.status, age_minutes: ageMinutes });
    }
  }
  return stale;
}

/**
 * Delete `idempotency_keys` rows older than 24h (housekeeping — B7 created
 * the table but left pruning for this task). Returns the number of rows
 * deleted; never throws (a failed cleanup is logged and treated as
 * "nothing to report", not fatal to the rest of the reconcile run).
 * @returns {Promise<number>}
 */
export async function deleteExpiredIdempotencyKeys() {
  const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { error, count } = await supabase
    .from('idempotency_keys')
    .delete({ count: 'exact' })
    .lt('created_at', cutoffIso);
  if (error) {
    console.error(`[Reconcile] ALERT: deleteExpiredIdempotencyKeys failed: ${error.message}`);
    return 0;
  }
  return count || 0;
}
