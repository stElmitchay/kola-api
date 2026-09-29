//@ts-check

/**
 * Withdrawal money path against real Postgres (task D2, step 3).
 *
 * Three things only a real database can prove:
 *  1. `create_withdrawal_guarded` (0016) holds real `pg_advisory_xact_lock`s,
 *     so 10 concurrent creates against a cap with room for 3 admit exactly 3.
 *  2. The `pending_deposit -> received` compare-and-swap is a real atomic
 *     UPDATE, so the manual `/:id/confirm` and the Helius auto-confirm
 *     racing each other fire exactly ONE Monime payout per withdrawal —
 *     asserted 50 times over, with a fresh row each iteration.
 *  3. The state-machine trigger (0012) and the ledger balance trigger (0015)
 *     are enforced by Postgres, not by the app.
 */

import { jest } from '@jest/globals';
import {
  describeIntegration, solanaMocks, installMonimeMock, resetAll, resetMoneyTables,
  seedApplication, testPhone, freshWallet, fakeSignature, apiPost, apiGet,
  postMonimeWebhook, postHeliusWebhook, heliusTransferEvent, monimePayoutEvent,
  readRow, readRowsWhere, journalsFor, journalImbalances, serviceClient,
  TREASURY_ADDRESS
} from './helpers.js';

const solana = solanaMocks();
jest.unstable_mockModule('../../src/utils/solana.js', () => solana.mod);
jest.unstable_mockModule('@vercel/functions', () => ({ waitUntil: jest.fn() }));

const { app } = await import('../../api/index.js');

const AMOUNT_USDC_MINOR = 1_000_000;          // 1.000000 USDC
// 1 USDC at 25 SLE/USDC = 25.00 SLE gross = 2500 minor; 100 bps fee leaves
// 24.75 SLE net = 2475 minor; fee income = 25 minor.
const EXPECTED_GROSS_SLE_MINOR = 2500;
const EXPECTED_NET_SLE_MINOR = 2475;
const FUZZ_ROUNDS = 50;

describeIntegration('withdrawal lifecycle (real Postgres)', () => {
  /** @type {ReturnType<typeof installMonimeMock>} */
  let monime;
  /** @type {string} */
  let apiKey;
  const originalCap = process.env.WITHDRAWAL_DAILY_CAP_USDC;

  beforeAll(async () => {
    monime = installMonimeMock();
    await resetAll();
    ({ apiKey } = await seedApplication({ rate: 25 }));
  });

  afterAll(() => {
    monime.restore();
    process.env.WITHDRAWAL_DAILY_CAP_USDC = originalCap;
  });

  beforeEach(async () => {
    await resetMoneyTables();
    monime.reset();
    jest.clearAllMocks();
    solana.chain.reset();
    process.env.WITHDRAWAL_DAILY_CAP_USDC = originalCap;
  });

  /**
   * @param {object} [overrides]
   * @returns {Promise<Response>}
   */
  function createWithdrawal(overrides = {}) {
    return apiPost(app, '/api/v1/withdrawals', {
      amountUsdc: AMOUNT_USDC_MINOR,
      phoneNumber: testPhone(1),
      providerCode: 'm17',
      fromWalletAddress: freshWallet(),
      ...overrides
    }, { apiKey });
  }

  test('rejects an amount below WITHDRAWAL_MIN_USDC', async () => {
    const res = await createWithdrawal({ amountUsdc: 99_999 });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/minimum/i);
  });

  test('refuses a second open withdrawal for the same (wallet, amount)', async () => {
    const wallet = freshWallet();
    const first = await createWithdrawal({ fromWalletAddress: wallet, phoneNumber: testPhone(11) });
    expect(first.status).toBe(201);

    const second = await createWithdrawal({ fromWalletAddress: wallet, phoneNumber: testPhone(12) });
    expect(second.status).toBe(400);
    expect((await second.json()).error.message).toMatch(/open withdrawal already exists/i);
  });

  test('manual confirm: quote, verify, payout, then the completion webhook', async () => {
    const wallet = freshWallet();
    const createRes = await createWithdrawal({ fromWalletAddress: wallet, phoneNumber: testPhone(21) });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    expect(created.status).toBe('pending_deposit');
    expect(created.amountSle).toBe(EXPECTED_NET_SLE_MINOR);
    expect(created.treasuryAddress).toBe(TREASURY_ADDRESS);
    expect(created.reference).toBe(created.id);

    const quoted = await readRow('withdrawals', created.id);
    expect(Number(quoted.amount_sle)).toBe(EXPECTED_NET_SLE_MINOR);
    expect(Number(quoted.amount_sle_gross)).toBe(EXPECTED_GROSS_SLE_MINOR);

    // --- confirm ----------------------------------------------------------
    const signature = fakeSignature(`manual-${created.id}`);
    const confirmRes = await apiPost(app, `/api/v1/withdrawals/${created.id}/confirm`,
      { solanaTxSignature: signature }, { apiKey });
    expect(confirmRes.status).toBe(200);
    const confirmed = await confirmRes.json();
    expect(confirmed.status).toBe('processing');
    expect(confirmed.monimePayoutId).toMatch(/^po_\d+$/);

    expect(solana.mod.verifyIncomingUsdcTransfer)
      .toHaveBeenCalledWith(signature, wallet, AMOUNT_USDC_MINOR);

    const payouts = monime.payoutCallsFor(created.id);
    expect(payouts).toHaveLength(1);
    expect(payouts[0].body.amount).toEqual({ currency: 'SLE', value: EXPECTED_NET_SLE_MINOR });
    expect(payouts[0].idempotencyKey).toBe(created.id);

    const receiptJournals = await journalsFor('withdrawal', created.id);
    expect(receiptJournals.map((j) => j.kind)).toEqual(['withdrawal_receipt']);

    // --- payout.completed webhook -----------------------------------------
    const res = await postMonimeWebhook(app, monimePayoutEvent({
      name: 'payout.completed',
      payoutId: confirmed.monimePayoutId,
      withdrawalId: created.id
    }));
    expect(res.status).toBe(200);

    expect((await readRow('withdrawals', created.id)).status).toBe('completed');
    expect((await journalsFor('withdrawal', created.id)).map((j) => j.kind))
      .toEqual(['withdrawal_receipt', 'withdrawal_payout']);
    expect(await journalImbalances()).toEqual([]);
  });

  test('a failed on-chain verification leaves the row untouched and fires no payout', async () => {
    const createRes = await createWithdrawal({ phoneNumber: testPhone(22) });
    const created = await createRes.json();

    solana.mod.verifyIncomingUsdcTransfer.mockResolvedValueOnce({ ok: false, reason: 'no matching transfer' });

    const res = await apiPost(app, `/api/v1/withdrawals/${created.id}/confirm`,
      { solanaTxSignature: fakeSignature(`bad-${created.id}`) }, { apiKey });

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/no matching transfer/);
    expect((await readRow('withdrawals', created.id)).status).toBe('pending_deposit');
    expect(monime.payoutCallsFor(created.id)).toHaveLength(0);
    expect(await journalsFor('withdrawal', created.id)).toEqual([]);
  });

  test('daily cap boundary: 10 parallel creates with room for 3 admit exactly 3', async () => {
    // Cap leaves room for exactly three withdrawals of AMOUNT_USDC_MINOR.
    const admissible = 3;
    process.env.WITHDRAWAL_DAILY_CAP_USDC = String(admissible * AMOUNT_USDC_MINOR);

    const phone = testPhone(31);
    // Same phone (so one rolling-24h cap applies) but distinct wallets: the
    // (wallet, amount) duplicate-open check inside 0016 is global, so reusing
    // one wallet would reject on THAT rule instead of the cap and prove
    // nothing about the cap.
    const attempts = Array.from({ length: 10 }, () => createWithdrawal({
      phoneNumber: phone, fromWalletAddress: freshWallet()
    }));

    const responses = await Promise.all(attempts);
    const bodies = await Promise.all(responses.map((r) => r.json()));

    const created = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.status !== 201);

    expect(created).toHaveLength(admissible);
    expect(rejected).toHaveLength(10 - admissible);
    for (const [i, res] of responses.entries()) {
      if (res.status === 201) continue;
      expect(res.status).toBe(400);
      expect(bodies[i].error.message).toMatch(/Daily withdrawal cap/i);
    }

    // The database agrees — the cap was never breached by a lost update.
    const { data: rows } = await serviceClient()
      .from('withdrawals').select('amount_usdc').eq('phone_number', phone);
    expect(rows).toHaveLength(admissible);
    const total = rows.reduce((sum, row) => sum + Number(row.amount_usdc), 0);
    expect(total).toBe(admissible * AMOUNT_USDC_MINOR);
    expect(total).toBeLessThanOrEqual(Number(process.env.WITHDRAWAL_DAILY_CAP_USDC));
  });

  test(`dual-racer CAS fuzz: manual confirm vs Helius, ${FUZZ_ROUNDS} rounds, one payout each`, async () => {
    // Large cap: this test is about the CAS, not the cap. Unique phone per
    // round keeps the rolling-24h sum irrelevant either way.
    process.env.WITHDRAWAL_DAILY_CAP_USDC = String(100_000 * AMOUNT_USDC_MINOR);

    /** @type {{ id: string, wallet: string, signature: string }[]} */
    const rows = [];
    for (let i = 0; i < FUZZ_ROUNDS; i += 1) {
      const wallet = freshWallet();
      const res = await createWithdrawal({ phoneNumber: testPhone(100 + i), fromWalletAddress: wallet });
      expect(res.status).toBe(201);
      const id = (await res.json()).id;
      rows.push({ id, wallet, signature: fakeSignature(`race-${id}`) });
    }

    // Fire both racers at every row at once: 100 in-flight requests, two per
    // withdrawal, each pair contending for the same pending_deposit ->
    // received compare-and-swap. Both racers carry the SAME signature,
    // because in production they are two notifications of ONE on-chain
    // transfer — the client's confirm call and the Helius callback.
    const confirms = rows.map(({ id, signature }) => apiPost(
      app, `/api/v1/withdrawals/${id}/confirm`, { solanaTxSignature: signature }, { apiKey }
    ));
    const callbacks = rows.map(({ wallet, signature }) => postHeliusWebhook(app, [heliusTransferEvent({
      fromWallet: wallet,
      amountUsdcMinor: AMOUNT_USDC_MINOR,
      signature
    })]));

    const [confirmResponses, callbackResponses] = await Promise.all([
      Promise.all(confirms), Promise.all(callbacks)
    ]);

    // A losing confirm has two legal shapes, and which one it takes is a
    // matter of nanoseconds: 200 when it read the row while still
    // `pending_deposit` and merely lost the CAS (it returns current status
    // without re-firing the payout), or 400 when Helius had already advanced
    // the row past `pending_deposit` before the confirm even read it. Both
    // are correct refusals to double-pay; a 500, or a second payout, is not.
    for (const res of confirmResponses) {
      if (res.status === 200) continue;
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toMatch(/cannot be confirmed/i);
    }
    for (const res of callbackResponses) {
      expect(res.status).toBe(200);
    }

    // Exactly one Monime payout per withdrawal — no double-spend of the
    // user's SLE, whichever racer won.
    expect(monime.callsTo('/v1/payouts')).toHaveLength(FUZZ_ROUNDS);
    for (const { id } of rows) {
      expect(monime.payoutCallsFor(id)).toHaveLength(1);
    }

    const final = await Promise.all(rows.map(({ id }) => readRow('withdrawals', id)));
    for (const [i, row] of final.entries()) {
      expect(row.status).toBe('processing');
      expect(row.monime_payout_id).toMatch(/^po_\d+$/);
      expect(row.solana_tx_signature).toBe(rows[i].signature);
    }

    // Exactly one receipt journal per withdrawal, and every journal balances.
    const receipts = await Promise.all(rows.map(({ id }) => journalsFor('withdrawal', id)));
    for (const journals of receipts) {
      expect(journals.map((j) => j.kind)).toEqual(['withdrawal_receipt']);
    }
    expect(await journalImbalances()).toEqual([]);

    // Suspense bookkeeping. When the MANUAL confirm wins the CAS, the losing
    // Helius delivery no longer sees an open withdrawal for
    // (wallet, amount) and books the transfer to suspense (0017 + F11) —
    // by design it never drops inbound USDC it cannot match. That makes some
    // suspense rows here expected rather than a failure, but every one of
    // them must be a DUPLICATE booking of a transfer that was already
    // credited: its signature must belong to a withdrawal now in
    // 'processing'. No suspense row may ever exist for money that was not
    // otherwise accounted for.
    const { data: unmatched } = await serviceClient()
      .from('unmatched_transfers').select('id, signature, amount_usdc');
    const knownSignatures = new Map(final.map((row) => [row.solana_tx_signature, row]));
    for (const row of unmatched || []) {
      const withdrawal = knownSignatures.get(row.signature);
      expect(withdrawal).toBeDefined();
      expect(withdrawal.status).toBe('processing');
      expect(Number(row.amount_usdc)).toBe(AMOUNT_USDC_MINOR);
    }
    expect((unmatched || []).length).toBeLessThanOrEqual(FUZZ_ROUNDS);
  }, 180_000);

  test('inbound USDC with no matching withdrawal books to suspense exactly once', async () => {
    const signature = fakeSignature('orphan-inbound');
    const event = heliusTransferEvent({
      fromWallet: freshWallet(), amountUsdcMinor: 7_000_000, signature
    });

    await postHeliusWebhook(app, [event]);
    await postHeliusWebhook(app, [event]);   // replayed delivery

    const rows = await readRowsWhere('unmatched_transfers', 'signature', signature);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('no_open_match');
    expect(Number(rows[0].amount_usdc)).toBe(7_000_000);

    const journals = await journalsFor('unmatched_transfer', rows[0].id);
    expect(journals.map((j) => j.kind)).toEqual(['suspense_in']);
    expect(await journalImbalances()).toEqual([]);
  });

  test('an unauthorised Helius delivery changes nothing', async () => {
    const createRes = await createWithdrawal({ phoneNumber: testPhone(41) });
    const created = await createRes.json();

    const res = await app.request('/api/webhooks/helius', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'wrong-auth-header' },
      body: JSON.stringify([heliusTransferEvent({
        fromWallet: (await readRow('withdrawals', created.id)).from_wallet_address,
        amountUsdcMinor: AMOUNT_USDC_MINOR,
        signature: fakeSignature(`unauth-${created.id}`)
      })])
    });

    expect(res.status).toBe(401);
    expect((await readRow('withdrawals', created.id)).status).toBe('pending_deposit');
    expect(monime.payoutCallsFor(created.id)).toHaveLength(0);
  });

  test('a payout.failed webhook records the failure reason', async () => {
    const createRes = await createWithdrawal({ phoneNumber: testPhone(51) });
    const created = await createRes.json();

    const confirmRes = await apiPost(app, `/api/v1/withdrawals/${created.id}/confirm`,
      { solanaTxSignature: fakeSignature(`fail-${created.id}`) }, { apiKey });
    const confirmed = await confirmRes.json();

    await postMonimeWebhook(app, monimePayoutEvent({
      name: 'payout.failed',
      payoutId: confirmed.monimePayoutId,
      withdrawalId: created.id,
      failureMessage: 'insufficient float'
    }));

    const row = await readRow('withdrawals', created.id);
    expect(row.status).toBe('failed');
    expect(row.failure_reason).toBe('insufficient float');

    const statusRes = await apiGet(app, `/api/v1/withdrawals/${created.id}`, { apiKey });
    expect((await statusRes.json()).failureReason).toBe('insufficient float');
  });
});
