//@ts-check

import { createSupabaseClient } from '../utils/supabase.js';

const supabase = createSupabaseClient();

/**
 * Get a derived wallet by phone number
 * @param {string} phoneNumber
 * @param {string} application
 */
export async function getWalletByPhone(phoneNumber, application) {
  const { data, error } = await supabase
    .from('derived_wallets')
    .select('*')
    .eq('phone_number', phoneNumber)
    .eq('application', application)
    .single();

  return { data, error };
}

/**
 * Create a derived wallet record
 * @param {object} wallet
 * @param {string} wallet.phone_number
 * @param {string} wallet.wallet_address
 * @param {string} wallet.application
 */
export async function createWallet(wallet) {
  const { data, error } = await supabase
    .from('derived_wallets')
    .insert(wallet)
    .select()
    .single();

  return { data, error };
}
