import { jest } from '@jest/globals';
import { Hono } from 'hono';

const APP_ID = '11111111-1111-1111-1111-111111111111';

const limitMock = jest.fn();

class MockRatelimit {
  constructor(opts) {
    this.opts = opts;
  }
  limit(...args) {
    return limitMock(...args);
  }
  static slidingWindow(...args) {
    return { type: 'sliding-window', args };
  }
}

const fromEnvMock = jest.fn(() => ({ mock: 'redis-client' }));
const loggerWarn = jest.fn();
const loggerError = jest.fn();

jest.unstable_mockModule('@upstash/ratelimit', () => ({
  Ratelimit: MockRatelimit
}));

jest.unstable_mockModule('@upstash/redis', () => ({
  Redis: { fromEnv: fromEnvMock }
}));

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  logger: {
    warn: loggerWarn,
    error: loggerError,
    info: jest.fn(),
    child: () => ({ warn: loggerWarn, error: loggerError, info: jest.fn() })
  }
}));

const { rateLimit } = await import('../../src/middleware/rate-limit.js');

function buildApp(rateLimitValue) {
  const app = new Hono();
  app.use('/*', async (c, next) => {
    c.set('application', APP_ID);
    if (rateLimitValue !== undefined) c.set('rateLimit', rateLimitValue);
    await next();
  });
  app.use('/*', rateLimit);
  app.get('/x', (c) => c.json({ ok: true }));
  return app;
}

beforeEach(() => {
  limitMock.mockReset();
  fromEnvMock.mockClear();
  loggerWarn.mockClear();
  loggerError.mockClear();
});

describe('with Upstash env configured', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, UPSTASH_REDIS_REST_URL: 'https://example.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'token' };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  test('(a) limited → 429 with all three X-RateLimit headers and Retry-After >= 1', async () => {
    const reset = Date.now() + 30_000;
    limitMock.mockResolvedValue({ success: false, limit: 60, remaining: 0, reset });

    const app = buildApp(60);
    const res = await app.request('/x');

    expect(res.status).toBe(429);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(res.headers.get('X-RateLimit-Reset')).toBe(String(Math.ceil(reset / 1000)));
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(await res.json()).toEqual({
      error: { code: 'RateLimited', message: 'Rate limit exceeded', request_id: null }
    });
  });

  test('(b) allowed → passes through with headers set', async () => {
    const reset = Date.now() + 60_000;
    limitMock.mockResolvedValue({ success: true, limit: 60, remaining: 42, reset });

    const app = buildApp(60);
    const res = await app.request('/x');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('42');
    expect(res.headers.get('X-RateLimit-Reset')).toBe(String(Math.ceil(reset / 1000)));
  });

  test('(c) limiter throws → passes through (fail-open) and logs via logger.error', async () => {
    limitMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const app = buildApp(60);
    const res = await app.request('/x');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(loggerError).toHaveBeenCalled();
  });
});

describe('without Upstash env configured', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  test('(d) missing UPSTASH env → passes through with warn, no throw on import', async () => {
    const app = buildApp(60);
    const res = await app.request('/x');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(limitMock).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalled();
  });
});
