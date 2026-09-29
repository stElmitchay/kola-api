//@ts-check

import { createHash, timingSafeEqual } from 'crypto';

/**
 * Admin authentication middleware
 * Checks X-Admin-Key header against ADMIN_SECRET_KEY env var (constant-time compare)
 * @param {string} s
 */
const digest = (s) => createHash('sha256').update(s, 'utf8').digest();

/**
 * @param {import('hono').Context} c
 * @param {Function} next
 */
export async function adminAuth(c, next) {
  const adminKey = c.req.header('X-Admin-Key');
  const expected = process.env.ADMIN_SECRET_KEY;
  if (!adminKey || !expected) return c.json({ error: 'Missing admin key' }, 401);
  if (!timingSafeEqual(digest(adminKey), digest(expected))) {
    return c.json({ error: 'Invalid admin key' }, 401);
  }
  await next();
}
