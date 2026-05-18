//@ts-check

import { z } from 'zod';

export const createWithdrawalSchema = z.object({
  amountUsdc: z.number().int().positive('amountUsdc must be a positive integer (minor units, 1 USDC = 1_000_000)'),
  phoneNumber: z.string().min(1, 'Phone number is required'),
  providerCode: z.string().min(1, 'providerCode is required (e.g. m17 for Orange Money)'),
  fromWalletAddress: z.string().min(32, 'fromWalletAddress must be a valid Solana address'),
  metadata: z.record(z.string()).optional()
});

export const confirmWithdrawalSchema = z.object({
  solanaTxSignature: z.string().min(64, 'solanaTxSignature must be a valid Solana transaction signature')
});
