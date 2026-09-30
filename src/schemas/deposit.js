//@ts-check

import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';

// Derived wallets have no private key — USDC sent to them is permanently
// unspendable (F4). walletAddress must be a real, user-controlled Solana
// address from here on. Shared with src/schemas/withdrawal.js.
export const solanaAddress = z.string().refine((v) => {
  try { new PublicKey(v); return true; } catch { return false; }
}, 'walletAddress must be a valid Solana address');

export const createDepositSchema = z.object({
  amount: z.number().int().positive('Amount must be a positive integer (minor units)'),
  currency: z.literal('SLE'),
  paymentMethod: z.enum(['checkout', 'ussd']),
  phoneNumber: z.string().min(1, 'Phone number is required'),
  walletAddress: solanaAddress,          // REQUIRED — derived wallets are unspendable (F4)
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
  metadata: z.record(z.string()).optional()
}).refine(
  (data) => {
    if (data.paymentMethod === 'checkout') {
      return data.successUrl && data.cancelUrl;
    }
    return true;
  },
  { message: 'successUrl and cancelUrl are required for checkout payment method' }
);
