//@ts-check

import { Hono } from 'hono';
import { handle } from '@hono/node-server/vercel';
import { cors } from 'hono/cors';
import { ZodError } from 'zod';

import { killSwitch } from '../src/middleware/kill-switch.js';
import { requestContext } from '../src/middleware/request-context.js';
import { logger } from '../src/utils/logger.js';
import { validateConfig } from '../src/utils/config.js';
import { initSentry, captureError } from '../src/utils/sentry.js';
import { errorEnvelope, zodErrorMessage } from '../src/utils/errors.js';

// Startup gate: fail fast and loudly on a missing required var rather than
// crashing deep inside a request handler later. Logged loudly (not just
// thrown) because a serverless cold-start crash can otherwise vanish
// without a stack trace reaching anywhere an operator will see it.
try {
  validateConfig();
  initSentry();
} catch (err) {
  logger.error({ err, alert: true }, `[Startup] config validation failed: ${err.message}`);
  throw err;
}

// Route modules are imported dynamically, AFTER the startup gate above —
// several of them (via src/repos/*.js) call createSupabaseClient() at
// module-load time. A static `import` at the top of this file would
// resolve the whole import graph — including those module-load-time calls
// — before any of this file's own top-level code runs (ESM evaluates
// imports before the importing module's body), which would surface
// Supabase's single-var error instead of validateConfig()'s aggregated
// "every missing var" message. Deferring these imports until after the
// gate makes the gate actually gate.
const { default: publicEndpoints } = await import('../src/routes/public/index.js');
const { default: admin } = await import('../src/routes/admin/index.js');
const { default: wallets } = await import('../src/routes/wallets/index.js');
const { default: deposits } = await import('../src/routes/deposits/index.js');
const { default: withdrawals } = await import('../src/routes/withdrawals/index.js');
const { default: monimeWebhook } = await import('../src/routes/webhooks/monime.js');
const { default: heliusWebhook } = await import('../src/routes/webhooks/helius.js');
const { default: transferTick } = await import('../src/routes/internal/transfer-tick.js');
const { default: reconcileTick } = await import('../src/routes/internal/reconcile-tick.js');

const app = new Hono().basePath('/api');

// Mounted FIRST so every request — including ones rejected by the kill
// switch, auth, or rate limiting — gets a request id and an access-log line.
app.use('/*', requestContext);

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
// KOLA_PAUSE must also stop the transfer worker from broadcasting during an
// incident; a 503 to the cron invoker is harmless — it just retries next tick.
app.use('/internal/*', killSwitch);

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

// Internal cron workers (CRON_SECRET auth, not an admin/API-key route)
app.route('/internal/transfer-tick', transferTick);
app.route('/internal/reconcile-tick', reconcileTick);

// Global fallback error handler — catches anything not already handled by
// a sub-app's own `errorHandler` (webhooks, internal cron routes, and any
// middleware-level throw). Same envelope as errorHandler.js.
app.onError((err, c) => {
  const requestId = c.get('requestId');
  const log = c.get('log') || logger;

  if (err instanceof ZodError) {
    const message = zodErrorMessage(err);
    log.warn({ err }, `[ValidationError] ${message}`);
    return c.json(errorEnvelope('ValidationError', message, requestId), 400);
  }

  log.error({ err, alert: true }, `[Global Error] ${err.message}`);
  captureError(err, { request_id: requestId, route: c.req.routePath });
  return c.json(errorEnvelope('InternalError', 'Internal error', requestId), 500);
});

app.notFound((c) => {
  const requestId = c.get('requestId');
  return c.json(errorEnvelope('NotFoundError', 'Not found', requestId), 404);
});

// The raw Hono instance, exported for the integration suite
// (`__tests__/integration/*`), which drives the SAME mounted routers,
// middleware stack, CORS config and error handlers through
// `app.request()` instead of an HTTP socket. Exporting the instance rather
// than rebuilding an equivalent app in the harness is the point: a route
// that is mounted here but forgotten in a test-only app would otherwise go
// untested. Nothing in production reads this export.
export { app };

export default handle(app);
