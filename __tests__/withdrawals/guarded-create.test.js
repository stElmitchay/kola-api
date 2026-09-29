import { jest } from '@jest/globals';

const createWithdrawalRepo = jest.fn();
const findPendingByWalletAndAmount = jest.fn();
const getActiveRate = jest.fn();
const assertRateFresh = jest.fn();

jest.unstable_mockModule('../../src/repos/withdrawals.js', () => ({
  createWithdrawal: createWithdrawalRepo,
  getWithdrawal: jest.fn(),
  listWithdrawals: jest.fn(),
  updateWithdrawal: jest.fn(),
  updateWithdrawalIfStatus: jest.fn(),
  findPendingByWalletAndAmount
}));
jest.unstable_mockModule('../../src/utils/monime.js', () => ({ createPayout: jest.fn() }));
jest.unstable_mockModule('../../src/utils/solana.js', () => ({
  getTreasuryAddress: () => 'TREASURY', verifyIncomingUsdcTransfer: jest.fn()
}));
jest.unstable_mockModule('../../src/repos/exchange-rates.js', () => ({
  getActiveRate, assertRateFresh
}));
jest.unstable_mockModule('../../src/repos/ledger.js', () => ({ postWithdrawalReceipt: jest.fn() }));

const { initiateWithdrawal } = await import('../../src/routes/withdrawals/withdrawals.js');

const VALID_PARAMS = {
  amountUsdc: 1_000_000,
  phoneNumber: '+23276123456',
  providerCode: 'm17',
  fromWalletAddress: 'W'.repeat(44),
  application: 'app-1'
};

beforeEach(() => {
  jest.clearAllMocks();
  getActiveRate.mockResolvedValue({
    data: { rate: '25', created_at: new Date().toISOString() },
    error: null
  });
});

test('B5: DAILY_CAP_EXCEEDED from the RPC raises a ValidationError with the used-amount message', async () => {
  createWithdrawalRepo.mockResolvedValue({
    data: null,
    error: { message: 'DAILY_CAP_EXCEEDED used=450000000' }
  });

  await expect(initiateWithdrawal(VALID_PARAMS)).rejects.toMatchObject({
    name: 'ValidationError',
    message: expect.stringMatching(/daily withdrawal cap of 500\.00 usdc would be exceeded \(already used 450\.00 usdc in last 24h\)/i)
  });
});

test('B5: DUPLICATE_OPEN_WITHDRAWAL from the RPC raises A8\'s leak-free ValidationError message', async () => {
  createWithdrawalRepo.mockResolvedValue({
    data: null,
    error: { message: 'DUPLICATE_OPEN_WITHDRAWAL' }
  });

  await expect(initiateWithdrawal(VALID_PARAMS)).rejects.toMatchObject({
    name: 'ValidationError',
    message: expect.stringMatching(/open withdrawal already exists/i)
  });
});

test('B5: any other RPC error maps to a DatabaseError as before', async () => {
  createWithdrawalRepo.mockResolvedValue({
    data: null,
    error: { message: 'connection reset' }
  });

  await expect(initiateWithdrawal(VALID_PARAMS)).rejects.toMatchObject({
    name: 'DatabaseError'
  });
});

test('B5: initiateWithdrawal no longer calls the JS pre-check functions', async () => {
  createWithdrawalRepo.mockResolvedValue({
    data: {
      id: 'w-1', status: 'pending_deposit', amount_usdc: 1_000_000, amount_sle: 24750,
      fee_bps: 100, exchange_rate: '25', phone_number: '+23276123456', provider_code: 'm17',
      from_wallet_address: 'W'.repeat(44), expires_at: new Date().toISOString()
    },
    error: null
  });

  await initiateWithdrawal(VALID_PARAMS);

  expect(findPendingByWalletAndAmount).not.toHaveBeenCalled();
});

test('B5: happy path passes the full insert object plus the daily cap to the repo', async () => {
  const row = {
    id: 'w-2', status: 'pending_deposit', amount_usdc: 1_000_000, amount_sle: 24750,
    fee_bps: 100, exchange_rate: '25', phone_number: '+23276123456', provider_code: 'm17',
    from_wallet_address: 'W'.repeat(44), expires_at: new Date().toISOString()
  };
  createWithdrawalRepo.mockResolvedValue({ data: row, error: null });

  const result = await initiateWithdrawal(VALID_PARAMS);

  expect(createWithdrawalRepo).toHaveBeenCalledWith(
    expect.objectContaining({
      application: 'app-1',
      phone_number: '+23276123456',
      from_wallet_address: VALID_PARAMS.fromWalletAddress,
      provider_code: 'm17',
      amount_usdc: 1_000_000,
      amount_sle: expect.any(Number),
      amount_sle_gross: expect.any(Number),
      fee_bps: 100,
      exchange_rate: '25',
      expires_at: expect.any(String),
      metadata: {}
    }),
    500_000_000
  );
  expect(result.id).toBe('w-2');
});
