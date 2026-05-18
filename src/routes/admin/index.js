//@ts-check

import { Hono } from 'hono';
import { adminAuth } from '../../middleware/admin-auth.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { createApiKey, listApiKeys, deactivateApiKey } from './api-keys.js';
import { setExchangeRate, getExchangeRates } from './exchange-rates.js';
import { setExchangeRateSchema } from '../../schemas/exchange-rate.js';

const app = new Hono();

app.use('/*', adminAuth);
app.onError(errorHandler);

// --- API Keys ---

app.post('/api-keys', async (c) => {
  const body = await c.req.json();
  const result = await createApiKey({
    name: body.name,
    businessName: body.businessName,
    appName: body.appName,
    clientId: body.clientId,
    expiresAt: body.expiresAt,
    permissions: body.permissions,
    rateLimit: body.rateLimit
  });

  return c.json({
    message: 'API key created. Store this key securely — it will not be shown again.',
    apiKey: result.apiKey,
    application: result.record
  }, 201);
});

app.get('/api-keys', async (c) => {
  const keys = await listApiKeys();
  return c.json(keys);
});

app.delete('/api-keys/:id', async (c) => {
  const id = c.req.param('id');
  await deactivateApiKey(id);
  return c.json({ message: 'API key deactivated' });
});

// --- Exchange Rates ---

app.put('/exchange-rates', async (c) => {
  const body = await c.req.json();
  const parsed = setExchangeRateSchema.parse(body);

  const applicationId = c.req.header('X-Application-Id');
  if (!applicationId) {
    return c.json({ error: 'X-Application-Id header is required' }, 400);
  }

  const rate = await setExchangeRate(applicationId, parsed.rate, parsed.setBy);

  return c.json({
    message: 'Exchange rate updated',
    rate
  });
});

app.get('/exchange-rates', async (c) => {
  const applicationId = c.req.header('X-Application-Id');
  if (!applicationId) {
    return c.json({ error: 'X-Application-Id header is required' }, 400);
  }

  const rates = await getExchangeRates(applicationId);
  return c.json(rates);
});

export default app;
