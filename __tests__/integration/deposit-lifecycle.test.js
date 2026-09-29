//@ts-check

/**
 * Deposit money path, end to end, against real Postgres (task D2, step 2).
 *
 * pending -> (signed Monime webhook) -> confirmed + transfer_jobs row ->
 * (real transfer-tick sweep) -> completed + balanced journals, plus the
 * amount-mismatch parking path and both flavours of duplicate delivery.
 */

import { jest } from '@jest/globals';
import {
  describeIntegration, solanaMocks, installMonimeMock, resetAll, resetMoneyTables,
  seedApplication, testPhone, freshWallet, apiPost, apiGet, postMonimeWebhook,
  runTransferTick, monimeDepositEvent, readRow, readRowsWhere, journalsFor,
  journalImbalances, serviceClient
} from './helpers.js';

const solana = solanaMocks();
jest.unstable_mockModule('../../src/utils/solana.js', () => solana.mod);
// See helpers.js: the webhook's best-effort sweep kick is stubbed out so the
// sweep is driven explicitly through the real cron route below.
jest.unstable_mockModule('@vercel/functions', () => ({ waitUntil: jest.fn() }));

const { app } = await import('../../api/index.js');

// 1,000.00 SLE at 25 SLE/USDC = 40.000000 USDC.
const AMOUNT_SLE_MINOR = 100_000;
const EXPECTED_USDC_MINOR = 40_000_000;

describeIntegration('deposit lifecycle (real Postgres)', () => {
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
   * @param {object} [overrides]
   * @returns {Promise<{ id: string, body: any }>}
   */
  async function initiateDeposit(overrides = {}) {
    const res = await apiPost(app, '/api/v1/deposits', {
      amount: AMOUNT_SLE_MINOR,
      currency: 'SLE',
      paymentMethod: 'ussd',
      phoneNumber: testPhone(1),
      walletAddress: freshWallet(),
      ...overrides
    }, { apiKey });
    const body = await res.json();
    if (res.status !== 201) throw new Error(`initiate failed ${res.status}: ${JSON.stringify(body)}`);
    return { id: body.id, body };
  }

  test('rejects an amount above DEPOSIT_MAX_SLE without creating a row', async () => {
    const res = await apiPost(app, '/api/v1/deposits', {
      amount: 500_001,
      currency: 'SLE',
      paymentMethod: 'ussd',
      phoneNumber: testPhone(1),
      walletAddress: freshWallet()
    }, { apiKey });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('ValidationError');
    expect(body.error.message).toMatch(/maximum/i);
    expect(await readRowsWhere('deposits', 'status', 'pending')).toHaveLength(0);
    expect(monime.callsTo('/v1/payment-codes')).toHaveLength(0);
  });

  test('rejects an amount below DEPOSIT_MIN_SLE', async () => {
    const res = await apiPost(app, '/api/v1/deposits', {
      amount: 99,
      currency: 'SLE',
      paymentMethod: 'ussd',
      phoneNumber: testPhone(1),
      walletAddress: freshWallet()
    }, { apiKey });

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/minimum/i);
  });

  test('replays the stored response for a repeated Idempotency-Key', async () => {
    const body = {
      amount: AMOUNT_SLE_MINOR,
      currency: 'SLE',
      paymentMethod: 'ussd',
      phoneNumber: testPhone(2),
      walletAddress: freshWallet()
    };
    const key = 'itest-deposit-idempotency-1';

    const first = await apiPost(app, '/api/v1/deposits', body, { apiKey, idempotencyKey: key });
    const second = await apiPost(app, '/api/v1/deposits', body, { apiKey, idempotencyKey: key });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(secondBody).toEqual(firstBody);

    // The replay must not have re-run the handler: one deposit row, one
    // Monime payment-code call.
    const { data: rows } = await serviceClient().from('deposits').select('id');
    expect(rows).toHaveLength(1);
    expect(monime.callsTo('/v1/payment-codes')).toHaveLength(1);
  });

  test('rejects a reused Idempotency-Key carrying a different body', async () => {
    const key = 'itest-deposit-idempotency-2';
    const base = {
      amount: AMOUNT_SLE_MINOR,
      currency: 'SLE',
      paymentMethod: 'ussd',
      phoneNumber: testPhone(3),
      walletAddress: freshWallet()
    };

    await apiPost(app, '/api/v1/deposits', base, { apiKey, idempotencyKey: key });
    const res = await apiPost(app, '/api/v1/deposits',
      { ...base, amount: AMOUNT_SLE_MINOR + 100 }, { apiKey, idempotencyKey: key });

    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/different request body/i);
  });

  test('full lifecycle: webhook confirms, sweep completes, journals balance', async () => {
    const { id, body: created } = await initiateDeposit();

    expect(created.status).toBe('pending');
    expect(created.amountUsdc).toBe(EXPECTED_USDC_MINOR);
    expect(created.ussdCode).toBeTruthy();

    // The real Monime request path ran: one payment-code call, carrying the
    // deposit id as both reference and idempotency key.
    const codeCalls = monime.callsTo('/v1/payment-codes');
    expect(codeCalls).toHaveLength(1);
    expect(codeCalls[0].body.reference).toBe(id);
    expect(codeCalls[0].idempotencyKey).toBe(id);

    const pending = await readRow('deposits', id);
    expect(pending.status).toBe('pending');
    expect(Number(pending.amount_usdc)).toBe(EXPECTED_USDC_MINOR);
    // The payment-code id Monime returned was written back to the row.
    expect(pending.monime_resource_id).toMatch(/^pc_\d+$/);

    // --- signed success webhook -------------------------------------------
    const event = monimeDepositEvent({
      name: 'payment_code.completed', depositId: id, amountSleMinor: AMOUNT_SLE_MINOR
    });
    const webhookRes = await postMonimeWebhook(app, event);
    expect(webhookRes.status).toBe(200);
    expect(await webhookRes.json()).toEqual({ received: true });

    const confirmed = await readRow('deposits', id);
    expect(confirmed.status).toBe('confirmed');

    const jobs = await readRowsWhere('transfer_jobs', 'deposit_id', id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('queued');
    expect(Number(jobs[0].amount_usdc)).toBe(EXPECTED_USDC_MINOR);
    expect(jobs[0].destination).toBe(pending.wallet_address);

    const collectionJournals = await journalsFor('deposit', id);
    expect(collectionJournals.map((j) => j.kind)).toEqual(['deposit_collection']);
    expect(collectionJournals[0].idempotency_key).toBe(`deposit_collection:${id}`);

    // --- real transfer-tick sweep ----------------------------------------
    const tick = await runTransferTick(app);
    expect(tick.status).toBe(200);
    expect(await tick.json()).toEqual({ processed: 1 });

    expect(solana.mod.buildSignedUsdcTransfer).toHaveBeenCalledTimes(1);
    expect(solana.mod.buildSignedUsdcTransfer).toHaveBeenCalledWith(
      pending.wallet_address, EXPECTED_USDC_MINOR
    );
    expect(solana.mod.sendSerializedTransaction).toHaveBeenCalledTimes(1);

    const sentJob = (await readRowsWhere('transfer_jobs', 'deposit_id', id))[0];
    expect(sentJob.status).toBe('sent');
    expect(sentJob.signature).toBeTruthy();

    const completed = await readRow('deposits', id);
    expect(completed.status).toBe('completed');
    expect(completed.solana_tx_signature).toBe(sentJob.signature);

    const journals = await journalsFor('deposit', id);
    expect(journals.map((j) => j.kind)).toEqual(['deposit_collection', 'deposit_payout']);
    expect(await journalImbalances()).toEqual([]);

    // --- duplicate deliveries --------------------------------------------
    // (a) same event id: swallowed by 0013's exactly-once gate.
    const replay = await postMonimeWebhook(app, event);
    expect(await replay.json()).toEqual({ received: true, duplicate: true });

    // (b) fresh event id, same deposit: passes the gate, then short-circuits
    //     on the terminal status.
    const redelivery = await postMonimeWebhook(app, monimeDepositEvent({
      name: 'payment_code.completed', depositId: id, amountSleMinor: AMOUNT_SLE_MINOR
    }));
    expect(await redelivery.json()).toEqual({ received: true });

    const afterDuplicates = await readRow('deposits', id);
    expect(afterDuplicates.status).toBe('completed');
    expect(afterDuplicates.solana_tx_signature).toBe(sentJob.signature);
    expect(await readRowsWhere('transfer_jobs', 'deposit_id', id)).toHaveLength(1);
    expect((await journalsFor('deposit', id)).map((j) => j.kind))
      .toEqual(['deposit_collection', 'deposit_payout']);
    // No second broadcast, ever.
    expect(solana.mod.sendSerializedTransaction).toHaveBeenCalledTimes(1);

    // The public status endpoint agrees with the row.
    const statusRes = await apiGet(app, `/api/v1/deposits/${id}`, { apiKey });
    const statusBody = await statusRes.json();
    expect(statusBody.status).toBe('completed');
    expect(statusBody.solanaTxSignature).toBe(sentJob.signature);
  });

  test('a collected amount that differs from the quote parks the deposit and enqueues nothing', async () => {
    const { id } = await initiateDeposit({ phoneNumber: testPhone(4) });

    const res = await postMonimeWebhook(app, monimeDepositEvent({
      name: 'payment_code.completed',
      depositId: id,
      amountSleMinor: AMOUNT_SLE_MINOR + 1   // operator/user edited the amount
    }));
    expect(res.status).toBe(200);

    const row = await readRow('deposits', id);
    expect(row.status).toBe('amount_mismatch');
    expect(row.failure_reason).toBe(`collected=${AMOUNT_SLE_MINOR + 1} quoted=${AMOUNT_SLE_MINOR}`);

    expect(await readRowsWhere('transfer_jobs', 'deposit_id', id)).toHaveLength(0);
    expect(await journalsFor('deposit', id)).toEqual([]);

    // A sweep finds nothing to do, and nothing was ever signed.
    expect(await (await runTransferTick(app)).json()).toEqual({ processed: 0 });
    expect(solana.mod.buildSignedUsdcTransfer).not.toHaveBeenCalled();
  });

  test('a missing amount field is treated as a mismatch, not a match', async () => {
    const { id } = await initiateDeposit({ phoneNumber: testPhone(5) });

    const payload = monimeDepositEvent({
      name: 'payment_code.completed', depositId: id, amountSleMinor: AMOUNT_SLE_MINOR
    });
    delete payload.data.amount;

    await postMonimeWebhook(app, payload);

    const row = await readRow('deposits', id);
    expect(row.status).toBe('amount_mismatch');
    expect(row.failure_reason).toBe(`collected=absent quoted=${AMOUNT_SLE_MINOR}`);
    expect(await readRowsWhere('transfer_jobs', 'deposit_id', id)).toHaveLength(0);
  });

  test('an expiry event expires a pending deposit and enqueues nothing', async () => {
    const { id } = await initiateDeposit({ phoneNumber: testPhone(6) });

    await postMonimeWebhook(app, monimeDepositEvent({
      name: 'payment_code.expired', depositId: id, amountSleMinor: AMOUNT_SLE_MINOR
    }));

    expect((await readRow('deposits', id)).status).toBe('expired');
    expect(await readRowsWhere('transfer_jobs', 'deposit_id', id)).toHaveLength(0);
  });

  test('an unsigned webhook is rejected before the event gate', async () => {
    const { id } = await initiateDeposit({ phoneNumber: testPhone(7) });
    const payload = monimeDepositEvent({
      name: 'payment_code.completed', depositId: id, amountSleMinor: AMOUNT_SLE_MINOR
    });

    const res = await app.request('/api/webhooks/monime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Monime-Signature': 't=1,v1=bm90LWEtc2ln' },
      body: JSON.stringify(payload)
    });

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('Unauthorized');
    expect((await readRow('deposits', id)).status).toBe('pending');
    expect(await readRowsWhere('webhook_events', 'event_id', payload.event.id)).toHaveLength(0);
  });
});
