import { jest } from '@jest/globals';

// TEST-CODE-BINDING note: the brief's sample scaffolding names its mocks
// `getLedgerBalance` and `getParsedTransfersForSignature`; the ruling's
// actual repo function set (src/repos/reconciliation.js) is
// `getLedgerTreasuryBalanceMinor` + `getParsedTransfersForSignature` (the
// latter matches verbatim). Plumbing is adapted to the real names; the
// three binding assertions (missed-signature replay, mismatch alert
// wording, STUCK <id> alert wording) are unchanged.

const getRecentTreasurySignatures = jest.fn();
const hasProcessedSignature = jest.fn();
const getParsedTransfersForSignature = jest.fn();
const getLedgerTreasuryBalanceMinor = jest.fn();
const listStaleInflight = jest.fn();
const deleteExpiredIdempotencyKeys = jest.fn();
const listCompletedWithoutJournal = jest.fn();

const getTreasuryUsdcBalanceMinor = jest.fn();
const handleHeliusEvent = jest.fn();
const loggerError = jest.fn();

jest.unstable_mockModule('../../src/repos/reconciliation.js', () => ({
  getRecentTreasurySignatures, hasProcessedSignature, getParsedTransfersForSignature,
  getLedgerTreasuryBalanceMinor, listStaleInflight, deleteExpiredIdempotencyKeys,
  listCompletedWithoutJournal
}));
jest.unstable_mockModule('../../src/utils/solana.js', () => ({
  getTreasuryUsdcBalanceMinor
}));
jest.unstable_mockModule('../../src/routes/webhooks/helius-handler.js', () => ({
  handleHeliusEvent
}));
jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  logger: { error: loggerError, warn: jest.fn(), info: jest.fn(), child: () => ({ error: loggerError, warn: jest.fn(), info: jest.fn() }) }
}));

const {
  runReconcile, sweepMissedEvents, proveBalance, sweepStuckRows, cleanupIdempotencyKeys,
  sweepMissingJournals, default: app
} = await import('../../src/routes/internal/reconcile-tick.js');

beforeEach(() => {
  jest.clearAllMocks();
  // Sensible no-op defaults so a test only overriding the mock it cares
  // about doesn't also have to defend the other four passes.
  getRecentTreasurySignatures.mockResolvedValue([]);
  hasProcessedSignature.mockResolvedValue(true);
  getParsedTransfersForSignature.mockResolvedValue([]);
  getTreasuryUsdcBalanceMinor.mockResolvedValue(0n);
  getLedgerTreasuryBalanceMinor.mockResolvedValue(0n);
  listStaleInflight.mockResolvedValue([]);
  deleteExpiredIdempotencyKeys.mockResolvedValue(0);
  listCompletedWithoutJournal.mockResolvedValue({ deposits: [], withdrawals: [] });
  handleHeliusEvent.mockResolvedValue({ ok: true });
});

describe('pass 1 — missed-event sweep', () => {
  test('a treasury signature never seen by webhooks is replayed through handleHeliusEvent', async () => {
    getRecentTreasurySignatures.mockResolvedValue(['SIG-MISSED']);
    hasProcessedSignature.mockResolvedValue(false); // not in deposits, withdrawals, or unmatched
    getParsedTransfersForSignature.mockResolvedValue([{
      signature: 'SIG-MISSED',
      tokenTransfers: [{ mint: 'USDC_MINT', toUserAccount: 'TREASURY', fromUserAccount: 'SENDER',
        rawTokenAmount: { tokenAmount: '5000000', decimals: 6 } }]
    }]);

    await runReconcile();

    expect(handleHeliusEvent).toHaveBeenCalledWith([expect.objectContaining({ signature: 'SIG-MISSED' })]);
  });

  test('an already-processed signature is skipped without fetching or replaying', async () => {
    getRecentTreasurySignatures.mockResolvedValue(['SIG-KNOWN']);
    hasProcessedSignature.mockResolvedValue(true);

    await sweepMissedEvents();

    expect(getParsedTransfersForSignature).not.toHaveBeenCalled();
    expect(handleHeliusEvent).not.toHaveBeenCalled();
  });

  test('a signature that adapts to no matching transfer is skipped without replaying', async () => {
    getRecentTreasurySignatures.mockResolvedValue(['SIG-EMPTY']);
    hasProcessedSignature.mockResolvedValue(false);
    getParsedTransfersForSignature.mockResolvedValue([]); // no matching USDC transfer found

    await sweepMissedEvents();

    expect(handleHeliusEvent).not.toHaveBeenCalled();
  });
});

describe('pass 2 — balance proof', () => {
  test('ledger treasury balance vs on-chain mismatch beyond tolerance raises an alert log', async () => {
    getTreasuryUsdcBalanceMinor.mockResolvedValue(90_000_000n);
    getLedgerTreasuryBalanceMinor.mockResolvedValue(100_000_000n); // 10 USDC hole

    await runReconcile();

    expect(loggerError).toHaveBeenCalledWith(
      { alert: true },
      expect.stringContaining('RECONCILIATION_MISMATCH')
    );
  });

  test('a matching balance raises no alert', async () => {
    getTreasuryUsdcBalanceMinor.mockResolvedValue(42_000_000n);
    getLedgerTreasuryBalanceMinor.mockResolvedValue(42_000_000n);

    const result = await proveBalance();

    expect(result.mismatch).toBe(false);
    expect(loggerError.mock.calls.some((c) => String(c[1]).includes('RECONCILIATION_MISMATCH'))).toBe(false);
  });
});

describe('pass 3 — stuck-state sweep', () => {
  test('stale in-flight rows are surfaced (processing > 30 min)', async () => {
    listStaleInflight.mockResolvedValue([{ table: 'withdrawals', id: 'w-9', status: 'processing', age_minutes: 45 }]);

    await runReconcile();

    expect(loggerError).toHaveBeenCalledWith(
      { alert: true },
      expect.stringContaining('STUCK w-9')
    );
  });

  test('defaults the threshold to 30 minutes when STUCK_THRESHOLD_MINUTES is unset', async () => {
    delete process.env.STUCK_THRESHOLD_MINUTES;

    await sweepStuckRows();

    expect(listStaleInflight).toHaveBeenCalledWith(30);
  });

  test('honors STUCK_THRESHOLD_MINUTES when set', async () => {
    process.env.STUCK_THRESHOLD_MINUTES = '15';

    await sweepStuckRows();

    expect(listStaleInflight).toHaveBeenCalledWith(15);
    delete process.env.STUCK_THRESHOLD_MINUTES;
  });
});

describe('pass 4 — housekeeping', () => {
  test('deletes expired idempotency keys and reports the count', async () => {
    deleteExpiredIdempotencyKeys.mockResolvedValue(7);

    const result = await cleanupIdempotencyKeys();

    expect(deleteExpiredIdempotencyKeys).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ deleted: 7 });
  });
});

describe('pass 5 — journal-presence sweep', () => {
  test('a completed deposit with only the collection key alerts on the missing payout key', async () => {
    listCompletedWithoutJournal.mockResolvedValue({
      deposits: [{ id: 'd-1', missing: ['deposit_payout'] }],
      withdrawals: []
    });

    await runReconcile();

    expect(loggerError).toHaveBeenCalledWith(
      { alert: true },
      '[Reconcile] ALERT MISSING_JOURNAL deposit_payout:d-1'
    );
  });

  test('a clean case (both journals present) raises no alert', async () => {
    listCompletedWithoutJournal.mockResolvedValue({ deposits: [], withdrawals: [] });

    const result = await sweepMissingJournals();

    expect(result).toEqual({ deposits: [], withdrawals: [] });
    expect(loggerError.mock.calls.some((c) => String(c[1]).includes('MISSING_JOURNAL'))).toBe(false);
  });

  test('a completed withdrawal missing both keys alerts once per missing key', async () => {
    listCompletedWithoutJournal.mockResolvedValue({
      deposits: [],
      withdrawals: [{ id: 'w-1', missing: ['withdrawal_receipt', 'withdrawal_payout'] }]
    });

    await sweepMissingJournals();

    expect(loggerError).toHaveBeenCalledWith({ alert: true }, '[Reconcile] ALERT MISSING_JOURNAL withdrawal_receipt:w-1');
    expect(loggerError).toHaveBeenCalledWith({ alert: true }, '[Reconcile] ALERT MISSING_JOURNAL withdrawal_payout:w-1');
  });
});

describe('pass isolation', () => {
  test('the first pass throwing does not stop the remaining four from running', async () => {
    getRecentTreasurySignatures.mockRejectedValue(new Error('RPC unreachable'));

    const results = await runReconcile();

    expect(results.sweepMissedEvents).toEqual({ ok: false, error: 'RPC unreachable' });
    // The remaining four passes still ran despite pass 1 throwing.
    expect(getTreasuryUsdcBalanceMinor).toHaveBeenCalledTimes(1);
    expect(listStaleInflight).toHaveBeenCalledTimes(1);
    expect(deleteExpiredIdempotencyKeys).toHaveBeenCalledTimes(1);
    expect(listCompletedWithoutJournal).toHaveBeenCalledTimes(1);
    expect(results.proveBalance.ok).toBe(true);
    expect(results.sweepStuckRows.ok).toBe(true);
    expect(results.cleanupIdempotencyKeys.ok).toBe(true);
    expect(results.sweepMissingJournals.ok).toBe(true);
    expect(loggerError).toHaveBeenCalledWith(
      { alert: true },
      expect.stringContaining('pass sweepMissedEvents threw')
    );
  });
});

describe('cron auth on GET/POST /', () => {
  const OLD_SECRET = process.env.CRON_SECRET;
  beforeEach(() => { process.env.CRON_SECRET = 'test-cron-secret'; });
  afterAll(() => { process.env.CRON_SECRET = OLD_SECRET; });

  test('accepts X-Cron-Secret and returns a per-pass summary', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'X-Cron-Secret': 'test-cron-secret' }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('sweepMissedEvents');
    expect(body).toHaveProperty('proveBalance');
    expect(body).toHaveProperty('sweepStuckRows');
    expect(body).toHaveProperty('cleanupIdempotencyKeys');
    expect(body).toHaveProperty('sweepMissingJournals');
  });

  test('accepts GET with Authorization bearer (Vercel native cron)', async () => {
    const res = await app.request('/', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-cron-secret' }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('sweepMissedEvents');
  });

  test('rejects unauthenticated GET', async () => {
    const res = await app.request('/', { method: 'GET' });
    expect(res.status).toBe(401);
  });

  test('rejects a wrong or missing secret', async () => {
    const res = await app.request('/', { method: 'POST', headers: { 'X-Cron-Secret': 'wrong' } });
    expect(res.status).toBe(401);
    expect(getRecentTreasurySignatures).not.toHaveBeenCalled();

    const res2 = await app.request('/', { method: 'POST' });
    expect(res2.status).toBe(401);
  });
});
