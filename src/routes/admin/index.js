//@ts-check

import { Hono } from 'hono';
import { adminAuth } from '../../middleware/admin-auth.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { createApiKey, listApiKeys, deactivateApiKey } from './api-keys.js';
import { setExchangeRate, getExchangeRates } from './exchange-rates.js';
import { setExchangeRateSchema } from '../../schemas/exchange-rate.js';
import { listDeposits } from '../../repos/deposits.js';
import { listUnmatched } from '../../repos/unmatched-transfers.js';
import { getActiveRate } from '../../repos/exchange-rates.js';
import { writeAudit } from '../../repos/audit-log.js';

const app = new Hono();

app.use('/*', adminAuth);
app.onError(errorHandler);

/**
 * First hop of X-Forwarded-For, or null. Best-effort — this API sits
 * behind Vercel's edge, which sets this header itself.
 * @param {import('hono').Context} c
 */
const clientIp = (c) => c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null;

/**
 * writeAudit never throws by contract, but the call site guards it anyway
 * (C2): an audit write must never fail the admin action it describes.
 * @param {Parameters<typeof writeAudit>[0]} entry
 */
const audit = (entry) => writeAudit(entry).catch(() => {});

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

  const { key_hash: _keyHash, ...recordSansHash } = result.record || {};

  await audit({
    actor: c.get('adminActor'),
    action: 'api_key.create',
    resourceType: 'api_key',
    resourceId: result.record?.id,
    after: recordSansHash,
    ip: clientIp(c)
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
  const deactivated = await deactivateApiKey(id);

  await audit({
    actor: c.get('adminActor'),
    action: 'api_key.deactivate',
    resourceType: 'api_key',
    resourceId: id,
    before: { id, name: deactivated?.name, is_active: true },
    after: { is_active: false },
    ip: clientIp(c)
  });

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

  const actor = c.get('adminActor');
  const { data: previousRate } = await getActiveRate(applicationId);
  const rate = await setExchangeRate(applicationId, parsed.rate, actor, { force: parsed.force });

  await audit({
    actor,
    action: 'rate.set',
    resourceType: 'exchange_rate',
    resourceId: applicationId,
    before: { rate: previousRate ? previousRate.rate : null },
    after: { rate: rate.rate },
    ip: clientIp(c)
  });

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

// --- Deposits ---

app.get('/deposits', async (c) => {
  const applicationId = c.req.header('X-Application-Id');
  if (!applicationId) {
    return c.json({ error: 'X-Application-Id header is required' }, 400);
  }

  const filters = {};
  const status = c.req.query('status');
  const limit = c.req.query('limit');
  const offset = c.req.query('offset');

  if (status) filters.status = status;
  if (limit) filters.limit = parseInt(limit, 10);
  if (offset) filters.offset = parseInt(offset, 10);

  const { data, error } = await listDeposits(applicationId, filters);

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json(data);
});

// --- Unmatched Transfers (F11) ---

app.get('/unmatched-transfers', async (c) => {
  const filters = { status: c.req.query('status') || 'open' };
  const limit = c.req.query('limit');
  const offset = c.req.query('offset');

  if (limit) filters.limit = parseInt(limit, 10);
  if (offset) filters.offset = parseInt(offset, 10);

  const { data, error } = await listUnmatched(filters);

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json(data);
});

export default app;
