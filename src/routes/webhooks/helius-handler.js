//@ts-check

import { getTreasuryAddress } from '../../utils/solana.js';
import {
  findPendingByWalletAndAmount,
  updateWithdrawalIfStatus
} from '../../repos/withdrawals.js';
import { triggerPayoutForWithdrawal } from '../withdrawals/withdrawals.js';

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
      // Helius gives tokenAmount as a human-readable number; USDC has 6 decimals.
      const amountMinorUnits = Math.round(Number(t.tokenAmount) * 1_000_000);
      if (!fromWallet || !Number.isFinite(amountMinorUnits)) continue;

      const { data: w, error: findErr } = await findPendingByWalletAndAmount(
        fromWallet,
        amountMinorUnits
      );
      if (findErr) {
        console.error(`[Helius] Lookup failed for from=${fromWallet} amount=${amountMinorUnits}: ${findErr.message}`);
        continue;
      }
      if (!w) {
        console.log(`[Helius] No matching open withdrawal for from=${fromWallet} amount=${amountMinorUnits} sig=${ev.signature}`);
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
