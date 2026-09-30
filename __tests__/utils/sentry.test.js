import { jest } from '@jest/globals';

const init = jest.fn();
const captureException = jest.fn();

jest.unstable_mockModule('@sentry/node', () => ({ init, captureException }));

const { initSentry, captureError, __resetSentryForTests } = await import('../../src/utils/sentry.js');

beforeEach(() => {
  init.mockClear();
  captureException.mockClear();
  __resetSentryForTests();
  delete process.env.SENTRY_DSN;
});

test('initSentry is a no-op when SENTRY_DSN is unset, and captureError never calls Sentry', () => {
  initSentry();
  expect(init).not.toHaveBeenCalled();

  captureError(new Error('boom'), { foo: 'bar' });
  expect(captureException).not.toHaveBeenCalled();
});

test('initSentry initializes Sentry when SENTRY_DSN is set, and captureError forwards to it', () => {
  process.env.SENTRY_DSN = 'https://example.test/1';
  initSentry();
  expect(init).toHaveBeenCalledWith({ dsn: 'https://example.test/1' });

  const err = new Error('boom');
  captureError(err, { request_id: 'r1' });
  expect(captureException).toHaveBeenCalledWith(err, { extra: { request_id: 'r1' } });
});
