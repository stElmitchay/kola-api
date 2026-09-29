//@ts-check

import BigNumber from 'bignumber.js';
import { getTreasuryAddress } from '../../utils/solana.js';
import {
  findPendingByWalletAndAmount,
  updateWithdrawalIfStatus
} from '../../repos/withdrawals.js';
import { triggerPayoutForWithdrawal } from '../withdrawals/withdrawals.js';
import { postWithdrawalReceipt, postJournal } from '../../repos/ledger.js';
import { recordUnmatched } from '../../repos/unmatched-transfers.js';

/**
 * Process a batch of Helius Enhanced Webhook events. For every USDC token
 * transfer landing on the treasury wallet, find the matching open withdrawal
 * and advance it pending_deposit → received → processing.
 *
 * CAS via updateWithdrawalIfStatus means a concurrent manual /:id/confirm
 * cannot also fire the Monime payout — first writer wins, the other no-ops.
 *
 * Pure function (no Hono context) so it can be reused from a test harness
 * or, later, a replay tool.
 *
 * @param {any[]} events
 */
export async function handleHeliusEvent(events) {
  const treasury = getTreasuryAddress();
  const usdcMint = process.env.USDC_MINT;

  for (const ev of events) {
    // No `ev.type` filter — Helius enriches SPL transfers as type="TRANSFER"
    // (source SOLANA_PROGRAM_LIBRARY), not "TOKEN_TRANSFER" as the dashboard
    // filter labels suggest. The Helius dashboard already gates which events
    // fire to us by address + type, so it's safe to inspect tokenTransfers
    // unconditionally here.
    const transfers = Array.isArray(ev.tokenTransfers) ? ev.tokenTransfers : [];
    for (const t of transfers) {
      if (t?.mint !== usdcMint) continue;
      if (t?.toUserAccount !== treasury) continue;

      const fromWallet = t.fromUserAccount;
      // Helius gives tokenAmount as a human-readable number; USDC has 6
      // decimals. Prefer the raw integer string when present (exact — no
      // float involved); fall back to exact BigNumber string math on
      // tokenAmount, never plain float multiplication (F18).
      // ASSUMPTION(V-D-adjacent): verify against docs/fixtures/helius/ — fixture wins
      const amountMinorUnits = t.rawTokenAmount?.tokenAmount != null
        ? Number(t.rawTokenAmount.tokenAmount)   // integer string from Helius — exact
        : new BigNumber(String(t.tokenAmount)).multipliedBy(1_000_000).integerValue(BigNumber.ROUND_HALF_UP).toNumber();
      if (!fromWallet || !Number.isFinite(amountMinorUnits)) continue;

      const { data: w, error: findErr } = await findPendingByWalletAndAmount(
        fromWallet,
        amountMinorUnits
      );
      if (findErr || !w) {
        const reason = findErr ? 'lookup_error' : 'no_open_match';
        if (findErr) {
          console.error(`[Helius] Lookup failed for from=${fromWallet} amount=${amountMinorUnits}: ${findErr.message}`);
        } else {
          console.log(`[Helius] No matching open withdrawal for from=${fromWallet} amount=${amountMinorUnits} sig=${ev.signature}`);
        }

        const { data: booked, error: recordErr } = await recordUnmatched({
          signature: ev.signature, from_wallet: fromWallet,
          amount_usdc: amountMinorUnits, reason
        });
        if (recordErr) {
          console.error(`[Helius] Failed to record unmatched transfer sig=${ev.signature}: ${recordErr.message}`);
          continue;
        }
        if (booked) {   // unique(signature) makes replays no-ops
          await postJournal('suspense_in', {
            resourceType: 'unmatched_transfer', resourceId: booked.id,
            idempotencyKey: `suspense_in:${ev.signature}`,
            entries: [
              { account: 'treasury_usdc', direction: 'debit',  amount: amountMinorUnits },
              { account: 'suspense_usdc', direction: 'credit', amount: amountMinorUnits }
            ]
          });
          console.error(`[Helius] UNMATCHED transfer booked to suspense sig=${ev.signature}`); // C4: paged alert
        }
        continue;
      }

      const { data: claimed, error: claimErr } = await updateWithdrawalIfStatus(
        w.id,
        'pending_deposit',
        { status: 'received', solana_tx_signature: ev.signature }
      );
      if (claimErr) {
        console.error(`[Helius] CAS failed for withdrawal ${w.id}: ${claimErr.message}`);
        continue;
      }
      if (!claimed) {
        console.log(`[Helius] Withdrawal ${w.id} already advanced past pending_deposit, skipping`);
        continue;
      }

      console.log(`[Helius] Claimed withdrawal ${w.id} via tx ${ev.signature}; triggering payout`);
      await postWithdrawalReceipt(claimed);
      try {
        await triggerPayoutForWithdrawal(claimed);
        console.log(`[Helius] Withdrawal ${w.id} payout initiated`);
      } catch (e) {
        // triggerPayoutForWithdrawal has already written status=failed; just log.
        console.error(`[Helius] Withdrawal ${w.id} payout failed: ${e.message}`);
      }
    }
  }

  return { ok: true };
}
