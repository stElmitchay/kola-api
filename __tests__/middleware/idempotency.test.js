import { jest } from '@jest/globals';
import { Hono } from 'hono';
import { createHash } from 'crypto';

const APP_ID = '11111111-1111-1111-1111-111111111111';

/** @type {Array<any>} */
let responseQueue = [];
/** @type {Array<{op: string, args: any}>} */
let calls = [];

function makeBuilder(result) {
  const builder = {
    insert: jest.fn((arg) => {
      calls.push({ op: 'insert', args: arg });
      return builder;
    }),
    select: jest.fn((arg) => {
      calls.push({ op: 'select', args: arg });
      return builder;
    }),
    update: jest.fn((arg) => {
      calls.push({ op: 'update', args: arg });
      return builder;
    }),
    eq: jest.fn((field, value) => {
      calls.push({ op: 'eq', args: [field, value] });
      return builder;
    }),
    single: jest.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  };
  return builder;
}

const fromMock = jest.fn(() => {
  const result = responseQueue.shift();
  return makeBuilder(result);
});

jest.unstable_mockModule('../../src/utils/supabase.js', () => ({
  createSupabaseClient: () => ({ from: fromMock })
}));

const { idempotency } = await import('../../src/middleware/idempotency.js');

function hashOf(rawBody) {
  return createHash('sha256').update(rawBody).digest('hex');
}

function buildApp(handler) {
  const app = new Hono();
  app.use('/*', async (c, next) => {
    c.set('application', APP_ID);
    await next();
  });
  app.post('/', idempotency('deposits'), handler);
  return app;
}

beforeEach(() => {
  responseQueue = [];
  calls = [];
  fromMock.mockClear();
});

test('(a) first call passes through — handler sees intact JSON body, response is stored', async () => {
  const handler = jest.fn(async (c) => {
    const body = await c.req.json();
    return c.json({ id: 'created-1', echo: body }, 201);
  });
  const app = buildApp(handler);

  responseQueue = [
    { error: null }, // insert claims the key
    { error: null } // update after next()
  ];

  const bodyStr = JSON.stringify({ amount: 500 });
  const res = await app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': 'key-1' },
    body: bodyStr
  });

  expect(handler).toHaveBeenCalledTimes(1);
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({ id: 'created-1', echo: { amount: 500 } });

  const insertCall = calls.find((c) => c.op === 'insert');
  expect(insertCall.args).toEqual({
    key: 'key-1',
    application: APP_ID,
    scope: 'deposits',
    request_hash: hashOf(bodyStr)
  });

  const updateCall = calls.find((c) => c.op === 'update');
  expect(updateCall.args).toEqual({
    response_status: 201,
    response_body: { id: 'created-1', echo: { amount: 500 } }
  });
});

test('(b) replay with same key+body returns the stored response WITHOUT re-invoking the handler', async () => {
  const handler = jest.fn(async (c) => c.json({ should: 'not-run' }, 201));
  const app = buildApp(handler);

  const bodyStr = JSON.stringify({ amount: 500 });
  responseQueue = [
    { error: { message: 'duplicate key value violates unique constraint' } }, // insert loses the claim
    {
      data: {
        request_hash: hashOf(bodyStr),
        response_status: 200,
        response_body: { id: 'created-1', cached: true }
      }
    } // select finds the completed row
  ];

  const res = await app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': 'key-1' },
    body: bodyStr
  });

  expect(handler).not.toHaveBeenCalled();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ id: 'created-1', cached: true });
  expect(calls.some((c) => c.op === 'update')).toBe(false);
});

test('(c) same key, different body → 422', async () => {
  const handler = jest.fn(async (c) => c.json({ should: 'not-run' }, 201));
  const app = buildApp(handler);

  responseQueue = [
    { error: { message: 'duplicate key value violates unique constraint' } },
    {
      data: {
        request_hash: hashOf(JSON.stringify({ amount: 999 })), // different body's hash
        response_status: 200,
        response_body: { id: 'created-1' }
      }
    }
  ];

  const res = await app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': 'key-1' },
    body: JSON.stringify({ amount: 500 })
  });

  expect(handler).not.toHaveBeenCalled();
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({ error: 'Idempotency-Key reused with a different request body' });
});

test('(d) in-flight key (response_body still null) → 409 with Retry-After', async () => {
  const handler = jest.fn(async (c) => c.json({ should: 'not-run' }, 201));
  const app = buildApp(handler);

  const bodyStr = JSON.stringify({ amount: 500 });
  responseQueue = [
    { error: { message: 'duplicate key value violates unique constraint' } },
    {
      data: {
        request_hash: hashOf(bodyStr),
        response_status: null,
        response_body: null
      }
    }
  ];

  const res = await app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': 'key-1' },
    body: bodyStr
  });

  expect(handler).not.toHaveBeenCalled();
  expect(res.status).toBe(409);
  expect(res.headers.get('Retry-After')).toBe('2');
  expect(await res.json()).toEqual({ error: 'Original request still in flight' });
});

test('(e) missing Idempotency-Key header → pass-through, no storage calls', async () => {
  const handler = jest.fn(async (c) => {
    const body = await c.req.json();
    return c.json({ id: 'created-1', echo: body }, 201);
  });
  const app = buildApp(handler);

  const res = await app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: 500 })
  });

  expect(handler).toHaveBeenCalledTimes(1);
  expect(res.status).toBe(201);
  expect(fromMock).not.toHaveBeenCalled();
});
