//@ts-check

import { Hono } from 'hono';
import { verifyHeliusAuth } from '../../utils/helius.js';
import { handleHeliusEvent } from './helius-handler.js';
import { errorEnvelope } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

const app = new Hono();

app.post('/', async (c) => {
  const authHeader = c.req.header('Authorization') || '';
  const log = c.get('log') || logger;
  if (!verifyHeliusAuth(authHeader)) {
    log.error('[Helius] Invalid auth header');
    return c.json(errorEnvelope('Unauthorized', 'Invalid auth', c.get('requestId')), 401);
  }

  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    log.error(`[Helius] Failed to parse body: ${e.message}`);
    return c.json(errorEnvelope('ValidationError', 'Invalid JSON', c.get('requestId')), 400);
  }

  const events = Array.isArray(body) ? body : [body];
  const result = await handleHeliusEvent(events);
  return c.json(result);
});

export default app;
