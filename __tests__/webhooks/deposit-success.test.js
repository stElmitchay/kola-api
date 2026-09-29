import { jest } from '@jest/globals';

// B3 adaptation: handleDepositSuccess no longer transfers inline — it CASes
// pending → confirmed and enqueues a transfer job; the actual payout runs
// off-path in the transfer-tick worker. transferUsdc is gone from this
// file's imports entirely.
const updateDepositIfStatus = jest.fn();
const updateDeposit = jest.fn();
const enqueueTransfer = jest.fn();
const sweepOpenJobs = jest.fn();
const waitUntil = jest.fn();

jest.unstable_mockModule('../../src/repos/deposits.js', () => ({
  updateDepositIfStatus, updateDeposit,
  getDepositById: jest.fn(), createDeposit: jest.fn(),
  getDeposit: jest.fn(), listDeposits: jest.fn()
}));
jest.unstable_mockModule('../../src/repos/withdrawals.js', () => ({
  getWithdrawalById: jest.fn(), getWithdrawalByMonimePayoutId: jest.fn(),
  updateWithdrawal: jest.fn()
}));
jest.unstable_mockModule('../../src/repos/webhook-events.js', () => ({
  recordWebhookEvent: jest.fn()
}));
jest.unstable_mockModule('../../src/repos/transfer-jobs.js', () => ({
  enqueueTransfer
}));
jest.unstable_mockModule('../../src/routes/internal/transfer-tick.js', () => ({
  sweepOpenJobs, DEFAULT_SWEEP_LIMIT: 20, processJob: jest.fn(), default: {}
}));
jest.unstable_mockModule('@vercel/functions', () => ({ waitUntil }));

const { handleDepositSuccess } = await import('../../src/routes/webhooks/monime.js');

const deposit = { id: 'd-1', status: 'pending', wallet_address: 'WALLET', amount_usdc: 5_000_000 };

beforeEach(() => jest.clearAllMocks());

test('claims via CAS pending -> confirmed before enqueueing, exactly once', async () => {
  updateDepositIfStatus.mockResolvedValueOnce({ data: { ...deposit, status: 'confirmed' }, error: null }); // claim
  sweepOpenJobs.mockResolvedValueOnce(1);

  await handleDepositSuccess(deposit);

  expect(updateDepositIfStatus).toHaveBeenCalledTimes(1);
  expect(updateDepositIfStatus).toHaveBeenCalledWith('d-1', 'pending', { status: 'confirmed' });
  expect(enqueueTransfer).toHaveBeenCalledTimes(1);
  expect(enqueueTransfer).toHaveBeenCalledWith({
    depositId: 'd-1', destination: 'WALLET', amountUsdc: 5_000_000
  });
});

test('a duplicate delivery whose CAS claim loses does NOT enqueue', async () => {
  updateDepositIfStatus.mockResolvedValueOnce({ data: null, error: null }); // lost the claim
  await handleDepositSuccess(deposit);
  expect(enqueueTransfer).not.toHaveBeenCalled();
  expect(waitUntil).not.toHaveBeenCalled();
});

test('a claim-read error does NOT enqueue', async () => {
  updateDepositIfStatus.mockResolvedValueOnce({ data: null, error: new Error('db down') });
  await handleDepositSuccess(deposit);
  expect(enqueueTransfer).not.toHaveBeenCalled();
});

test('a failing waitUntil kick never breaks the webhook path', async () => {
  updateDepositIfStatus.mockResolvedValueOnce({ data: { ...deposit, status: 'confirmed' }, error: null });
  waitUntil.mockImplementationOnce(() => { throw new Error('no execution context'); });

  await expect(handleDepositSuccess(deposit)).resolves.toBeUndefined();
  expect(enqueueTransfer).toHaveBeenCalledTimes(1); // still enqueued — the kick is best-effort only
});
