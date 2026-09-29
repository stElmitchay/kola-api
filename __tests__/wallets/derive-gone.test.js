import { jest } from '@jest/globals';

// F4: derived wallets have no private key. This route is discontinued —
// mock auth so the test hits the handler directly without a real API key.
jest.unstable_mockModule('../../src/middleware/api-key-auth.js', () => ({
  apiKeyAuth: async (c, next) => {
    c.set('application', 'app-1');
    await next();
  }
}));
const walletsApp = (await import('../../src/routes/wallets/index.js')).default;

test('POST /v1/wallets/derive returns 410 Gone', async () => {
  const res = await walletsApp.request('/derive', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': 'irrelevant' },
    body: JSON.stringify({ phoneNumber: '+23276123456' })
  });

  expect(res.status).toBe(410);
  expect(await res.json()).toEqual({
    error: {
      code: 'Gone',
      message: 'Derived wallets are discontinued. Supply walletAddress on deposit.',
      request_id: null
    }
  });
});
