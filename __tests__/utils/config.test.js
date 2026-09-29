import { jest } from '@jest/globals';

const { validateConfig, envInt, envStr, REQUIRED_VARS, __resetConfigForTests } =
  await import('../../src/utils/config.js');

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  __resetConfigForTests();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  __resetConfigForTests();
});

test('validateConfig throws ONE error listing every missing required var', () => {
  process.env = { ...ORIGINAL_ENV };
  for (const name of REQUIRED_VARS) delete process.env[name];

  expect(() => validateConfig()).toThrow();
  try {
    validateConfig();
  } catch (e) {
    for (const name of REQUIRED_VARS) {
      expect(e.message).toContain(name);
    }
  }
});

test('validateConfig passes and caches when every required var is set', () => {
  process.env = { ...ORIGINAL_ENV };
  for (const name of REQUIRED_VARS) process.env[name] = 'x';

  expect(() => validateConfig()).not.toThrow();

  // Cached: deleting a var after the first successful call must not
  // retroactively throw on a second call (validates on FIRST call only).
  delete process.env[REQUIRED_VARS[0]];
  expect(() => validateConfig()).not.toThrow();
});

test('envInt returns the default when unset, and the parsed value when set', () => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.WITHDRAWAL_FEE_BPS;
  expect(envInt('WITHDRAWAL_FEE_BPS')).toBe(100);

  process.env.WITHDRAWAL_FEE_BPS = '250';
  expect(envInt('WITHDRAWAL_FEE_BPS')).toBe(250);
});

test('envStr returns the fallback when unset, and the raw value when set', () => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.SENTRY_DSN;
  expect(envStr('SENTRY_DSN', 'fallback')).toBe('fallback');

  process.env.SENTRY_DSN = 'https://example';
  expect(envStr('SENTRY_DSN', 'fallback')).toBe('https://example');
});
