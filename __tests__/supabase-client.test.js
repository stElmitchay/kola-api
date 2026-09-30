import { jest } from '@jest/globals';

describe('createSupabaseClient', () => {
  const OLD_ENV = process.env;
  beforeEach(() => { jest.resetModules(); process.env = { ...OLD_ENV }; });
  afterAll(() => { process.env = OLD_ENV; });

  test('throws when SUPABASE_SERVICE_ROLE_KEY is missing', async () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { createSupabaseClient } = await import('../src/utils/supabase.js');
    expect(() => createSupabaseClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  test('constructs a client with the service-role key', async () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
    const { createSupabaseClient } = await import('../src/utils/supabase.js');
    expect(createSupabaseClient()).toBeTruthy();
  });
});
