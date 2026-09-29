import { jest } from '@jest/globals';
import { Hono } from 'hono';

jest.unstable_mockModule('../../src/utils/supabase.js', () => ({
  createSupabaseClient: () => ({ from: jest.fn() })
}));
const { apiKeyAuth } = await import('../../src/middleware/api-key-auth.js');
const { adminAuth } = await import('../../src/middleware/admin-auth.js');

test('api_key query parameter is no longer accepted', async () => {
  const app = new Hono();
  app.use('/*', apiKeyAuth);
  app.get('/x', (c) => c.json({ ok: true }));
  const res = await app.request('/x?api_key=kola_abc');
  expect(res.status).toBe(401); // must be treated as missing, not looked up
});

test('adminAuth rejects wrong keys and accepts the right one (timing-safe path)', async () => {
  process.env.ADMIN_SECRET_KEY = 'correct-horse';
  const app = new Hono();
  app.use('/*', adminAuth);
  app.get('/x', (c) => c.json({ ok: true }));
  expect((await app.request('/x', { headers: { 'X-Admin-Key': 'wrong' } })).status).toBe(401);
  expect((await app.request('/x', { headers: { 'X-Admin-Key': 'correct-horse' } })).status).toBe(200);
});
