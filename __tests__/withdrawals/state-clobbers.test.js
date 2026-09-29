import { jest } from '@jest/globals';

const updateWithdrawal = jest.fn();
const updateWithdrawalIfStatus = jest.fn();
const createPayout = jest.fn();
const getWithdrawalRepo = jest.fn();
const postWithdrawalReceipt = jest.fn();

jest.unstable_mockModule('../../src/repos/withdrawals.js', () => ({
  createWithdrawal: jest.fn(), getWithdrawal: getWithdrawalRepo,
  listWithdrawals: jest.fn(), updateWithdrawal, updateWithdrawalIfStatus,
  sumWithdrawalsForPhoneSince: jest.fn(), findPendingByWalletAndAmount: jest.fn()
}));
jest.unstable_mockModule('../../src/utils/monime.js', () => ({ createPayout }));
jest.unstable_mockModule('../../src/utils/solana.js', () => ({
  getTreasuryAddress: () => 'TREASURY', verifyIncomingUsdcTransfer: jest.fn()
}));
jest.unstable_mockModule('../../src/repos/exchange-rates.js', () => ({
  getActiveRate: jest.fn(), assertRateFresh: jest.fn()
}));
// B4: withdrawal_receipt posts right after the pending_deposit -> received
// CAS claim succeeds in confirmWithdrawal.
jest.unstable_mockModule('../../src/repos/ledger.js', () => ({ postWithdrawalReceipt }));

const { confirmWithdrawal, triggerPayoutForWithdrawal } =
  await import('../../src/routes/withdrawals/withdrawals.js');

beforeEach(() => jest.clearAllMocks());

test('F7: expiry is CAS-guarded — a concurrently-claimed row is not stomped to expired', async () => {
  const expired = {
    id: 'w-1', status: 'pending_deposit',
    expires_at: new Date(Date.now() - 60_000).toISOString()
  };
  getWithdrawalRepo.mockResolvedValue({ data: expired, error: null });
  // CAS loses: Helius already advanced the row past pending_deposit
  updateWithdrawalIfStatus.mockResolvedValue({ data: null, error: null });

  await expect(confirmWithdrawal('w-1', 'app-1', 'SIG')).rejects.toThrow(/expired|status/i);
  expect(updateWithdrawal).not.toHaveBeenCalledWith('w-1', { status: 'expired' });
});

test('F8: processing write is CAS from received; a lost CAS still records the payout id without touching status', async () => {
  createPayout.mockResolvedValue({ id: 'mp-1', status: 'processing' });
  // completion webhook won the race: CAS received→processing returns null
  updateWithdrawalIfStatus.mockResolvedValue({ data: null, error: null });

  await triggerPayoutForWithdrawal({ id: 'w-2', amount_sle: 1000, phone_number: '+23276000000', provider_code: 'm17' });

  expect(updateWithdrawalIfStatus).toHaveBeenCalledWith('w-2', 'received',
    expect.objectContaining({ status: 'processing', monime_payout_id: 'mp-1' }));
  expect(updateWithdrawal).toHaveBeenCalledWith('w-2', { monime_payout_id: 'mp-1' }); // id preserved, status untouched
});

test('F19: duplicate-open error does not reveal the other withdrawal id', async () => {
  const { findPendingByWalletAndAmount, sumWithdrawalsForPhoneSince } =
    await import('../../src/repos/withdrawals.js');
  sumWithdrawalsForPhoneSince.mockResolvedValue({ total: 0, error: null });
  const { getActiveRate } = await import('../../src/repos/exchange-rates.js');
  getActiveRate.mockResolvedValue({ data: { rate: '25', created_at: new Date().toISOString() }, error: null });
  findPendingByWalletAndAmount.mockResolvedValue({ data: { id: 'SECRET-UUID' }, error: null });

  const { initiateWithdrawal } = await import('../../src/routes/withdrawals/withdrawals.js');

  // NOTE: adapted from the brief's literal
  // `.rejects.toThrow(expect.not.stringContaining('SECRET-UUID'))` — Jest's
  // toThrow() does not support asymmetric matchers as the expected value, so
  // that assertion silently passes regardless of the thrown message. Catch
  // the error directly and assert on its message instead.
  expect.assertions(2);
  try {
    await initiateWithdrawal({
      amountUsdc: 1_000_000, phoneNumber: '+23276123456',
      providerCode: 'm17', fromWalletAddress: 'W'.repeat(44), application: 'app-1'
    });
  } catch (error) {
    expect(error.message).not.toContain('SECRET-UUID');
    expect(error.message).toMatch(/open withdrawal already exists/i);
  }
});
