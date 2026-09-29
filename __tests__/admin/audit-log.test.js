import { jest } from '@jest/globals';

// routes/admin/index.js also imports repos/deposits.js and
// repos/unmatched-transfers.js directly (unrelated to this test) — both
// instantiate a Supabase client at module load, so these must be set
// before the dynamic import below even though nothing here talks to them.
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const getActiveRate = jest.fn();
const setRate = jest.fn();
const getRateHistory = jest.fn();
const createApiKey = jest.fn();
const listApiKeys = jest.fn();
const deactivateApiKey = jest.fn();
const writeAudit = jest.fn();

jest.unstable_mockModule('../../src/repos/exchange-rates.js', () => ({
  getActiveRate,
  setRate,
  getRateHistory
}));

jest.unstable_mockModule('../../src/repos/api-keys.js', () => ({
  createApiKey,
  listApiKeys,
  deactivateApiKey
}));

jest.unstable_mockModule('../../src/repos/audit-log.js', () => ({
  writeAudit
}));

const { default: adminApp } = await import('../../src/routes/admin/index.js');

beforeEach(() => {
  jest.clearAllMocks();
  writeAudit.mockResolvedValue(undefined);
  process.env.ADMIN_KEYS = 'mitchel:mitchel-secret,ops2:ops2-secret';
  process.env.ADMIN_SECRET_KEY = 'legacy-secret';
  process.env.RATE_MAX_MOVE_BPS = '500';
});

afterEach(() => {
  delete process.env.ADMIN_KEYS;
  delete process.env.ADMIN_SECRET_KEY;
});

test('named admin key "mitchel" authenticates and rate.set audit row carries actor + before/after rates', async () => {
  getActiveRate.mockResolvedValue({ data: { rate: '25', created_at: new Date().toISOString() }, error: null });
  setRate.mockResolvedValue({ data: { rate: '26' }, error: null });

  const res = await adminApp.request('/exchange-rates', {
    method: 'PUT',
    headers: {
      'X-Admin-Key': 'mitchel-secret',
      'X-Application-Id': 'app-1',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ rate: 26, setBy: 'whoever-the-client-sends' })
  });

  expect(res.status).toBe(200);
  // the RPC call must carry the authenticated actor, not the client's setBy field
  expect(setRate).toHaveBeenCalledWith('app-1', 26, 'mitchel');
  expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({
    actor: 'mitchel',
    action: 'rate.set',
    before: { rate: '25' },
    after: { rate: '26' }
  }));
});

test('DELETE /api-keys/:id writes an api_key.deactivate audit row and never logs the key hash', async () => {
  deactivateApiKey.mockResolvedValue({
    data: { id: 'key-1', name: 'Acme', key_hash: 'super-secret-hash-must-not-leak', is_active: false },
    error: null
  });

  const res = await adminApp.request('/api-keys/key-1', {
    method: 'DELETE',
    headers: { 'X-Admin-Key': 'mitchel-secret' }
  });

  expect(res.status).toBe(200);
  expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({
    actor: 'mitchel',
    action: 'api_key.deactivate',
    resourceId: 'key-1'
  }));
  const auditCall = writeAudit.mock.calls[0][0];
  expect(JSON.stringify(auditCall)).not.toMatch(/super-secret-hash-must-not-leak/);
});

test('legacy ADMIN_SECRET_KEY still authenticates, attributed to actor "legacy"', async () => {
  getActiveRate.mockResolvedValue({ data: null, error: null });
  setRate.mockResolvedValue({ data: { rate: '30' }, error: null });

  const res = await adminApp.request('/exchange-rates', {
    method: 'PUT',
    headers: {
      'X-Admin-Key': 'legacy-secret',
      'X-Application-Id': 'app-1',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ rate: 30, setBy: 'whoever' })
  });

  expect(res.status).toBe(200);
  expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ actor: 'legacy' }));
});

test('a wrong named secret is rejected with 401 and never reaches writeAudit', async () => {
  const res = await adminApp.request('/exchange-rates', {
    method: 'PUT',
    headers: {
      'X-Admin-Key': 'not-a-real-secret',
      'X-Application-Id': 'app-1',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ rate: 30, setBy: 'whoever' })
  });

  expect(res.status).toBe(401);
  expect(writeAudit).not.toHaveBeenCalled();
});

test('writeAudit rejecting does not fail the admin request', async () => {
  getActiveRate.mockResolvedValue({ data: { rate: '25', created_at: new Date().toISOString() }, error: null });
  setRate.mockResolvedValue({ data: { rate: '26' }, error: null });
  writeAudit.mockRejectedValue(new Error('audit db is down'));

  const res = await adminApp.request('/exchange-rates', {
    method: 'PUT',
    headers: {
      'X-Admin-Key': 'mitchel-secret',
      'X-Application-Id': 'app-1',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ rate: 26, setBy: 'whoever' })
  });

  expect(res.status).toBe(200);
});
