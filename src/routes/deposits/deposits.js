//@ts-check

import BigNumber from 'bignumber.js';
import { validatePhoneNumber } from '../../utils/validation.js';
import { getTreasuryUsdcBalanceMinor } from '../../utils/solana.js';
import { createCheckoutSession, createPaymentCode } from '../../utils/monime.js';
import {
  createDeposit as createDepositRepo,
  getDeposit as getDepositRepo,
  listDeposits as listDepositsRepo,
  updateDeposit
} from '../../repos/deposits.js';
import { getActiveRate, assertRateFresh } from '../../repos/exchange-rates.js';
import { envInt } from '../../utils/config.js';
import {
  createValidationError,
  createNotFoundError,
  createDatabaseError
} from '../../utils/errors.js';

/**
 * Calculate USDC amount from SLE amount and exchange rate
 * USDC has 6 decimal places, so 1 USDC = 1_000_000 minor units
 * @param {number} amountSleMinor - SLE amount in minor units (cents)
 * @param {BigNumber} rate - SLE per 1 USDC (e.g., 25 means 25 SLE = 1 USDC)
 */
function calculateUsdcAmount(amountSleMinor, rate) {
  const sleAmount = new BigNumber(amountSleMinor).dividedBy(100);
  const usdcAmount = sleAmount.dividedBy(rate);
  const usdcMinorUnits = usdcAmount.multipliedBy(1_000_000).integerValue(BigNumber.ROUND_DOWN);
  return usdcMinorUnits.toNumber();
}

/**
 * Resolve wallet address — walletAddress is required (F4: derived wallets
 * have no private key, so USDC sent to them is permanently unspendable).
 * @param {string} walletAddress
 * @returns {{ address: string, type: 'provided' }}
 */
function resolveWalletAddress(walletAddress) {
  return { address: walletAddress, type: 'provided' };
}

/**
 * Create a new deposit — initiates the mobile money → USDC flow
 * @param {object} params
 * @param {number} params.amount
 * @param {string} params.currency
 * @param {string} params.paymentMethod
 * @param {string} params.phoneNumber
 * @param {string} params.walletAddress
 * @param {string} [params.successUrl]
 * @param {string} [params.cancelUrl]
 * @param {object} [params.metadata]
 * @param {string} params.application
 */
export async function initiateDeposit(params) {
  const { valid, normalized } = validatePhoneNumber(params.phoneNumber);
  if (!valid || !normalized) {
    throw createValidationError('Invalid Sierra Leone phone number');
  }

  const { data: rateData, error: rateError } = await getActiveRate(params.application);
  if (rateError || !rateData) {
    throw createValidationError('No active exchange rate configured. Admin must set a rate first.');
  }
  assertRateFresh(rateData);

  const maxSle = envInt('DEPOSIT_MAX_SLE');        // 5,000.00 SLE default
  const minSle = envInt('DEPOSIT_MIN_SLE');        // 1.00 SLE default
  if (params.amount > maxSle) {
    throw createValidationError(`Amount exceeds maximum (${maxSle} minor units)`);
  }
  if (params.amount < minSle) {
    throw createValidationError(`Amount below minimum (${minSle} minor units)`);
  }

  const rate = new BigNumber(rateData.rate);
  const amountUsdc = calculateUsdcAmount(params.amount, rate);

  if (amountUsdc <= 0) {
    throw createValidationError('Amount too small to convert to USDC');
  }

  const treasuryBalance = await getTreasuryUsdcBalanceMinor();
  if (treasuryBalance < BigInt(amountUsdc)) {
    // Never quote a deposit the treasury cannot settle. Generic message on
    // purpose: the exact float level is operational information.
    throw createValidationError('Deposits are temporarily unavailable. Please try again later.');
  }

  const wallet = resolveWalletAddress(params.walletAddress);

  const { data: deposit, error: depositError } = await createDepositRepo({
    application: params.application,
    phone_number: normalized,
    wallet_address: wallet.address,
    wallet_type: wallet.type,
    amount_sle: params.amount,
    amount_usdc: amountUsdc,
    exchange_rate: rateData.rate,
    payment_method: params.paymentMethod,
    metadata: params.metadata || {}
  });

  if (depositError || !deposit) {
    throw createDatabaseError(`Failed to create deposit: ${depositError?.message}`);
  }

  let paymentDetails;

  if (params.paymentMethod === 'checkout') {
    const session = await createCheckoutSession({
      depositId: deposit.id,
      amountMinorUnits: params.amount,
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
      metadata: { deposit_id: deposit.id }
    });

    paymentDetails = {
      redirectUrl: session.redirectUrl,
      expiresAt: session.expireTime
    };

    await updateDepositMonimeRef(deposit.id, session.id);
  } else {
    const paymentCode = await createPaymentCode({
      depositId: deposit.id,
      amountMinorUnits: params.amount,
      phoneNumber: normalized,
      metadata: { deposit_id: deposit.id }
    });

    paymentDetails = {
      ussdCode: paymentCode.ussdCode,
      expiresAt: paymentCode.expireTime
    };

    await updateDepositMonimeRef(deposit.id, paymentCode.id);
  }

  return {
    id: deposit.id,
    status: deposit.status,
    amountSle: deposit.amount_sle,
    amountUsdc: deposit.amount_usdc,
    exchangeRate: deposit.exchange_rate,
    walletAddress: deposit.wallet_address,
    walletType: deposit.wallet_type,
    paymentMethod: deposit.payment_method,
    ...paymentDetails
  };
}

/**
 * @param {string} depositId
 * @param {string} monimeResourceId
 */
async function updateDepositMonimeRef(depositId, monimeResourceId) {
  await updateDeposit(depositId, { monime_resource_id: monimeResourceId });
}

/**
 * Get deposit status
 * @param {string} id
 * @param {string} application
 */
export async function getDepositStatus(id, application) {
  const { data, error } = await getDepositRepo(id, application);

  if (error || !data) {
    throw createNotFoundError('Deposit not found');
  }

  return {
    id: data.id,
    status: data.status,
    amountSle: data.amount_sle,
    amountUsdc: data.amount_usdc,
    exchangeRate: data.exchange_rate,
    walletAddress: data.wallet_address,
    walletType: data.wallet_type,
    paymentMethod: data.payment_method,
    solanaTxSignature: data.solana_tx_signature,
    failureReason: data.failure_reason,
    createdAt: data.created_at,
    updatedAt: data.updated_at
  };
}

/**
 * List deposits for an application
 * @param {string} application
 * @param {object} filters
 */
export async function getDeposits(application, filters) {
  const { data, error } = await listDepositsRepo(application, filters);

  if (error) {
    throw createDatabaseError(`Failed to list deposits: ${error.message}`);
  }

  return data;
}
