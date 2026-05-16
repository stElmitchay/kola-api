//@ts-check

import { z } from 'zod';

export const deriveWalletSchema = z.object({
  phoneNumber: z.string().min(1, 'Phone number is required')
});
