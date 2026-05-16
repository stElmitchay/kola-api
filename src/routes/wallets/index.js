//@ts-check

import { Hono } from 'hono';
import { apiKeyAuth } from '../../middleware/api-key-auth.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { deriveWalletSchema } from '../../schemas/wallet.js';
import { deriveWallet, fetchWalletBalance } from './wallets.js';

const app = new Hono();

app.use('/*', apiKeyAuth);
app.onError(errorHandler);

app.post('/derive', async (c) => {
  const body = await c.req.json();
  const parsed = deriveWalletSchema.parse(body);
  const application = c.get('application');

  const result = await deriveWallet(parsed.phoneNumber, application);

  return c.json({
    walletAddress: result.address,
    isNew: result.isNew,
    phoneNumber: parsed.phoneNumber
  }, result.isNew ? 201 : 200);
});

app.get('/:address/balance', async (c) => {
  const address = c.req.param('address');
  const { balance, rawBalance } = await fetchWalletBalance(address);

  return c.json({
    walletAddress: address,
    balance,
    rawBalance,
    currency: 'USDC'
  });
});

export default app;
