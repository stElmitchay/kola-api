//@ts-check

/**
 * Admin authentication middleware
 * Checks X-Admin-Key header against ADMIN_SECRET_KEY env var
 * @param {import('hono').Context} c
 * @param {Function} next
 */
export async function adminAuth(c, next) {
  const adminKey = c.req.header('X-Admin-Key');

  if (!adminKey) {
    return c.json({ error: 'Missing admin key' }, 401);
  }

  if (adminKey !== process.env.ADMIN_SECRET_KEY) {
    return c.json({ error: 'Invalid admin key' }, 401);
  }

  await next();
}
