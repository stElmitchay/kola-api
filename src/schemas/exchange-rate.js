//@ts-check

import { z } from 'zod';

export const setExchangeRateSchema = z.object({
  rate: z.number().positive('Rate must be a positive number'),
  setBy: z.string().min(1, 'setBy identifier is required')
});
