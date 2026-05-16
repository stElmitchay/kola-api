//@ts-check

import { Hono } from 'hono';
import { getProviders } from '../../utils/monime.js';
import { getActiveRate } from '../../repos/exchange-rates.js';

const app = new Hono();

app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'kola-api', version: '1.0.0' });
});

app.get('/providers', async (c) => {
  const providers = await getProviders();
  return c.json(providers);
});

app.get('/rate', async (c) => {
  const applicationId = c.req.query('application');

  if (!applicationId) {
    return c.json({ error: 'application query parameter is required' }, 400);
  }

  const { data, error } = await getActiveRate(applicationId);

  if (error || !data) {
    return c.json({ error: 'No active exchange rate found' }, 404);
  }

  return c.json({
    baseCurrency: 'SLE',
    quoteCurrency: 'USDC',
    rate: data.rate,
    updatedAt: data.created_at
  });
});

export default app;
