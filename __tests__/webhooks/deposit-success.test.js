import { jest } from '@jest/globals';

const transferUsdc = jest.fn();
const updateDepositIfStatus = jest.fn();
const updateDeposit = jest.fn();

jest.unstable_mockModule('../../src/utils/solana.js', () => ({
  transferUsdc, getTreasuryAddress: () => 'TREASURY'
}));
jest.unstable_mockModule('../../src/repos/deposits.js', () => ({
  updateDepositIfStatus, updateDeposit,
  getDepositById: jest.fn(), createDeposit: jest.fn(),
  getDeposit: jest.fn(), listDeposits: jest.fn()
}));
jest.unstable_mockModule('../../src/repos/withdrawals.js', () => ({
  getWithdrawalById: jest.fn(), getWithdrawalByMonimePayoutId: jest.fn(),
  updateWithdrawal: jest.fn()
}));

const { handleDepositSuccess } = await import('../../src/routes/webhooks/monime.js');

const deposit = { id: 'd-1', status: 'pending', wallet_address: 'WALLET', amount_usdc: 5_000_000 };

beforeEach(() => jest.clearAllMocks());

test('claims via CAS before transferring, exactly once', async () => {
  updateDepositIfStatus.mockResolvedValueOnce({ data: { ...deposit, status: 'processing' }, error: null }); // claim
  transferUsdc.mockResolvedValueOnce('SIG1');
  updateDepositIfStatus.mockResolvedValueOnce({ data: { ...deposit, status: 'completed' }, error: null }); // finish

  await handleDepositSuccess(deposit);

  expect(updateDepositIfStatus).toHaveBeenNthCalledWith(1, 'd-1', 'pending', { status: 'processing' });
  expect(transferUsdc).toHaveBeenCalledTimes(1);
});

test('a duplicate delivery whose CAS claim loses does NOT transfer', async () => {
  updateDepositIfStatus.mockResolvedValueOnce({ data: null, error: null }); // lost the claim
  await handleDepositSuccess(deposit);
  expect(transferUsdc).not.toHaveBeenCalled();
});

test('transfer failure is recorded from the claimed state only', async () => {
  updateDepositIfStatus.mockResolvedValueOnce({ data: { ...deposit, status: 'processing' }, error: null });
  transferUsdc.mockRejectedValueOnce(new Error('rpc down'));
  updateDepositIfStatus.mockResolvedValueOnce({ data: { ...deposit, status: 'failed' }, error: null });

  await handleDepositSuccess(deposit);

  expect(updateDepositIfStatus).toHaveBeenLastCalledWith('d-1', 'processing',
    expect.objectContaining({ status: 'failed' }));
  expect(updateDeposit).not.toHaveBeenCalled(); // no unconditional writes remain
});
