//@ts-check

/**
 * Ledger invariants after real money movement (task D2, step 5).
 *
 * Two assertions, both against real Postgres:
 *  1. EVERY journal in the database balances per currency. This is the
 *     JS-side reading of 0015's `assert_journal_balanced()` deferred
 *     constraint trigger — if a posting helper ever assembled a one-sided
 *     journal, Postgres would have rejected the whole `post_journal` call
 *     and the journal would be missing instead of unbalanced, so this check
 *     catches BOTH failure shapes (a skewed journal, or a journal that
 *     silently never posted).
 *  2. The `treasury_usdc` ledger delta equals the net movement the mocked
 *     chain reported: inbound (verified withdrawal receipts) minus outbound
 *     (broadcast deposit payouts). `treasury_usdc` is an asset account, so
 *     its signed balance is sum(debit) - sum(credit) — receipts debit it,
 *     payouts credit it.
 *
 * The ledger tables are never truncated (0015's immutability triggers block
 * DELETE by design — see helpers.js), so both assertions are written to hold
 * regardless of what earlier spec files left behind: (1) is a global
 * invariant, and (2) is measured as a before/after delta.
 */

import { jest } from '@jest/globals';
import {
  describeIntegration, solanaMocks, installMonimeMock, resetAll, resetMoneyTables,
  seedApplication, testPhone, freshWallet, fakeSignature, apiPost, postMonimeWebhook,
  runTransferTick, monimeDepositEvent, monimePayoutEvent, readRow, journalsFor,
  journalImbalances, ledgerAccountBalance, serviceClient
} from './helpers.js';

const solana = solanaMocks();
jest.unstable_mockModule('../../src/utils/solana.js', () => solana.mod);
jest.unstable_mockModule('@vercel/functions', () => ({ waitUntil: jest.fn() }));

const { app } = await import('../../api/index.js');

const DEPOSIT_SLE_MINOR = 100_000;            // 1,000.00 SLE
const DEPOSIT_USDC_MINOR = 40_000_000;        // at 25 SLE/USDC
const WITHDRAWAL_USDC_MINOR = 5_000_000;      // 5.000000 USDC
const WITHDRAWAL_GROSS_SLE_MINOR = 12_500;    // 5 * 25 = 125.00 SLE
const WITHDRAWAL_NET_SLE_MINOR = 12_375;      // less 100 bps
const WITHDRAWAL_FEE_SLE_MINOR = 125;

describeIntegration('ledger invariants after both legs (real Postgres)', () => {
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
   * Full deposit leg: initiate -> signed webhook -> real sweep -> completed.
   * @param {number} phoneSeed
   * @returns {Promise<string>}
   */
  async function runDepositLeg(phoneSeed) {
    const res = await apiPost(app, '/api/v1/deposits', {
      amount: DEPOSIT_SLE_MINOR,
      currency: 'SLE',
      paymentMethod: 'ussd',
      phoneNumber: testPhone(phoneSeed),
      walletAddress: freshWallet()
    }, { apiKey });
    expect(res.status).toBe(201);
    const id = (await res.json()).id;

    await postMonimeWebhook(app, monimeDepositEvent({
      name: 'payment_code.completed', depositId: id, amountSleMinor: DEPOSIT_SLE_MINOR
    }));
    await runTransferTick(app);

    expect((await readRow('deposits', id)).status).toBe('completed');
    return id;
  }

  /**
   * Full withdrawal leg via the MANUAL confirm path, so the inbound USDC is
   * booked by `verifyIncomingUsdcTransfer` — the mocked chain's only inbound
   * signal. (The Helius path is covered in withdrawal-lifecycle.test.js; it
   * reports an observed transfer rather than a verified one, which is why the
   * net-movement assertion below uses the confirm path.)
   * @param {number} phoneSeed
   * @returns {Promise<string>}
   */
  async function runWithdrawalLeg(phoneSeed) {
    const res = await apiPost(app, '/api/v1/withdrawals', {
      amountUsdc: WITHDRAWAL_USDC_MINOR,
      phoneNumber: testPhone(phoneSeed),
      providerCode: 'm17',
      fromWalletAddress: freshWallet()
    }, { apiKey });
    expect(res.status).toBe(201);
    const id = (await res.json()).id;

    const confirmRes = await apiPost(app, `/api/v1/withdrawals/${id}/confirm`,
      { solanaTxSignature: fakeSignature(`ledger-${id}`) }, { apiKey });
    expect(confirmRes.status).toBe(200);
    const confirmed = await confirmRes.json();

    await postMonimeWebhook(app, monimePayoutEvent({
      name: 'payout.completed', payoutId: confirmed.monimePayoutId, withdrawalId: id
    }));

    expect((await readRow('withdrawals', id)).status).toBe('completed');
    return id;
  }

  test('treasury_usdc delta equals the mocked chain net movement, and every journal balances', async () => {
    const before = await ledgerAccountBalance('treasury_usdc');

    const depositId = await runDepositLeg(401);
    const withdrawalId = await runWithdrawalLeg(402);

    const after = await ledgerAccountBalance('treasury_usdc');

    // What the mocked chain actually reported.
    expect(solana.chain.outMinor).toBe(DEPOSIT_USDC_MINOR);
    expect(solana.chain.inMinor).toBe(WITHDRAWAL_USDC_MINOR);

    const netMovement = BigInt(solana.chain.inMinor - solana.chain.outMinor);
    expect(after - before).toBe(netMovement);

    // Both legs posted their full pair of journals.
    expect((await journalsFor('deposit', depositId)).map((j) => j.kind))
      .toEqual(['deposit_collection', 'deposit_payout']);
    expect((await journalsFor('withdrawal', withdrawalId)).map((j) => j.kind))
      .toEqual(['withdrawal_receipt', 'withdrawal_payout']);

    expect(await journalImbalances()).toEqual([]);
  }, 60_000);

  test('the withdrawal fee lands in fee_income_sle, gross minus net', async () => {
    const feeBefore = await ledgerAccountBalance('fee_income_sle');
    const payableBefore = await ledgerAccountBalance('user_payable_sle');

    await runWithdrawalLeg(411);

    // fee_income_sle is an income account: credits increase it, so its
    // signed (debit - credit) balance moves DOWN by the fee.
    expect((await ledgerAccountBalance('fee_income_sle')) - feeBefore)
      .toBe(BigInt(-WITHDRAWAL_FEE_SLE_MINOR));
    expect(WITHDRAWAL_GROSS_SLE_MINOR - WITHDRAWAL_NET_SLE_MINOR).toBe(WITHDRAWAL_FEE_SLE_MINOR);

    // The payable was credited the net and then cleared by the payout,
    // leaving it exactly where it started.
    expect(await ledgerAccountBalance('user_payable_sle')).toBe(payableBefore);
    expect(await journalImbalances()).toEqual([]);
  }, 60_000);

  test('a completed deposit leaves user_payable_usdc flat and moves fx both ways', async () => {
    const payableBefore = await ledgerAccountBalance('user_payable_usdc');
    const fxUsdcBefore = await ledgerAccountBalance('fx_usdc');
    const fxSleBefore = await ledgerAccountBalance('fx_sle');
    const monimeSleBefore = await ledgerAccountBalance('monime_sle');

    await runDepositLeg(421);

    // collection credits the payable, payout debits it: net zero.
    expect(await ledgerAccountBalance('user_payable_usdc')).toBe(payableBefore);
    // The SLE collected became USDC owed: fx_usdc debited, fx_sle credited.
    expect((await ledgerAccountBalance('fx_usdc')) - fxUsdcBefore)
      .toBe(BigInt(DEPOSIT_USDC_MINOR));
    expect((await ledgerAccountBalance('fx_sle')) - fxSleBefore)
      .toBe(BigInt(-DEPOSIT_SLE_MINOR));
    // Monime's SLE float grew by exactly what was collected.
    expect((await ledgerAccountBalance('monime_sle')) - monimeSleBefore)
      .toBe(BigInt(DEPOSIT_SLE_MINOR));

    expect(await journalImbalances()).toEqual([]);
  }, 60_000);

  test('the ledger refuses to be rewritten', async () => {
    const depositId = await runDepositLeg(431);
    const journals = await journalsFor('deposit', depositId);
    expect(journals.length).toBeGreaterThan(0);

    // 0015's forbid_ledger_mutation() trigger, exercised for real.
    const { error: updateError } = await serviceClient()
      .from('ledger_journals').update({ kind: 'adjustment' }).eq('id', journals[0].id);
    expect(updateError?.message).toMatch(/append-only/i);

    const { error: deleteError } = await serviceClient()
      .from('ledger_entries').delete().eq('journal_id', journals[0].id);
    expect(deleteError?.message).toMatch(/append-only/i);

    expect(await journalImbalances()).toEqual([]);
  }, 60_000);
});
