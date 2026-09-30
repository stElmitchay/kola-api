import { jest } from '@jest/globals';

const getActiveRate = jest.fn();
const setRate = jest.fn();
const getRateHistory = jest.fn();

jest.unstable_mockModule('../../src/repos/exchange-rates.js', () => ({
  getActiveRate,
  setRate,
  getRateHistory
}));

const { setExchangeRate } = await import('../../src/routes/admin/exchange-rates.js');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.RATE_MAX_MOVE_BPS = '500';   // 5%
});

test('a >5% move without force:true is rejected', async () => {
  getActiveRate.mockResolvedValue({ data: { rate: '25', created_at: new Date().toISOString() }, error: null });
  await expect(setExchangeRate('app-1', 30, 'ops@kola', { force: false }))
    .rejects.toThrow(/exceeds|force/i);
  expect(setRate).not.toHaveBeenCalled();
});

test('a >5% move with force:true is allowed', async () => {
  getActiveRate.mockResolvedValue({ data: { rate: '25', created_at: new Date().toISOString() }, error: null });
  setRate.mockResolvedValue({ data: { rate: '30' }, error: null });
  await expect(setExchangeRate('app-1', 30, 'ops@kola', { force: true }))
    .resolves.toEqual({ rate: '30' });
  expect(setRate).toHaveBeenCalledWith('app-1', 30, 'ops@kola');
});
