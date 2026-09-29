//@ts-check

/**
 * Global money pause. Set KOLA_PAUSE=1 in Vercel env + redeploy (or use
 * an env-group flip) to halt all state-changing traffic during an incident.
 * Webhooks get 503 (not 200) so providers redeliver after unpause.
 * @param {import('hono').Context} c
 * @param {Function} next
 */
export async function killSwitch(c, next) {
  if (process.env.KOLA_PAUSE === '1') {
    c.header('Retry-After', '300');
    return c.json({ error: 'Service temporarily paused for maintenance' }, 503);
  }
  await next();
}
