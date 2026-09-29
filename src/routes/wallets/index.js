//@ts-check

import { Hono } from 'hono';
import { apiKeyAuth } from '../../middleware/api-key-auth.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { fetchWalletBalance } from './wallets.js';

const app = new Hono();

app.use('/*', apiKeyAuth);
app.onError(errorHandler);

// F4: phone-derived addresses have no private key — USDC sent to them is
// permanently unspendable. Discontinued; see docs/decisions/0001-derived-wallets.md.
app.post('/derive', async (c) => {
  return c.json({ error: 'Derived wallets are discontinued. Supply walletAddress on deposit.' }, 410);
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
