//@ts-check

import { Hono } from 'hono';
import { verifyHeliusAuth } from '../../utils/helius.js';
import { handleHeliusEvent } from './helius-handler.js';

const app = new Hono();

app.post('/', async (c) => {
  const authHeader = c.req.header('Authorization') || '';
  if (!verifyHeliusAuth(authHeader)) {
    console.error('[Helius] Invalid auth header');
    return c.json({ error: 'Invalid auth' }, 401);
  }

  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    console.error(`[Helius] Failed to parse body: ${e.message}`);
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const events = Array.isArray(body) ? body : [body];
  const result = await handleHeliusEvent(events);
  return c.json(result);
});

export default app;
