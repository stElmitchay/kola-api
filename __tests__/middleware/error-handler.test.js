import { jest } from '@jest/globals';
import { Hono } from 'hono';
import { z } from 'zod';

const captureException = jest.fn();

jest.unstable_mockModule('@sentry/node', () => ({
  init: jest.fn(),
  captureException
}));

const { errorHandler } = await import('../../src/middleware/error-handler.js');
const { createValidationError, createDatabaseError } = await import('../../src/utils/errors.js');
const { initSentry, __resetSentryForTests } = await import('../../src/utils/sentry.js');

function buildApp(handler) {
  const app = new Hono();
  app.use('/*', async (c, next) => {
    c.set('requestId', 'req-abc');
    await next();
  });
  app.get('/x', handler);
  app.onError(errorHandler);
  return app;
}

beforeEach(() => {
  captureException.mockClear();
  __resetSentryForTests();
});

test('a route throwing ValidationError → 400 with the envelope, no Sentry capture', async () => {
  const app = buildApp(() => { throw createValidationError('bad input'); });
  const res = await app.request('/x');

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: { code: 'ValidationError', message: 'bad input', request_id: 'req-abc' }
  });
  expect(captureException).not.toHaveBeenCalled();
});

test('an unknown error name → 500 InternalError, message hidden, request_id present', async () => {
  const app = buildApp(() => { throw new Error('something exploded'); });
  const res = await app.request('/x');

  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({
    error: { code: 'InternalError', message: 'Internal error', request_id: 'req-abc' }
  });
});

test('a zod .parse() throw maps to 400 ValidationError with a readable path+message', async () => {
  const schema = z.object({ amount: z.number() });
  const app = buildApp(async (c) => {
    schema.parse({ amount: 'not-a-number' });
    return c.json({ ok: true });
  });
  const res = await app.request('/x');

  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe('ValidationError');
  expect(body.error.message).toContain('amount');
  expect(body.error.request_id).toBe('req-abc');
});

test('Sentry captureError fires for a DatabaseError-mapped 500 (SENTRY_DSN set)', async () => {
  process.env.SENTRY_DSN = 'https://example.test/1';
  initSentry();

  const app = buildApp(() => { throw createDatabaseError('db exploded'); });
  const res = await app.request('/x');

  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({
    error: { code: 'DatabaseError', message: 'Internal error', request_id: 'req-abc' }
  });
  expect(captureException).toHaveBeenCalledTimes(1);

  delete process.env.SENTRY_DSN;
});

test('Sentry captureError does NOT fire for a ValidationError 400 (SENTRY_DSN set)', async () => {
  process.env.SENTRY_DSN = 'https://example.test/1';
  initSentry();

  const app = buildApp(() => { throw createValidationError('bad input'); });
  const res = await app.request('/x');

  expect(res.status).toBe(400);
  expect(captureException).not.toHaveBeenCalled();

  delete process.env.SENTRY_DSN;
});
