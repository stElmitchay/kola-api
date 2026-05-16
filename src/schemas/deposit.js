//@ts-check

import { z } from 'zod';

export const createDepositSchema = z.object({
  amount: z.number().int().positive('Amount must be a positive integer (minor units)'),
  currency: z.literal('SLE'),
  paymentMethod: z.enum(['checkout', 'ussd']),
  phoneNumber: z.string().min(1, 'Phone number is required'),
  walletAddress: z.string().optional(),
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
