//@ts-check

import { createHash, timingSafeEqual } from 'crypto';
import { errorEnvelope } from '../utils/errors.js';

/**
 * Admin authentication middleware. Checks X-Admin-Key against named keys
 * in ADMIN_KEYS (format: "name1:secret1,name2:secret2") so every admin
 * action can be attributed to the key that made it (F12/F14) — the
 * matching name is set as `adminActor` in the Hono context for downstream
 * audit-log writes. Falls back to the legacy single ADMIN_SECRET_KEY,
 * attributed to actor 'legacy', during a one-release migration window;
 * delete ADMIN_SECRET_KEY support once every operator has a named key.
 * @param {string} s
 */
const digest = (s) => createHash('sha256').update(s, 'utf8').digest();

/**
 * Parse ADMIN_KEYS into [{name, secret}] pairs. Parsed fresh on every
 * request — never cached at module scope — since env vars can change
 * between invocations on serverless.
 * @param {string|undefined} raw
 * @returns {{name: string, secret: string}[]}
 */
function parseAdminKeys(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((pair) => {
      const idx = pair.indexOf(':');
      if (idx === -1) return null;
      const name = pair.slice(0, idx).trim();
      const secret = pair.slice(idx + 1).trim();
      return name && secret ? { name, secret } : null;
    })
    .filter((entry) => entry !== null);
}

/**
 * @param {import('hono').Context} c
 * @param {Function} next
 */
export async function adminAuth(c, next) {
  const adminKey = c.req.header('X-Admin-Key');
  const candidates = parseAdminKeys(process.env.ADMIN_KEYS);
  const legacySecret = process.env.ADMIN_SECRET_KEY;

  if (!adminKey || (candidates.length === 0 && !legacySecret)) {
    return c.json(errorEnvelope('Unauthorized', 'Missing admin key', c.get('requestId')), 401);
  }

  const provided = digest(adminKey);

  for (const { name, secret } of candidates) {
    if (timingSafeEqual(provided, digest(secret))) {
      c.set('adminActor', name);
      await next();
      return;
    }
  }

  if (legacySecret && timingSafeEqual(provided, digest(legacySecret))) {
    c.set('adminActor', 'legacy');
    await next();
    return;
  }

  return c.json(errorEnvelope('Unauthorized', 'Invalid admin key', c.get('requestId')), 401);
}
