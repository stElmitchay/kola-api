//@ts-check
import { timingSafeEqual, createHash } from 'crypto';

const digest = (s) => createHash('sha256').update(s, 'utf8').digest();

/**
 * Constant-time compare against CRON_SECRET. Fails closed (returns false,
 * never throws) when either side is empty.
 * @param {string} got
 */
function matchesCronSecret(got) {
  const expected = process.env.CRON_SECRET;
  if (!got || !expected) return false;
  return timingSafeEqual(digest(got), digest(expected));
}

/**
 * Shared cron-auth guard for internal tick routes (transfer-tick,
 * reconcile-tick). Vercel cron sends `Authorization: Bearer $CRON_SECRET`;
 * an operator or manual trigger may instead send `X-Cron-Secret`. Either is
 * accepted.
 * @param {import('hono').Context} c
 * @returns {boolean}
 */
export function verifyCronAuth(c) {
  const bearer = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '');
  const cronHeader = c.req.header('X-Cron-Secret') || '';
  return matchesCronSecret(bearer) || matchesCronSecret(cronHeader);
}
