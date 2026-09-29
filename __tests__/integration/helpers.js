//@ts-check

/**
 * Integration-suite harness (task D2).
 *
 * These specs run against a REAL Postgres — the local Supabase stack — so
 * the RPCs (`create_withdrawal_guarded`, `post_journal`,
 * `set_exchange_rate`), the state-machine triggers (0012), the ledger
 * immutability + balance triggers (0015) and every unique index actually
 * fire. Only the three external vendors are faked:
 *
 *  - **Monime**: `globalThis.fetch` is wrapped and only requests to
 *    `https://api.monime.io` are answered locally. The REAL
 *    `src/utils/monime.js` request builder, auth headers, idempotency-key
 *    plumbing and `verifyWebhookSignature` HMAC all run unmodified —
 *    everything except the socket.
 *  - **Helius**: no mock at all. Synthetic Enhanced-Webhook payloads are
 *    POSTed to the real `/api/webhooks/helius` route with the real static
 *    bearer that `verifyHeliusAuth` checks.
 *  - **Solana**: `src/utils/solana.js` is replaced via
 *    `jest.unstable_mockModule` (see `solanaMocks()`), because those are
 *    the only functions that need a chain. The mock keeps a tiny in-memory
 *    "chain" tally so the ledger spec can assert the `treasury_usdc` ledger
 *    delta equals the net movement the mocked chain reported.
 *
 * `@vercel/functions`' `waitUntil` is also mocked out by the specs. It is
 * not a vendor — it is the platform boundary — but the best-effort sweep
 * kick it schedules from the deposit webhook is a latency optimization
 * whose completion is not observable from a test. The specs drive the
 * sweep explicitly through the real `POST /api/internal/transfer-tick`
 * cron route instead, so "exactly one broadcast" is an assertion about
 * the sweep's claim fence rather than about background timing.
 *
 * Nothing here runs unless `INTEGRATION=1` AND the stack answers — see
 * `describeIntegration`.
 */

import { jest } from '@jest/globals';
import { createHash, createHmac, randomUUID } from 'crypto';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { createClient } from '@supabase/supabase-js';
import { hashApiKey } from '../../src/utils/crypto.js';

const MONIME_BASE_URL = 'https://api.monime.io';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PLACEHOLDER_SERVICE_KEY = 'integration-placeholder-service-role-key';

/**
 * Fixed treasury keypair (seeded, never random) so `TREASURY_ADDRESS` is
 * stable across runs and can be pasted into a fixture or a doc. The secret
 * key is written to `TREASURY_SECRET_KEY` purely to satisfy the startup
 * config gate — `src/utils/solana.js` is mocked, so it is never used to
 * sign anything.
 */
const TREASURY_KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(7));

/** Treasury wallet address the mocked `getTreasuryAddress()` reports. */
export const TREASURY_ADDRESS = TREASURY_KEYPAIR.publicKey.toBase58();

/** Mainnet USDC mint — only ever compared as a string here. */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Env the suite pins for determinism. The bounds are FORCED (tests assert
 * against these exact numbers); the connection + vendor values are only
 * defaulted, so a founder can point the suite at a different local stack
 * or rotate the fake secrets without editing this file.
 */
const FORCED_ENV = {
  DEPOSIT_MIN_SLE: '100',
  DEPOSIT_MAX_SLE: '500000',
  WITHDRAWAL_FEE_BPS: '100',
  WITHDRAWAL_MIN_USDC: '100000',
  WITHDRAWAL_MAX_USDC: '100000000',
  WITHDRAWAL_DAILY_CAP_USDC: '500000000',
  RATE_MAX_AGE_MINUTES: '1440',
  RATE_MAX_MOVE_BPS: '500',
  MONIME_TIMEOUT_MS: '15000',
  STUCK_THRESHOLD_MINUTES: '30'
};

const DEFAULT_ENV = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: PLACEHOLDER_SERVICE_KEY,
  MONIME_ACCESS_TOKEN: 'integration-monime-access-token',
  MONIME_SPACE_ID: 'integration-monime-space',
  MONIME_WEBHOOK_SECRET: 'integration-monime-webhook-secret',
  MONIME_FINANCIAL_ACCOUNT_ID: 'integration-monime-financial-account',
  HELIUS_URL: 'http://127.0.0.1:1/no-rpc-should-be-reached',
  HELIUS_WEBHOOK_AUTH_HEADER: 'integration-helius-auth-header',
  TREASURY_SECRET_KEY: bs58.encode(TREASURY_KEYPAIR.secretKey),
  USDC_MINT,
  API_KEY_SALT: 'integration-api-key-salt',
  CRON_SECRET: 'integration-cron-secret'
};

/**
 * Seed the process env. Runs at module load (before any spec imports
 * `api/index.js`) because `api/index.js` has a startup config gate that
 * throws on a missing REQUIRED var, and because `src/repos/*.js` build
 * their Supabase client at module-load time.
 * @returns {void}
 */
function seedEnv() {
  for (const [name, value] of Object.entries(FORCED_ENV)) {
    process.env[name] = value;
  }
  for (const [name, value] of Object.entries(DEFAULT_ENV)) {
    if (!process.env[name]) process.env[name] = value;
  }
  // Must be OFF: a paused kill switch 503s every money route, a configured
  // Upstash instance 429s the 50x fuzz, and a real Sentry DSN would ship
  // test errors to a live project.
  delete process.env.KOLA_PAUSE;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.SENTRY_DSN;
}

seedEnv();

/** True when the operator asked for the integration suite. */
export const INTEGRATION = process.env.INTEGRATION === '1';

/**
 * Probe the stack ONCE per test file. `npm run test:integration` sets
 * `INTEGRATION=1`, but the stack itself is a separate prerequisite
 * (`supabase start`) that cannot be assumed — an environment with no
 * Supabase CLI and no Docker must still exit 0 rather than fail with 40
 * connection-refused stack traces. So a missing stack SKIPS, loudly.
 *
 * Set `INTEGRATION_REQUIRE_STACK=1` (do this in CI) to turn the skip into
 * a hard failure instead.
 * @returns {Promise<boolean>}
 */
async function probeStack() {
  if (!INTEGRATION) return false;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let reason = null;

  if (key === PLACEHOLDER_SERVICE_KEY) {
    reason = 'SUPABASE_SERVICE_ROLE_KEY is not set (export the service_role key printed by `supabase start`)';
  } else {
    try {
      // Any HTTP answer means the stack is up. A 401/404 is deliberately
      // treated as "reachable" so a misconfigured key fails loudly inside
      // the specs instead of being silently skipped.
      await fetch(`${url}/rest/v1/`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(3000)
      });
    } catch (err) {
      reason = `${url} did not answer (${err.message})`;
    }
  }

  if (!reason) return true;
  const message =
    `[integration] SKIPPED: no local Supabase stack — ${reason}. ` +
    'See docs/testing.md ("Running the integration suite").';
  if (process.env.INTEGRATION_REQUIRE_STACK === '1') throw new Error(message);
  // Written straight to stderr, not through `console.warn`: Jest's console
  // interception buffers per-suite output and does not print it for a suite
  // whose every test was skipped — which is exactly this case. A silent skip
  // would be the worst outcome, so this must be unmissable.
  process.stderr.write(`\n${message}\n`);
  return false;
}

const STACK_AVAILABLE = await probeStack();

/**
 * `describe` when the suite may run, `describe.skip` otherwise. Every spec
 * file wraps its whole body in this, so even a direct `jest` invocation
 * that ignores the npm script is safe.
 */
export const describeIntegration = INTEGRATION && STACK_AVAILABLE ? describe : describe.skip;

/** @type {import('@supabase/supabase-js').SupabaseClient | null} */
let client = null;

/**
 * Service-role client used ONLY for seeding and assertions — never as a
 * substitute for the production repo layer, which the specs exercise
 * through the real routes.
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
export function serviceClient() {
  if (!client) {
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return client;
}

/**
 * Deterministic 88-character base58 string, shaped like a Solana signature
 * (the confirm endpoint's schema requires >= 64 chars, and both
 * `deposits.solana_tx_signature` and `withdrawals.solana_tx_signature`
 * carry a partial UNIQUE index, so every seed must be distinct).
 * @param {string|number} seed
 * @returns {string}
 */
export function fakeSignature(seed) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digest = createHash('sha256').update(`sig:${seed}`).digest();
  let out = '';
  for (let i = 0; i < 88; i += 1) {
    out += alphabet[digest[i % digest.length] % alphabet.length];
  }
  return out;
}

/**
 * A fresh, valid Sierra Leone mobile number. `validatePhoneNumber` accepts
 * `+232` + (7X|3X) + six digits.
 * @param {number} n
 * @returns {string}
 */
export function testPhone(n) {
  return `+23276${String(n % 1_000_000).padStart(6, '0')}`;
}

/**
 * A fresh, real Solana address — the deposit/withdrawal schemas validate
 * these with `new PublicKey()`, so hand-written strings will not do.
 * @returns {string}
 */
export function freshWallet() {
  return Keypair.generate().publicKey.toBase58();
}

// ---------------------------------------------------------------------------
// Seeding + reset
// ---------------------------------------------------------------------------

/**
 * Delete order matters: `transfer_jobs.deposit_id` references `deposits`,
 * and every money table references `auth_api_keys`. PostgREST refuses an
 * unfiltered DELETE, hence the always-true `.not(col, 'is', null)` filter.
 *
 * `ledger_journals` / `ledger_entries` / `audit_log` are deliberately
 * ABSENT. 0015's `forbid_ledger_mutation()` fires `BEFORE UPDATE OR DELETE`
 * — a DELETE through PostgREST would raise `ledger is append-only`, which
 * is exactly the guarantee those triggers exist to provide. (`TRUNCATE`
 * would bypass them, since TRUNCATE triggers are a separate event type and
 * B4 deliberately deferred covering it — but PostgREST cannot issue
 * TRUNCATE, and pretending the ledger is resettable would weaken the
 * invariant the ledger spec asserts.) Ledger assertions are therefore
 * written as BEFORE/AFTER deltas and as per-journal balance checks over
 * every journal in the database, both of which hold no matter what earlier
 * spec files left behind.
 */
const MONEY_TABLES = [
  ['transfer_jobs', 'id'],
  ['deposits', 'id'],
  ['withdrawals', 'id'],
  ['webhook_events', 'id'],
  ['unmatched_transfers', 'id'],
  ['idempotency_keys', 'key']
];

const APP_TABLES = [
  ['exchange_rates', 'id'],
  ['derived_wallets', 'id'],
  ['auth_api_keys', 'id']
];

/**
 * @param {[string, string][]} tables
 * @returns {Promise<void>}
 */
async function deleteAll(tables) {
  const db = serviceClient();
  for (const [table, column] of tables) {
    const { error } = await db.from(table).delete().not(column, 'is', null);
    if (error) throw new Error(`reset of ${table} failed: ${error.message}`);
  }
}

/**
 * Wipe every mutable money table. Safe to call between tests in one file.
 * @returns {Promise<void>}
 */
export async function resetMoneyTables() {
  await deleteAll(MONEY_TABLES);
}

/**
 * Wipe the money tables AND the application/rate rows. Call once per spec
 * file (`beforeAll`) so files cannot see each other's API keys.
 * @returns {Promise<void>}
 */
export async function resetAll() {
  await deleteAll(MONEY_TABLES);
  await deleteAll(APP_TABLES);
}

/**
 * Insert an application (API key) row directly through the service client
 * and return the RAW key the routes expect in `X-API-Key`, plus an active
 * exchange rate (without one, every money route refuses to quote).
 * @param {object} [options]
 * @param {number} [options.rate] - SLE per 1 USDC
 * @param {number} [options.rateLimit]
 * @returns {Promise<{ application: string, apiKey: string }>}
 */
export async function seedApplication({ rate = 25, rateLimit = 100000 } = {}) {
  const db = serviceClient();
  const apiKey = `itest_${randomUUID()}`;

  const { data, error } = await db
    .from('auth_api_keys')
    .insert({
      client_id: `itest_${randomUUID().slice(0, 8)}`,
      key_hash: hashApiKey(apiKey),
      name: 'integration-suite',
      business_name: 'Integration Test Co',
      app_name: 'itest',
      permissions: {},
      rate_limit: rateLimit
    })
    .select()
    .single();
  if (error || !data) throw new Error(`seedApplication failed: ${error?.message}`);

  const { error: rateError } = await db.rpc('set_exchange_rate', {
    p_application: data.id,
    p_rate: rate,
    p_set_by: 'integration-suite'
  });
  if (rateError) throw new Error(`seedApplication rate failed: ${rateError.message}`);

  return { application: data.id, apiKey };
}

// ---------------------------------------------------------------------------
// Vendor fakes
// ---------------------------------------------------------------------------

/**
 * Build the `{ result: ... }` envelope Monime returns for the endpoints
 * this codebase calls. Shapes mirror what `src/utils/monime.js` destructures
 * (`response.result.id`, `.ussdCode`, `.redirectUrl`, `.expireTime`,
 * `.status`) — see docs/fixtures/monime/README.md for the live-capture
 * checklist that will replace these with verbatim bodies.
 * @param {string} method
 * @param {string} path
 * @param {any} body
 * @param {number} seq
 * @returns {any}
 */
function monimeResult(method, path, body, seq) {
  const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  if (method === 'POST' && path === '/v1/payment-codes') {
    return { id: `pc_${seq}`, ussdCode: `*123*${seq}#`, expireTime };
  }
  if (method === 'POST' && path === '/v1/checkout-sessions') {
    return { id: `cs_${seq}`, redirectUrl: `https://checkout.monime.test/${seq}`, expireTime };
  }
  if (method === 'POST' && path === '/v1/payouts') {
    return { id: `po_${seq}`, status: 'pending', metadata: body?.metadata ?? {} };
  }
  if (method === 'GET' && path.startsWith('/v1/payouts/')) {
    return { id: path.split('/').pop(), status: 'pending' };
  }
  if (method === 'GET' && path.startsWith('/v1/momos')) {
    return [{ id: 'm17', name: 'Orange Money' }];
  }
  return null;
}

/**
 * Wrap `globalThis.fetch` so ONLY `https://api.monime.io` requests are
 * answered locally; everything else (notably every PostgREST call the
 * repos make) is delegated to the real fetch untouched. The whole of
 * `src/utils/monime.js` — headers, idempotency key, timeout signal,
 * error-detail extraction — therefore runs for real.
 * @returns {{
 *   calls: {method: string, path: string, body: any, idempotencyKey: string|null}[],
 *   callsTo: (path: string) => any[],
 *   payoutCallsFor: (withdrawalId: string) => any[],
 *   failNext: (status: number, body?: any) => void,
 *   reset: () => void,
 *   restore: () => void
 * }}
 */
export function installMonimeMock() {
  const realFetch = globalThis.fetch;
  /** @type {{method: string, path: string, body: any, idempotencyKey: string|null}[]} */
  const calls = [];
  /** @type {{status: number, body: any}[]} */
  const failures = [];
  let seq = 0;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    if (!url.startsWith(MONIME_BASE_URL)) return realFetch(input, init);

    const path = url.slice(MONIME_BASE_URL.length);
    const method = String(init.method || 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const headers = /** @type {Record<string, string>} */ (init.headers || {});
    calls.push({ method, path, body, idempotencyKey: headers['Idempotency-Key'] ?? null });

    const failure = failures.shift();
    if (failure) {
      return new Response(JSON.stringify(failure.body ?? { messages: ['injected failure'] }), {
        status: failure.status, headers: JSON_HEADERS
      });
    }

    seq += 1;
    const result = monimeResult(method, path, body, seq);
    if (!result) {
      return new Response(JSON.stringify({ messages: [`unmocked Monime endpoint ${method} ${path}`] }), {
        status: 501, headers: JSON_HEADERS
      });
    }
    return new Response(JSON.stringify({ result }), { status: 200, headers: JSON_HEADERS });
  };

  return {
    calls,
    callsTo: (path) => calls.filter((c) => c.path === path),
    payoutCallsFor: (withdrawalId) => calls.filter(
      (c) => c.path === '/v1/payouts' && c.body?.metadata?.withdrawal_id === withdrawalId
    ),
    failNext: (status, body) => { failures.push({ status, body }); },
    reset: () => { calls.length = 0; failures.length = 0; },
    restore: () => { globalThis.fetch = realFetch; }
  };
}

/**
 * The mocked `src/utils/solana.js` module plus the in-memory chain tally
 * the ledger spec asserts against. `mod` is what the spec hands to
 * `jest.unstable_mockModule`; every export any importer in `src/` pulls
 * from the real module is present, so the import graph resolves.
 *
 * Only the chain-touching functions get behaviour:
 *  - `buildSignedUsdcTransfer` mints a unique signature and remembers the
 *    amount, exactly like a signed-but-unsent transaction.
 *  - `sendSerializedTransaction` books that amount as an OUTBOUND movement
 *    (this is the broadcast — the thing that must happen at most once).
 *  - `verifyIncomingUsdcTransfer` books the expected amount as INBOUND.
 *  - `getTreasuryAddress` returns the fixed `TREASURY_ADDRESS`; it reads a
 *    key, not the chain, but the whole module is replaced so it has to be
 *    supplied here.
 * @returns {{ mod: Record<string, any>, chain: { inMinor: number, outMinor: number, reset: () => void } }}
 */
export function solanaMocks() {
  /** @type {Map<string, number>} */
  const signed = new Map();
  const chain = {
    inMinor: 0,
    outMinor: 0,
    reset() { this.inMinor = 0; this.outMinor = 0; signed.clear(); }
  };
  let seq = 0;

  const mod = {
    getTreasuryAddress: jest.fn(() => TREASURY_ADDRESS),
    getTreasuryUsdcBalanceMinor: jest.fn(async () => 10_000_000_000_000n),

    buildSignedUsdcTransfer: jest.fn(async (destination, amountMinorUnits) => {
      seq += 1;
      const signature = fakeSignature(`built-${seq}-${destination}-${amountMinorUnits}`);
      signed.set(signature, Number(amountMinorUnits));
      return {
        signature,
        serialized: Buffer.from(signature),
        blockhash: `blockhash-${seq}`,
        lastValidBlockHeight: 1000 + seq
      };
    }),
    sendSerializedTransaction: jest.fn(async (_serialized, signature) => {
      chain.outMinor += signed.get(signature) ?? 0;
    }),
    checkSignatureLanded: jest.fn(async () => 'finalized'),
    getCurrentBlockHeight: jest.fn(async () => 1_000_000),

    verifyIncomingUsdcTransfer: jest.fn(async (_signature, _fromWallet, expectedAmount) => {
      chain.inMinor += Number(expectedAmount);
      return { ok: true };
    }),

    // Present so the wallets route resolves; never exercised by these specs.
    getUsdcBalance: jest.fn()
  };

  return { mod, chain };
}

// ---------------------------------------------------------------------------
// Request builders (real routes, real auth)
// ---------------------------------------------------------------------------

/**
 * Monime webhook signature in the exact header format
 * `verifyWebhookSignature` parses: `t=<unix_seconds>,v1=<base64_hmac>`
 * over `"<timestamp>_<rawBody>"`.
 * @param {string} rawBody
 * @returns {string}
 */
export function monimeSignatureHeader(rawBody) {
  const timestamp = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', process.env.MONIME_WEBHOOK_SECRET)
    .update(`${timestamp}_${rawBody}`, 'utf8')
    .digest('base64');
  return `t=${timestamp},v1=${v1}`;
}

/**
 * A Monime deposit event. `event.id` is the exactly-once gate key
 * (0013's `UNIQUE (provider, event_id)`) — pass the SAME id to replay a
 * delivery, a fresh one to simulate a distinct delivery for the same
 * deposit.
 * @param {object} params
 * @param {string} params.name - e.g. 'payment_code.completed'
 * @param {string} params.depositId
 * @param {number} params.amountSleMinor
 * @param {string} [params.eventId]
 * @returns {any}
 */
export function monimeDepositEvent({ name, depositId, amountSleMinor, eventId = randomUUID() }) {
  return {
    event: { id: eventId, name },
    data: {
      reference: depositId,
      amount: { currency: 'SLE', value: amountSleMinor },
      status: 'completed'
    }
  };
}

/**
 * A Monime payout event. `data.id` is the payout id the withdrawal row
 * stored in `monime_payout_id`.
 * @param {object} params
 * @param {string} params.name - 'payout.completed' | 'payout.failed'
 * @param {string} params.payoutId
 * @param {string} params.withdrawalId
 * @param {string} [params.eventId]
 * @param {string} [params.failureMessage]
 * @returns {any}
 */
export function monimePayoutEvent({ name, payoutId, withdrawalId, eventId = randomUUID(), failureMessage }) {
  return {
    event: { id: eventId, name },
    data: {
      id: payoutId,
      status: name === 'payout.completed' ? 'completed' : 'failed',
      metadata: { withdrawal_id: withdrawalId },
      ...(failureMessage ? { failureDetail: { message: failureMessage } } : {})
    }
  };
}

/**
 * A Helius Enhanced-Webhook event for a USDC transfer INTO the treasury.
 * Both amount fields are populated so the handler's preferred
 * `rawTokenAmount.tokenAmount` path is the one exercised.
 * @param {object} params
 * @param {string} params.fromWallet
 * @param {number} params.amountUsdcMinor
 * @param {string} params.signature
 * @returns {any}
 */
export function heliusTransferEvent({ fromWallet, amountUsdcMinor, signature }) {
  return {
    signature,
    type: 'TRANSFER',
    source: 'SOLANA_PROGRAM_LIBRARY',
    tokenTransfers: [{
      mint: process.env.USDC_MINT,
      fromUserAccount: fromWallet,
      toUserAccount: TREASURY_ADDRESS,
      tokenAmount: amountUsdcMinor / 1_000_000,
      rawTokenAmount: { tokenAmount: String(amountUsdcMinor), decimals: 6 }
    }]
  };
}

/**
 * POST a signed Monime webhook to the real route.
 * @param {any} app
 * @param {any} payload
 * @returns {Promise<Response>}
 */
export function postMonimeWebhook(app, payload) {
  const rawBody = JSON.stringify(payload);
  return app.request('/api/webhooks/monime', {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'Monime-Signature': monimeSignatureHeader(rawBody) },
    body: rawBody
  });
}

/**
 * POST a synthetic Helius batch to the real route with the real bearer.
 * @param {any} app
 * @param {any[]} events
 * @returns {Promise<Response>}
 */
export function postHeliusWebhook(app, events) {
  return app.request('/api/webhooks/helius', {
    method: 'POST',
    headers: { ...JSON_HEADERS, Authorization: process.env.HELIUS_WEBHOOK_AUTH_HEADER },
    body: JSON.stringify(events)
  });
}

/**
 * Run the real transfer-tick sweep through its cron route (real
 * CRON_SECRET auth).
 * @param {any} app
 * @returns {Promise<Response>}
 */
export function runTransferTick(app) {
  return app.request('/api/internal/transfer-tick', {
    method: 'POST',
    headers: { 'X-Cron-Secret': process.env.CRON_SECRET }
  });
}

/**
 * Authenticated POST to a money route.
 * @param {any} app
 * @param {string} path - e.g. '/api/v1/deposits'
 * @param {any} body
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} [options.idempotencyKey]
 * @returns {Promise<Response>}
 */
export function apiPost(app, path, body, { apiKey, idempotencyKey }) {
  /** @type {Record<string, string>} */
  const headers = { ...JSON_HEADERS, 'X-API-Key': apiKey };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

/**
 * Authenticated GET on a money route.
 * @param {any} app
 * @param {string} path
 * @param {object} options
 * @param {string} options.apiKey
 * @returns {Promise<Response>}
 */
export function apiGet(app, path, { apiKey }) {
  return app.request(path, { method: 'GET', headers: { 'X-API-Key': apiKey } });
}

// ---------------------------------------------------------------------------
// Assertion readers
// ---------------------------------------------------------------------------

/**
 * @param {string} table
 * @param {string} id
 * @returns {Promise<any>}
 */
export async function readRow(table, id) {
  const { data, error } = await serviceClient().from(table).select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`readRow(${table}, ${id}) failed: ${error.message}`);
  return data;
}

/**
 * @param {string} table
 * @param {string} column
 * @param {any} value
 * @returns {Promise<any[]>}
 */
export async function readRowsWhere(table, column, value) {
  const { data, error } = await serviceClient().from(table).select('*').eq(column, value);
  if (error) throw new Error(`readRowsWhere(${table}, ${column}) failed: ${error.message}`);
  return data || [];
}

/**
 * Read every row of a ledger table, and refuse to pretend a truncated page
 * is the whole table. PostgREST silently caps a response at `db-max-rows`
 * when that setting is non-empty; a ledger invariant computed over a
 * truncated page would PASS while missing the very rows that broke it. The
 * exact count comes back in the same round trip, so compare and fail loudly.
 * @param {string} table
 * @param {string} columns
 * @param {(q: any) => any} [refine]
 * @returns {Promise<any[]>}
 */
async function selectEveryRow(table, columns, refine = (q) => q) {
  const { data, error, count } = await refine(
    serviceClient().from(table).select(columns, { count: 'exact' })
  );
  if (error) throw new Error(`${table} read failed: ${error.message}`);
  const rows = data || [];
  if (count !== null && count !== undefined && rows.length !== count) {
    throw new Error(
      `${table} read returned ${rows.length} of ${count} rows — PostgREST truncated the page ` +
      '(lower db-max-rows). Ledger assertions cannot run against a partial table.'
    );
  }
  return rows;
}

/** @type {Map<number, {code: string, currency: string}> | null} */
let accountsById = null;

/**
 * `ledger_accounts` is a fixed 8-row seed table (0015) — cache it.
 * @returns {Promise<Map<number, {code: string, currency: string}>>}
 */
async function ledgerAccountMap() {
  if (accountsById) return accountsById;
  const { data, error } = await serviceClient().from('ledger_accounts').select('id, code, currency');
  if (error) throw new Error(`ledger_accounts read failed: ${error.message}`);
  accountsById = new Map((data || []).map((row) => [row.id, { code: row.code, currency: row.currency }]));
  return accountsById;
}

/**
 * Journals posted for a resource, keyed by `kind`.
 * @param {string} resourceType - 'deposit' | 'withdrawal' | 'unmatched_transfer'
 * @param {string} resourceId
 * @returns {Promise<any[]>}
 */
export async function journalsFor(resourceType, resourceId) {
  const { data, error } = await serviceClient()
    .from('ledger_journals')
    .select('*')
    .eq('resource_type', resourceType)
    .eq('resource_id', resourceId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`journalsFor failed: ${error.message}`);
  return data || [];
}

/**
 * Every (journal, currency) pair whose debits do not equal its credits —
 * the JS-side reading of 0015's `assert_journal_balanced()` constraint
 * trigger, run over EVERY journal in the database. Must always be empty.
 *
 * Aggregation happens in JS rather than SQL because PostgREST exposes no
 * GROUP BY and this task adds no migration; `getLedgerTreasuryBalanceMinor`
 * in `src/repos/reconciliation.js` already reduces ledger rows the same way
 * for the same reason.
 * @returns {Promise<{journalId: string, currency: string, debit: string, credit: string}[]>}
 */
export async function journalImbalances() {
  const accounts = await ledgerAccountMap();
  const rows = await selectEveryRow('ledger_entries', 'journal_id, account, direction, amount');

  /** @type {Map<string, {debit: bigint, credit: bigint}>} */
  const sums = new Map();
  for (const row of rows) {
    const currency = accounts.get(row.account)?.currency;
    if (!currency) throw new Error(`ledger_entries.account=${row.account} has no ledger_accounts row`);
    const key = `${row.journal_id}|${currency}`;
    const bucket = sums.get(key) || { debit: 0n, credit: 0n };
    const amount = BigInt(row.amount);
    if (row.direction === 'debit') bucket.debit += amount;
    else bucket.credit += amount;
    sums.set(key, bucket);
  }

  const bad = [];
  for (const [key, { debit, credit }] of sums) {
    if (debit !== credit) {
      const [journalId, currency] = key.split('|');
      bad.push({ journalId, currency, debit: debit.toString(), credit: credit.toString() });
    }
  }
  return bad;
}

/**
 * Signed balance of one ledger account: sum(debit) - sum(credit), the same
 * convention `getLedgerTreasuryBalanceMinor` uses.
 * @param {string} code - e.g. 'treasury_usdc'
 * @returns {Promise<bigint>}
 */
export async function ledgerAccountBalance(code) {
  const accounts = await ledgerAccountMap();
  const entry = [...accounts.entries()].find(([, a]) => a.code === code);
  if (!entry) throw new Error(`unknown ledger account code ${code}`);

  const rows = await selectEveryRow(
    'ledger_entries', 'direction, amount', (q) => q.eq('account', entry[0])
  );

  return rows.reduce((sum, row) => {
    const amount = BigInt(row.amount);
    return row.direction === 'debit' ? sum + amount : sum - amount;
  }, 0n);
}
