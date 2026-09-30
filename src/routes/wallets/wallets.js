//@ts-check

import { getUsdcBalance } from '../../utils/solana.js';

/**
 * Fetch USDC balance for a wallet address
 * @param {string} walletAddress
 */
export async function fetchWalletBalance(walletAddress) {
  return getUsdcBalance(walletAddress);
}
