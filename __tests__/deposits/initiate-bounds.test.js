import { jest } from '@jest/globals';

const getActiveRate = jest.fn();
const getTreasuryUsdcBalanceMinor = jest.fn();

jest.unstable_mockModule('../../src/repos/exchange-rates.js', () => ({
  getActiveRate, assertRateFresh: jest.fn()
}));
jest.unstable_mockModule('../../src/utils/solana.js', () => ({
  deriveWalletFromPhone: jest.fn(),
  getTreasuryUsdcBalanceMinor
}));
jest.unstable_mockModule('../../src/utils/monime.js', () => ({
  createCheckoutSession: jest.fn(), createPaymentCode: jest.fn()
}));
jest.unstable_mockModule('../../src/repos/deposits.js', () => ({
  createDeposit: jest.fn(), getDeposit: jest.fn(), listDeposits: jest.fn(),
  updateDeposit: jest.fn(), updateDepositIfStatus: jest.fn(), getDepositById: jest.fn()
}));
jest.unstable_mockModule('../../src/repos/wallets.js', () => ({
  getWalletByPhone: jest.fn(), createWallet: jest.fn()
}));

const { initiateDeposit } = await import('../../src/routes/deposits/deposits.js');

const base = {
  currency: 'SLE', paymentMethod: 'ussd',
  phoneNumber: '+23276123456', walletAddress: 'So11111111111111111111111111111111111111112',
  application: 'app-1'
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DEPOSIT_MAX_SLE = '500000';        // 5,000.00 SLE
  getActiveRate.mockResolvedValue({ data: { rate: '25', created_at: new Date().toISOString() }, error: null });
});

test('rejects a deposit above DEPOSIT_MAX_SLE', async () => {
  await expect(initiateDeposit({ ...base, amount: 600_000 }))
    .rejects.toThrow(/maximum/i);
});

test('rejects when treasury cannot cover the USDC leg', async () => {
  getTreasuryUsdcBalanceMinor.mockResolvedValue(1_000_000n); // 1 USDC available
  // 100,000 SLE minor = 1,000 SLE / rate 25 = 40 USDC needed
  await expect(initiateDeposit({ ...base, amount: 100_000 }))
    .rejects.toThrow(/temporarily unavailable/i);
});
