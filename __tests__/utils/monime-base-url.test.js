//@ts-check

// Game days (D3) need to point outbound Monime calls at a local stand-in
// (e.g. `node -e 'require("http").createServer((q,s)=>{s.writeHead(500);s.end()}).listen(9999)'`)
// without touching real Monime traffic. This pins that MONIME_BASE_URL is
// live-read with the real API as the default and is actually honored by the
// request path (not just exported and unused).

import { jest } from '@jest/globals';

const { monimeBaseUrl, getProviders } = await import('../../src/utils/monime.js');

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

test('monimeBaseUrl defaults to the real Monime API when MONIME_BASE_URL is unset', () => {
  delete process.env.MONIME_BASE_URL;
  expect(monimeBaseUrl()).toBe('https://api.monime.io');
});

test('monimeBaseUrl returns MONIME_BASE_URL when set, and monimeRequest actually fetches it', async () => {
  process.env.MONIME_BASE_URL = 'http://127.0.0.1:9999';
  process.env.MONIME_ACCESS_TOKEN = 'token';
  process.env.MONIME_SPACE_ID = 'space';
  expect(monimeBaseUrl()).toBe('http://127.0.0.1:9999');

  const realFetch = globalThis.fetch;
  const fetchMock = jest.fn().mockResolvedValue(
    new Response(JSON.stringify({ result: [] }), { status: 200 })
  );
  globalThis.fetch = fetchMock;
  try {
    await getProviders();
  } finally {
    globalThis.fetch = realFetch;
  }

  expect(fetchMock).toHaveBeenCalledWith(
    'http://127.0.0.1:9999/v1/momos?country=SL',
    expect.any(Object)
  );
});
