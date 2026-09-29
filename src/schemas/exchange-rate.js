//@ts-check

import { z } from 'zod';

export const setExchangeRateSchema = z.object({
  rate: z.number().positive('Rate must be a positive number'),
  // Deprecated (C2): kept for wire-compat with existing clients, but the
  // route ignores this in favour of the authenticated admin key's name
  // (c.get('adminActor')) as the actor of record. Safe to stop sending.
  setBy: z.string().min(1, 'setBy identifier is required').optional(),
  force: z.boolean().optional()
});
