//@ts-check

import { Hono } from 'hono';
import { handle } from '@hono/node-server/vercel';
import { cors } from 'hono/cors';

import publicEndpoints from '../src/routes/public/index.js';
import admin from '../src/routes/admin/index.js';
import wallets from '../src/routes/wallets/index.js';
import deposits from '../src/routes/deposits/index.js';
import monimeWebhook from '../src/routes/webhooks/monime.js';

const app = new Hono().basePath('/api');

app.use('/*', cors());

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

// Webhook routes (signature verified)
app.route('/webhooks/monime', monimeWebhook);

// Global fallback error handler
app.onError((err, c) => {
  console.error(`[Global Error] ${err.message}`);
  return c.json({ success: false, message: 'Internal server error' }, 500);
});

app.notFound((c) => {
  return c.json({ success: false, message: 'Not found' }, 404);
});

export default handle(app);
