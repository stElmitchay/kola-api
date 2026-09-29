import { Hono } from 'hono';
const { killSwitch } = await import('../../src/middleware/kill-switch.js');

afterEach(() => {
  delete process.env.KOLA_PAUSE;
});

test('returns 503 with Retry-After when KOLA_PAUSE=1', async () => {
  process.env.KOLA_PAUSE = '1';
  const app = new Hono();
  app.use('/*', killSwitch);
  app.post('/x', (c) => c.json({ ok: true }));
  const res = await app.request('/x', { method: 'POST' });
  expect(res.status).toBe(503);
  expect(res.headers.get('Retry-After')).toBe('300');

  const body = await res.json();
  expect(body.error.code).toBe('ServiceUnavailable');
  expect(typeof body.error.message).toBe('string');
});

test('passes through when unset', async () => {
  delete process.env.KOLA_PAUSE;
  const app = new Hono();
  app.use('/*', killSwitch);
  app.post('/x', (c) => c.json({ ok: true }));
  expect((await app.request('/x', { method: 'POST' })).status).toBe(200);
});
