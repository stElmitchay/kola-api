//@ts-check

/**
 * Deposit-leg concurrency fuzz (task D2, step 4).
 *
 * Monime retries webhooks, and `successEvents` deliberately keeps both
 * `payment_code.processed` and `payment_code.completed` (see
 * docs/fixtures/monime/README.md) — so several DISTINCT deliveries can
 * legitimately announce the same successful payment. Each carries its own
 * `event.id`, so 0013's exactly-once gate lets every one of them through;
 * the only thing standing between that and a double payout is the
 * `pending -> confirmed` compare-and-swap plus `transfer_jobs.deposit_id`
 * being UNIQUE. Both are database guarantees, so both need a database to
 * test.
 *
 * 50 deliveries land at once. Exactly one job row, exactly one collection
 * journal, and — after the real sweep — exactly one broadcast.
 */

import { jest } from '@jest/globals';
import {
  describeIntegration, solanaMocks, installMonimeMock, resetAll, resetMoneyTables,
  seedApplication, testPhone, freshWallet, apiPost, postMonimeWebhook, runTransferTick,
  monimeDepositEvent, readRow, readRowsWhere, journalsFor, journalImbalances,
  serviceClient
} from './helpers.js';

const solana = solanaMocks();
jest.unstable_mockModule('../../src/utils/solana.js', () => solana.mod);
jest.unstable_mockModule('@vercel/functions', () => ({ waitUntil: jest.fn() }));

const { app } = await import('../../api/index.js');

const AMOUNT_SLE_MINOR = 100_000;
const EXPECTED_USDC_MINOR = 40_000_000;
const DELIVERIES = 50;

describeIntegration('deposit-leg concurrency fuzz (real Postgres)', () => {
  /** @type {ReturnType<typeof installMonimeMock>} */
  let monime;
  /** @type {string} */
  let apiKey;

  beforeAll(async () => {
    monime = installMonimeMock();
    await resetAll();
    ({ apiKey } = await seedApplication({ rate: 25 }));
  });

  afterAll(() => {
    monime.restore();
  });

  beforeEach(async () => {
    await resetMoneyTables();
    monime.reset();
    jest.clearAllMocks();
    solana.chain.reset();
  });

  /**
   * @param {number} phoneSeed
   * @returns {Promise<string>}
   */
  async function initiate(phoneSeed) {
    const res = await apiPost(app, '/api/v1/deposits', {
      amount: AMOUNT_SLE_MINOR,
      currency: 'SLE',
      paymentMethod: 'ussd',
      phoneNumber: testPhone(phoneSeed),
      walletAddress: freshWallet()
    }, { apiKey });
    expect(res.status).toBe(201);
    return (await res.json()).id;
  }

  test(`${DELIVERIES} concurrent success deliveries produce exactly one job and one broadcast`, async () => {
    const depositId = await initiate(201);

    // Distinct event ids: every delivery clears the exactly-once gate, so the
    // CAS claim is the ONLY thing preventing 50 transfer jobs.
    const deliveries = Array.from({ length: DELIVERIES }, (_, i) => postMonimeWebhook(app, monimeDepositEvent({
      name: i % 2 === 0 ? 'payment_code.completed' : 'payment_code.processed',
      depositId,
      amountSleMinor: AMOUNT_SLE_MINOR,
      eventId: `fuzz-${depositId}-${i}`
    })));

    const responses = await Promise.all(deliveries);
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true });
    }

    // All 50 were recorded by the gate (none was mistaken for a duplicate).
    const { data: events } = await serviceClient()
      .from('webhook_events').select('event_id').eq('provider', 'monime');
    expect(events).toHaveLength(DELIVERIES);

    // Exactly one claim won: one job row (UNIQUE deposit_id), one collection
    // journal (UNIQUE idempotency_key), deposit sitting at 'confirmed'.
    const jobs = await readRowsWhere('transfer_jobs', 'deposit_id', depositId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('queued');
    expect(Number(jobs[0].amount_usdc)).toBe(EXPECTED_USDC_MINOR);

    expect((await readRow('deposits', depositId)).status).toBe('confirmed');
    expect((await journalsFor('deposit', depositId)).map((j) => j.kind))
      .toEqual(['deposit_collection']);

    const { data: allJobs } = await serviceClient().from('transfer_jobs').select('id');
    expect(allJobs).toHaveLength(1);

    // --- the sweep claims it exactly once --------------------------------
    const tick = await runTransferTick(app);
    expect(await tick.json()).toEqual({ processed: 1 });

    expect(solana.mod.buildSignedUsdcTransfer).toHaveBeenCalledTimes(1);
    expect(solana.mod.sendSerializedTransaction).toHaveBeenCalledTimes(1);
    expect(solana.chain.outMinor).toBe(EXPECTED_USDC_MINOR);

    const completed = await readRow('deposits', depositId);
    expect(completed.status).toBe('completed');
    expect((await readRowsWhere('transfer_jobs', 'deposit_id', depositId))[0].status).toBe('sent');
    expect((await journalsFor('deposit', depositId)).map((j) => j.kind))
      .toEqual(['deposit_collection', 'deposit_payout']);
    expect(await journalImbalances()).toEqual([]);
  }, 180_000);

  test('concurrent sweeps of one queued job still broadcast exactly once', async () => {
    const depositId = await initiate(202);
    await postMonimeWebhook(app, monimeDepositEvent({
      name: 'payment_code.completed', depositId, amountSleMinor: AMOUNT_SLE_MINOR
    }));
    expect((await readRow('deposits', depositId)).status).toBe('confirmed');

    // Five overlapping ticks — a cron run colliding with the webhook's
    // best-effort kick, or two cron invocations overlapping. `recordSignature`
    // fences on the exact (status, signature) each tick observed, so only one
    // tick may broadcast.
    const ticks = await Promise.all(Array.from({ length: 5 }, () => runTransferTick(app)));
    for (const res of ticks) {
      expect(res.status).toBe(200);
    }

    expect(solana.mod.sendSerializedTransaction).toHaveBeenCalledTimes(1);
    expect(solana.chain.outMinor).toBe(EXPECTED_USDC_MINOR);

    const job = (await readRowsWhere('transfer_jobs', 'deposit_id', depositId))[0];
    expect(job.status).toBe('sent');
    const deposit = await readRow('deposits', depositId);
    expect(deposit.status).toBe('completed');
    expect(deposit.solana_tx_signature).toBe(job.signature);
    expect((await journalsFor('deposit', depositId)).map((j) => j.kind))
      .toEqual(['deposit_collection', 'deposit_payout']);
  }, 60_000);

  test('50 concurrent deliveries across 10 distinct deposits produce 10 jobs', async () => {
    const ids = [];
    for (let i = 0; i < 10; i += 1) {
      ids.push(await initiate(300 + i));
    }

    const deliveries = ids.flatMap((depositId, d) => Array.from({ length: 5 }, (_, i) => postMonimeWebhook(
      app,
      monimeDepositEvent({
        name: 'payment_code.completed',
        depositId,
        amountSleMinor: AMOUNT_SLE_MINOR,
        eventId: `multi-${d}-${i}`
      })
    )));

    await Promise.all(deliveries);

    const { data: jobs } = await serviceClient().from('transfer_jobs').select('deposit_id');
    expect(jobs).toHaveLength(10);
    expect(new Set(jobs.map((j) => j.deposit_id)).size).toBe(10);

    for (const id of ids) {
      expect((await readRow('deposits', id)).status).toBe('confirmed');
      expect((await journalsFor('deposit', id)).map((j) => j.kind)).toEqual(['deposit_collection']);
    }
    expect(await journalImbalances()).toEqual([]);
  }, 180_000);
});
