//@ts-check

import { deriveWalletFromPhone, getUsdcBalance } from '../../utils/solana.js';
import { validatePhoneNumber } from '../../utils/validation.js';
import { getWalletByPhone, createWallet } from '../../repos/wallets.js';
import { createValidationError, createDatabaseError } from '../../utils/errors.js';

/**
 * Derive a wallet address from a phone number
 * Returns existing wallet if already derived, otherwise creates a new one
 * @param {string} phoneNumber
 * @param {string} application
 * @returns {Promise<{ address: string, isNew: boolean }>}
 */
export async function deriveWallet(phoneNumber, application) {
  const { valid, normalized } = validatePhoneNumber(phoneNumber);
  if (!valid || !normalized) {
    throw createValidationError('Invalid Sierra Leone phone number');
  }

  const { data: existing } = await getWalletByPhone(normalized, application);
  if (existing) {
    return { address: existing.wallet_address, isNew: false };
  }

  const { address } = await deriveWalletFromPhone(normalized);

  const { error } = await createWallet({
    phone_number: normalized,
    wallet_address: address,
    application
  });

  if (error) {
    throw createDatabaseError(`Failed to store derived wallet: ${error.message}`);
  }

  return { address, isNew: true };
}

/**
 * Fetch USDC balance for a wallet address
 * @param {string} walletAddress
 */
export async function fetchWalletBalance(walletAddress) {
  return getUsdcBalance(walletAddress);
}
