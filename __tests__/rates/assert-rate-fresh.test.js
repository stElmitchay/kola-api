// Pure-function test against the real repos/exchange-rates.js module — kept
// out of rate-guards.test.js, which mocks that same module path (see report
// for why the two can't share a file under ESM module mocking). Only
// utils/supabase.js is stubbed here, purely so the module's top-level
// createSupabaseClient() call doesn't throw for missing env vars.
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../src/utils/supabase.js', () => ({
  createSupabaseClient: () => ({ rpc: jest.fn(), from: jest.fn() })
}));

const { assertRateFresh } = await import('../../src/repos/exchange-rates.js');

test('assertRateFresh rejects a rate older than RATE_MAX_AGE_MINUTES', () => {
  process.env.RATE_MAX_AGE_MINUTES = '1440';
  const stale = { rate: '25', created_at: new Date(Date.now() - 25 * 3600_000).toISOString() };
  expect(() => assertRateFresh(stale)).toThrow(/stale/i);
  const fresh = { rate: '25', created_at: new Date().toISOString() };
  expect(() => assertRateFresh(fresh)).not.toThrow();
});
