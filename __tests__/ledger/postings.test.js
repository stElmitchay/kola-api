import { jest } from '@jest/globals';
import BigNumber from 'bignumber.js';

const rpc = jest.fn();
const loggerError = jest.fn();

jest.unstable_mockModule('../../src/utils/supabase.js', () => ({
  createSupabaseClient: () => ({ rpc })
}));

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  logger: { error: loggerError, warn: jest.fn(), info: jest.fn(), child: () => ({ error: loggerError, warn: jest.fn(), info: jest.fn() }) }
}));

const {
  postDepositCollection, postDepositPayout, postWithdrawalReceipt, postWithdrawalPayout
} = await import('../../src/repos/ledger.js');

beforeEach(() => {
  jest.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
});

// Hard-coded from migration 0015's seed — the account -> currency map the
// balance checks below are computed against.
const ACCOUNT_CURRENCY = {
  treasury_usdc: 'USDC',
  user_payable_usdc: 'USDC',
  monime_sle: 'SLE',
  user_payable_sle: 'SLE',
  fee_income_sle: 'SLE',
  fx_usdc: 'USDC',
  fx_sle: 'SLE',
  suspense_usdc: 'USDC'
};

/** Assert that the entries of a post_journal call balance per currency. */
function assertBalancedPerCurrency(entries) {
  const totals = {};
  for (const e of entries) {
    const currency = ACCOUNT_CURRENCY[e.account];
    expect(currency).toBeDefined();
    totals[currency] ??= { debit: 0n, credit: 0n };
    totals[currency][e.direction] += BigInt(e.amount);
  }
  for (const { debit, credit } of Object.values(totals)) {
    expect(debit).toBe(credit);
  }
}

test('deposit payout posts a balanced USDC journal exactly once', async () => {
  await postDepositPayout({ id: 'd1', amount_usdc: 5_000_000 });
  expect(rpc).toHaveBeenCalledWith('post_journal', {
    p_kind: 'deposit_payout', p_resource_type: 'deposit', p_resource_id: 'd1',
    p_idempotency_key: 'deposit_payout:d1',
    p_entries: [
      { account: 'user_payable_usdc', direction: 'debit', amount: '5000000' },
      { account: 'treasury_usdc', direction: 'credit', amount: '5000000' }
    ]
  });
  expect(rpc).toHaveBeenCalledTimes(1);
  assertBalancedPerCurrency(rpc.mock.calls[0][1].p_entries);
});

test('deposit collection posts the four-entry cross-currency journal, balanced per currency', async () => {
  await postDepositCollection({ id: 'd2', amount_sle: 10_000, amount_usdc: 4_000_000 });
  expect(rpc).toHaveBeenCalledWith('post_journal', {
    p_kind: 'deposit_collection', p_resource_type: 'deposit', p_resource_id: 'd2',
    p_idempotency_key: 'deposit_collection:d2',
    p_entries: [
      { account: 'monime_sle', direction: 'debit', amount: '10000' },
      { account: 'fx_sle', direction: 'credit', amount: '10000' },
      { account: 'fx_usdc', direction: 'debit', amount: '4000000' },
      { account: 'user_payable_usdc', direction: 'credit', amount: '4000000' }
    ]
  });
  assertBalancedPerCurrency(rpc.mock.calls[0][1].p_entries);
});

test('withdrawal receipt (gross present) posts the USDC pair plus the SLE fee-split trio, balanced per currency', async () => {
  await postWithdrawalReceipt({
    id: 'w1', amount_usdc: 5_000_000, amount_sle: 12_375, amount_sle_gross: 12_500
  });
  expect(rpc).toHaveBeenCalledWith('post_journal', {
    p_kind: 'withdrawal_receipt', p_resource_type: 'withdrawal', p_resource_id: 'w1',
    p_idempotency_key: 'withdrawal_receipt:w1',
    p_entries: [
      { account: 'treasury_usdc', direction: 'debit', amount: '5000000' },
      { account: 'fx_usdc', direction: 'credit', amount: '5000000' },
      { account: 'fx_sle', direction: 'debit', amount: '12500' },
      { account: 'user_payable_sle', direction: 'credit', amount: '12375' },
      { account: 'fee_income_sle', direction: 'credit', amount: '125' }
    ]
  });
  assertBalancedPerCurrency(rpc.mock.calls[0][1].p_entries);
});

test('withdrawal receipt (zero fee, gross == net) omits the fee_income_sle entry and the SLE side still balances', async () => {
  // IMPORTANT 1 (B4 review): ledger_entries has CHECK (amount > 0). A
  // zero-fee withdrawal (WITHDRAWAL_FEE_BPS=0, or gross/net rounding down
  // into the same bucket) must NOT push a zero-amount fee_income_sle entry
  // -- that would fail the CHECK and abort the entire post_journal call,
  // including the otherwise-fine USDC pair.
  await postWithdrawalReceipt({ id: 'w5', amount_usdc: 5_000_000, amount_sle: 12_500, amount_sle_gross: 12_500 });
  expect(rpc).toHaveBeenCalledWith('post_journal', {
    p_kind: 'withdrawal_receipt', p_resource_type: 'withdrawal', p_resource_id: 'w5',
    p_idempotency_key: 'withdrawal_receipt:w5',
    p_entries: [
      { account: 'treasury_usdc', direction: 'debit', amount: '5000000' },
      { account: 'fx_usdc', direction: 'credit', amount: '5000000' },
      { account: 'fx_sle', direction: 'debit', amount: '12500' },
      { account: 'user_payable_sle', direction: 'credit', amount: '12500' }
    ]
  });
  const entries = rpc.mock.calls[0][1].p_entries;
  expect(entries.some((e) => e.account === 'fee_income_sle')).toBe(false);
  assertBalancedPerCurrency(entries);
});

test('withdrawal receipt (gross absent, pre-0015 row) posts ONLY the balanced USDC pair and logs a backfill notice', async () => {
  await postWithdrawalReceipt({ id: 'w2', amount_usdc: 5_000_000, amount_sle: 12_375, amount_sle_gross: null });
  expect(rpc).toHaveBeenCalledWith('post_journal', {
    p_kind: 'withdrawal_receipt', p_resource_type: 'withdrawal', p_resource_id: 'w2',
    p_idempotency_key: 'withdrawal_receipt:w2',
    p_entries: [
      { account: 'treasury_usdc', direction: 'debit', amount: '5000000' },
      { account: 'fx_usdc', direction: 'credit', amount: '5000000' }
    ]
  });
  assertBalancedPerCurrency(rpc.mock.calls[0][1].p_entries);
  expect(loggerError).toHaveBeenCalledWith(
    { alert: true },
    expect.stringContaining('w2')
  );
});

test('withdrawal payout posts a balanced SLE journal exactly once', async () => {
  await postWithdrawalPayout({ id: 'w3', amount_sle: 12_375 });
  expect(rpc).toHaveBeenCalledWith('post_journal', {
    p_kind: 'withdrawal_payout', p_resource_type: 'withdrawal', p_resource_id: 'w3',
    p_idempotency_key: 'withdrawal_payout:w3',
    p_entries: [
      { account: 'user_payable_sle', direction: 'debit', amount: '12375' },
      { account: 'monime_sle', direction: 'credit', amount: '12375' }
    ]
  });
  assertBalancedPerCurrency(rpc.mock.calls[0][1].p_entries);
});

test('a posting failure (rpc rejects) does not throw out of the helper', async () => {
  rpc.mockRejectedValueOnce(new Error('connection reset'));
  await expect(postDepositPayout({ id: 'd3', amount_usdc: 1_000_000 })).resolves.toBeUndefined();
  expect(loggerError).toHaveBeenCalled();
});

test('a posting failure ({error} from rpc) does not throw out of the helper', async () => {
  rpc.mockResolvedValueOnce({ data: null, error: new Error('unbalanced journal') });
  await expect(postWithdrawalPayout({ id: 'w4', amount_sle: 100 })).resolves.toBeUndefined();
  expect(loggerError).toHaveBeenCalled();
});

describe('calculateSleAmount', () => {
  test('5 USDC @ rate 25, fee 100bps -> gross 12500, net 12375', async () => {
    const { calculateSleAmount } = await import('../../src/routes/withdrawals/withdrawals.js');
    const result = calculateSleAmount(5_000_000, new BigNumber(25), 100);
    expect(result).toEqual({ gross: 12500, net: 12375 });
  });
});
