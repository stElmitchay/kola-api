//@ts-check

import { Hono } from 'hono';
import { handle } from '@hono/node-server/vercel';
import { cors } from 'hono/cors';

import publicEndpoints from '../src/routes/public/index.js';
import admin from '../src/routes/admin/index.js';
import wallets from '../src/routes/wallets/index.js';
import deposits from '../src/routes/deposits/index.js';
import withdrawals from '../src/routes/withdrawals/index.js';
import monimeWebhook from '../src/routes/webhooks/monime.js';
import heliusWebhook from '../src/routes/webhooks/helius.js';
import transferTick from '../src/routes/internal/transfer-tick.js';
import { killSwitch } from '../src/middleware/kill-switch.js';

const app = new Hono().basePath('/api');

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use('/*', cors({
  origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
  allowHeaders: ['Content-Type', 'X-API-Key', 'X-Admin-Key', 'X-Application-Id', 'Idempotency-Key'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

app.use('/v1/deposits/*', killSwitch);
app.use('/v1/withdrawals/*', killSwitch);
app.use('/webhooks/*', killSwitch);

app.get('/', (c) => {
  return c.json({
    name: 'kola-api',
    description: 'Mobile Money (SLE) to USDC on-ramp API',
    version: '1.0.0'
  });
});

// Public routes (no auth)
app.route('/v1/public', publicEndpoints);

// Admin routes (admin key auth)
app.route('/v1/admin', admin);

// Wallet routes (API key auth)
app.route('/v1/wallets', wallets);

// Deposit routes (API key auth)
app.route('/v1/deposits', deposits);

// Withdrawal routes (API key auth)
app.route('/v1/withdrawals', withdrawals);

// Webhook routes (signature verified)
app.route('/webhooks/monime', monimeWebhook);
app.route('/webhooks/helius', heliusWebhook);

// Internal cron worker (CRON_SECRET auth, not an admin/API-key route)
app.route('/internal/transfer-tick', transferTick);

// Global fallback error handler
app.onError((err, c) => {
  console.error(`[Global Error] ${err.message}`);
  return c.json({ success: false, message: err.message }, 500);
});

app.notFound((c) => {
  return c.json({ success: false, message: 'Not found' }, 404);
});

export default handle(app);
