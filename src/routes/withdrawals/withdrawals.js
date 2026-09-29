//@ts-check

import BigNumber from 'bignumber.js';
import { validatePhoneNumber } from '../../utils/validation.js';
import { getTreasuryAddress, verifyIncomingUsdcTransfer } from '../../utils/solana.js';
import { createPayout } from '../../utils/monime.js';
import {
  createWithdrawal as createWithdrawalRepo,
  getWithdrawal as getWithdrawalRepo,
  listWithdrawals as listWithdrawalsRepo,
  updateWithdrawal,
  updateWithdrawalIfStatus,
  sumWithdrawalsForPhoneSince,
  findPendingByWalletAndAmount
} from '../../repos/withdrawals.js';
import { getActiveRate, assertRateFresh } from '../../repos/exchange-rates.js';
import {
  createValidationError,
  createNotFoundError,
  createDatabaseError
} from '../../utils/errors.js';

const DEFAULT_FEE_BPS = 100;            // 1%
const DEFAULT_MIN_USDC = 100_000;       // 0.1 USDC
const DEFAULT_MAX_USDC = 100_000_000;   // 100 USDC
const DEFAULT_DAILY_CAP_USDC = 500_000_000; // 500 USDC
const WITHDRAWAL_EXPIRY_MINUTES = 30;

function envInt(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Calculate the SLE delivered after the withdrawal fee.
 *   sleMinor = usdcMinor * rate * (10000 - feeBps) / 10000 / 1e6 * 100
 *
 * Layout (each variable in *minor units*):
 *   usdcMinor (1 USDC = 1_000_000) -> usdc = usdcMinor / 1e6
 *   sleFloat  = usdc * rate * (1 - fee)
 *   sleMinor  = floor(sleFloat * 100)
 *
 * @param {number} usdcMinor
 * @param {BigNumber} rate - SLE per 1 USDC
 * @param {number} feeBps
 */
function calculateSleAmount(usdcMinor, rate, feeBps) {
  const usdc = new BigNumber(usdcMinor).dividedBy(1_000_000);
  const grossSle = usdc.multipliedBy(rate);
  const netSle = grossSle.multipliedBy(10000 - feeBps).dividedBy(10000);
  const sleMinor = netSle.multipliedBy(100).integerValue(BigNumber.ROUND_DOWN);
  return sleMinor.toNumber();
}

/**
 * @param {object} params
 * @param {number} params.amountUsdc
 * @param {string} params.phoneNumber
 * @param {string} params.providerCode
 * @param {string} params.fromWalletAddress
 * @param {object} [params.metadata]
 * @param {string} params.application
 */
export async function initiateWithdrawal(params) {
  const { valid, normalized } = validatePhoneNumber(params.phoneNumber);
  if (!valid || !normalized) {
    throw createValidationError('Invalid Sierra Leone phone number');
  }

  // Limit checks
  const minUsdc = envInt('WITHDRAWAL_MIN_USDC', DEFAULT_MIN_USDC);
  const maxUsdc = envInt('WITHDRAWAL_MAX_USDC', DEFAULT_MAX_USDC);
  const dailyCap = envInt('WITHDRAWAL_DAILY_CAP_USDC', DEFAULT_DAILY_CAP_USDC);

  if (params.amountUsdc < minUsdc) {
    throw createValidationError(`Amount below minimum (${minUsdc} minor units / ${(minUsdc / 1_000_000).toFixed(2)} USDC)`);
  }
  if (params.amountUsdc > maxUsdc) {
    throw createValidationError(`Amount exceeds maximum (${maxUsdc} minor units / ${(maxUsdc / 1_000_000).toFixed(2)} USDC)`);
  }

  // Daily rolling cap per phone
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { total, error: capError } = await sumWithdrawalsForPhoneSince(
    normalized,
    params.application,
    since
  );
  if (capError) {
    throw createDatabaseError(`Failed to check daily cap: ${capError.message}`);
  }
  if (total + params.amountUsdc > dailyCap) {
    throw createValidationError(
      `Daily withdrawal cap of ${(dailyCap / 1_000_000).toFixed(2)} USDC would be exceeded (already used ${(total / 1_000_000).toFixed(2)} USDC in last 24h)`
    );
  }

  // Rate + fee
  const { data: rateData, error: rateError } = await getActiveRate(params.application);
  if (rateError || !rateData) {
    throw createValidationError('No active exchange rate configured. Admin must set a rate first.');
  }
  assertRateFresh(rateData);
  const rate = new BigNumber(rateData.rate);
  const feeBps = envInt('WITHDRAWAL_FEE_BPS', DEFAULT_FEE_BPS);
  const amountSle = calculateSleAmount(params.amountUsdc, rate, feeBps);

  if (amountSle <= 0) {
    throw createValidationError('Amount too small to produce any SLE after fee');
  }

  // Refuse a duplicate while one is still open. Keeps the (wallet, amount)
  // pair unambiguous so the Helius auto-confirm handler can match an incoming
  // USDC transfer to exactly one withdrawal.
  const { data: openDup } = await findPendingByWalletAndAmount(
    params.fromWalletAddress,
    params.amountUsdc
  );
  if (openDup) {
    throw createValidationError(
      'An open withdrawal already exists for this wallet and amount. ' +
      'Complete it or wait for it to expire, or withdraw a slightly different amount.'
    );
  }

  const expiresAt = new Date(Date.now() + WITHDRAWAL_EXPIRY_MINUTES * 60 * 1000).toISOString();

  const { data: withdrawal, error: insertError } = await createWithdrawalRepo({
    application: params.application,
    phone_number: normalized,
    from_wallet_address: params.fromWalletAddress,
    provider_code: params.providerCode,
    amount_usdc: params.amountUsdc,
    amount_sle: amountSle,
    fee_bps: feeBps,
    exchange_rate: rateData.rate,
    expires_at: expiresAt,
    metadata: params.metadata || {}
  });

  if (insertError || !withdrawal) {
    throw createDatabaseError(`Failed to create withdrawal: ${insertError?.message}`);
  }

  return {
    id: withdrawal.id,
    status: withdrawal.status,
    amountUsdc: withdrawal.amount_usdc,
    amountSle: withdrawal.amount_sle,
    feeBps: withdrawal.fee_bps,
    exchangeRate: Number(withdrawal.exchange_rate),
    phoneNumber: withdrawal.phone_number,
    providerCode: withdrawal.provider_code,
    fromWalletAddress: withdrawal.from_wallet_address,
    treasuryAddress: getTreasuryAddress(),
    reference: withdrawal.id,
    expiresAt: withdrawal.expires_at
  };
}

/**
 * Confirm a withdrawal by submitting the Solana tx signature that paid the treasury.
 * Verifies the tx on-chain, then triggers the Monime payout.
 *
 * @param {string} id
 * @param {string} application
 * @param {string} solanaTxSignature
 */
export async function confirmWithdrawal(id, application, solanaTxSignature) {
  const { data: withdrawal, error } = await getWithdrawalRepo(id, application);
  if (error || !withdrawal) {
    throw createNotFoundError('Withdrawal not found');
  }

  // Retry path: Solana side already succeeded but the Monime payout failed.
  // Caller can re-submit /:id/confirm with the same signature to retry the payout.
  const isPayoutRetry =
    withdrawal.status === 'failed' &&
    withdrawal.solana_tx_signature === solanaTxSignature &&
    !withdrawal.monime_payout_id;

  if (withdrawal.status !== 'pending_deposit' && !isPayoutRetry) {
    throw createValidationError(`Withdrawal cannot be confirmed (current status: ${withdrawal.status})`);
  }

  let workingRow = withdrawal;

  // Skip expiry + on-chain verification when retrying — we've already done that work
  if (!isPayoutRetry) {
    if (new Date(withdrawal.expires_at).getTime() < Date.now()) {
      // CAS: only expire a row that is still pending. If Helius claimed it
      // between our read and now, the claim wins and this confirm is a no-op.
      await updateWithdrawalIfStatus(id, 'pending_deposit', { status: 'expired' });
      throw createValidationError('Withdrawal has expired');
    }

    const verification = await verifyIncomingUsdcTransfer(
      solanaTxSignature,
      withdrawal.from_wallet_address,
      Number(withdrawal.amount_usdc)
    );
    if (!verification.ok) {
      throw createValidationError(verification.reason);
    }

    // CAS: only the writer that flips pending_deposit → received gets to
    // fire the Monime payout. Prevents a double-fire when the Helius
    // auto-confirm webhook races this manual confirm call.
    const { data: claimed, error: claimErr } = await updateWithdrawalIfStatus(
      id,
      'pending_deposit',
      { status: 'received', solana_tx_signature: solanaTxSignature }
    );
    if (claimErr) {
      throw createDatabaseError(`Failed to record received tx: ${claimErr.message}`);
    }
    if (!claimed) {
      // Helius (or another writer) already advanced this row. Don't double-fire.
      return getWithdrawalStatus(id, application);
    }
    workingRow = claimed;
  }

  await triggerPayoutForWithdrawal(workingRow, isPayoutRetry ? 'failed' : 'received');

  return getWithdrawalStatus(id, application);
}

/**
 * Fire the Monime payout for a withdrawal whose USDC has been verified.
 * All status writes are CAS from expectedStatus so a racing completion
 * webhook can never be overwritten (F8): if the CAS loses, we keep the
 * webhook's status and only backfill monime_payout_id for the audit trail.
 * @param {object} withdrawal
 * @param {string} [expectedStatus] - 'received' normally, 'failed' on the retry path
 */
export async function triggerPayoutForWithdrawal(withdrawal, expectedStatus = 'received') {
  try {
    const payout = await createPayout({
      withdrawalId: withdrawal.id,
      amountMinorUnits: Number(withdrawal.amount_sle),
      phoneNumber: withdrawal.phone_number,
      providerCode: withdrawal.provider_code,
      metadata: { withdrawal_id: withdrawal.id }
    });

    const { data: advanced } = await updateWithdrawalIfStatus(withdrawal.id, expectedStatus, {
      status: 'processing',
      monime_payout_id: payout.id,
      failure_reason: null
    });
    if (!advanced) {
      await updateWithdrawal(withdrawal.id, { monime_payout_id: payout.id });
    }
  } catch (payoutError) {
    await updateWithdrawalIfStatus(withdrawal.id, expectedStatus, {
      status: 'failed',
      failure_reason: `Monime payout failed: ${payoutError.message}`
    });
    throw payoutError;
  }
}

/**
 * @param {string} id
 * @param {string} application
 */
export async function getWithdrawalStatus(id, application) {
  const { data, error } = await getWithdrawalRepo(id, application);

  if (error || !data) {
    throw createNotFoundError('Withdrawal not found');
  }

  return {
    id: data.id,
    status: data.status,
    amountUsdc: data.amount_usdc,
    amountSle: data.amount_sle,
    feeBps: data.fee_bps,
    exchangeRate: Number(data.exchange_rate),
    phoneNumber: data.phone_number,
    providerCode: data.provider_code,
    fromWalletAddress: data.from_wallet_address,
    treasuryAddress: getTreasuryAddress(),
    solanaTxSignature: data.solana_tx_signature,
    monimePayoutId: data.monime_payout_id,
    failureReason: data.failure_reason,
    expiresAt: data.expires_at,
    createdAt: data.created_at,
    updatedAt: data.updated_at
  };
}

/**
 * @param {string} application
 * @param {object} filters
 */
export async function getWithdrawals(application, filters) {
  const { data, error } = await listWithdrawalsRepo(application, filters);

  if (error) {
    throw createDatabaseError(`Failed to list withdrawals: ${error.message}`);
  }

  return data;
}
