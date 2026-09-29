import { jest } from '@jest/globals';
import { Hono } from 'hono';

jest.unstable_mockModule('../../src/utils/logger.js', () => {
  const lines = [];
  const makeLogger = () => ({
    info: jest.fn((obj, msg) => lines.push({ ...obj, msg })),
    child: jest.fn(function (bindings) {
      const child = makeLogger();
      const originalInfo = child.info;
      child.info = jest.fn((obj, msg) => originalInfo({ ...bindings, ...obj }, msg));
      return child;
    })
  });
  const logger = makeLogger();
  return { logger, __lines: lines };
});

const { requestContext } = await import('../../src/middleware/request-context.js');
const { __lines } = await import('../../src/utils/logger.js');

beforeEach(() => {
  __lines.length = 0;
});

test('sets requestId + log in context, and emits one access-log line with route/method/status/latency', async () => {
  const app = new Hono();
  app.use('/*', requestContext);
  app.get('/x/:id', (c) => {
    expect(c.get('requestId')).toEqual(expect.any(String));
    expect(c.get('log')).toBeDefined();
    return c.json({ ok: true });
  });

  const res = await app.request('/x/42');
  expect(res.status).toBe(200);

  expect(__lines).toHaveLength(1);
  const line = __lines[0];
  expect(line.method).toBe('GET');
  expect(line.status).toBe(200);
  expect(typeof line.latency_ms).toBe('number');
  expect(line.request_id).toEqual(expect.any(String));
  expect(line.msg).toBe('request completed');
});
