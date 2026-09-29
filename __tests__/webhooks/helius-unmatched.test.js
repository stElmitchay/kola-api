import { jest } from '@jest/globals';

process.env.USDC_MINT = 'USDC_MINT_ADDRESS';

const getTreasuryAddress = jest.fn(() => 'TREASURY');
const findPendingByWalletAndAmount = jest.fn();
const updateWithdrawalIfStatus = jest.fn();
const triggerPayoutForWithdrawal = jest.fn();
const postWithdrawalReceipt = jest.fn();
const postJournal = jest.fn();
const recordUnmatched = jest.fn();

jest.unstable_mockModule('../../src/utils/solana.js', () => ({
  getTreasuryAddress
}));
jest.unstable_mockModule('../../src/repos/withdrawals.js', () => ({
  findPendingByWalletAndAmount, updateWithdrawalIfStatus
}));
jest.unstable_mockModule('../../src/routes/withdrawals/withdrawals.js', () => ({
  triggerPayoutForWithdrawal
}));
jest.unstable_mockModule('../../src/repos/ledger.js', () => ({
  postWithdrawalReceipt, postJournal
}));
jest.unstable_mockModule('../../src/repos/unmatched-transfers.js', () => ({
  recordUnmatched
}));

const { handleHeliusEvent } = await import('../../src/routes/webhooks/helius-handler.js');

function transferEvent({ signature = 'SIG-X', fromUserAccount = 'SENDER', ...transferOverrides }) {
  return [{
    signature,
    tokenTransfers: [{
      mint: process.env.USDC_MINT,
      toUserAccount: 'TREASURY',
      fromUserAccount,
      ...transferOverrides
    }]
  }];
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('inbound USDC with no open withdrawal is booked to suspense, not dropped', async () => {
  findPendingByWalletAndAmount.mockResolvedValue({ data: null, error: null });
  recordUnmatched.mockResolvedValue({ data: { id: 'ut-1' }, error: null });

  await handleHeliusEvent(transferEvent({
    signature: 'SIG-X',
    fromUserAccount: 'SENDER',
    rawTokenAmount: { tokenAmount: '5000000', decimals: 6 }
  }));

  expect(recordUnmatched).toHaveBeenCalledWith(expect.objectContaining({
    signature: 'SIG-X', from_wallet: 'SENDER', amount_usdc: 5_000_000, reason: 'no_open_match'
  }));
  expect(postJournal).toHaveBeenCalledWith('suspense_in', {
    resourceType: 'unmatched_transfer', resourceId: 'ut-1',
    idempotencyKey: 'suspense_in:SIG-X',
    entries: [
      { account: 'treasury_usdc', direction: 'debit', amount: 5_000_000 },
      { account: 'suspense_usdc', direction: 'credit', amount: 5_000_000 }
    ]
  });
});

test('a lookup error is booked to suspense with reason lookup_error', async () => {
  findPendingByWalletAndAmount.mockResolvedValue({ data: null, error: new Error('db down') });
  recordUnmatched.mockResolvedValue({ data: { id: 'ut-2' }, error: null });

  await handleHeliusEvent(transferEvent({
    signature: 'SIG-LOOKUP-ERR',
    fromUserAccount: 'SENDER',
    rawTokenAmount: { tokenAmount: '1000000', decimals: 6 }
  }));

  expect(recordUnmatched).toHaveBeenCalledWith(expect.objectContaining({
    signature: 'SIG-LOOKUP-ERR', from_wallet: 'SENDER', amount_usdc: 1_000_000, reason: 'lookup_error'
  }));
  expect(postJournal).toHaveBeenCalledWith('suspense_in', expect.objectContaining({
    resourceId: 'ut-2',
    idempotencyKey: 'suspense_in:SIG-LOOKUP-ERR'
  }));
});

test('replay of an already-booked signature is a no-op: no postJournal, no double alert', async () => {
  findPendingByWalletAndAmount.mockResolvedValue({ data: null, error: null });
  // Unique(signature) upsert already found a row -> data: null, no error.
  recordUnmatched.mockResolvedValue({ data: null, error: null });
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  await handleHeliusEvent(transferEvent({
    signature: 'SIG-REPLAY',
    fromUserAccount: 'SENDER',
    rawTokenAmount: { tokenAmount: '2000000', decimals: 6 }
  }));

  expect(recordUnmatched).toHaveBeenCalledWith(expect.objectContaining({ signature: 'SIG-REPLAY' }));
  expect(postJournal).not.toHaveBeenCalled();
  expect(errorSpy.mock.calls.some(call => String(call[0]).includes('UNMATCHED transfer booked to suspense'))).toBe(false);

  errorSpy.mockRestore();
});

test('a recordUnmatched error is logged and does not throw or post a journal', async () => {
  findPendingByWalletAndAmount.mockResolvedValue({ data: null, error: null });
  recordUnmatched.mockResolvedValue({ data: null, error: new Error('insert failed') });

  await expect(handleHeliusEvent(transferEvent({
    signature: 'SIG-RECORD-ERR',
    fromUserAccount: 'SENDER',
    rawTokenAmount: { tokenAmount: '3000000', decimals: 6 }
  }))).resolves.toEqual({ ok: true });

  expect(postJournal).not.toHaveBeenCalled();
});

test('rawTokenAmount.tokenAmount (integer string) is preferred over tokenAmount when both present', async () => {
  findPendingByWalletAndAmount.mockResolvedValue({ data: null, error: null });
  recordUnmatched.mockResolvedValue({ data: { id: 'ut-3' }, error: null });

  await handleHeliusEvent(transferEvent({
    signature: 'SIG-RAW-PREFERRED',
    fromUserAccount: 'SENDER',
    tokenAmount: 5.0,
    rawTokenAmount: { tokenAmount: '5000000', decimals: 6 }
  }));

  expect(recordUnmatched).toHaveBeenCalledWith(expect.objectContaining({ amount_usdc: 5_000_000 }));
});

test('falls back to exact BigNumber string math on tokenAmount when rawTokenAmount is absent', async () => {
  findPendingByWalletAndAmount.mockResolvedValue({ data: null, error: null });
  recordUnmatched.mockResolvedValue({ data: { id: 'ut-4' }, error: null });

  await handleHeliusEvent(transferEvent({
    signature: 'SIG-FALLBACK-EXACT',
    fromUserAccount: 'SENDER',
    tokenAmount: 5.000001
  }));

  expect(recordUnmatched).toHaveBeenCalledWith(expect.objectContaining({ amount_usdc: 5_000_001 }));
});

test('matched path is unchanged: CAS claim -> receipt post -> payout trigger', async () => {
  const withdrawal = { id: 'w-1', status: 'pending_deposit' };
  const claimed = { ...withdrawal, status: 'received', solana_tx_signature: 'SIG-MATCH' };
  findPendingByWalletAndAmount.mockResolvedValue({ data: withdrawal, error: null });
  updateWithdrawalIfStatus.mockResolvedValue({ data: claimed, error: null });
  triggerPayoutForWithdrawal.mockResolvedValue(undefined);

  await handleHeliusEvent(transferEvent({
    signature: 'SIG-MATCH',
    fromUserAccount: 'SENDER',
    rawTokenAmount: { tokenAmount: '5000000', decimals: 6 }
  }));

  expect(findPendingByWalletAndAmount).toHaveBeenCalledWith('SENDER', 5_000_000);
  expect(updateWithdrawalIfStatus).toHaveBeenCalledWith('w-1', 'pending_deposit', {
    status: 'received', solana_tx_signature: 'SIG-MATCH'
  });
  expect(postWithdrawalReceipt).toHaveBeenCalledWith(claimed);
  expect(triggerPayoutForWithdrawal).toHaveBeenCalledWith(claimed);
  expect(recordUnmatched).not.toHaveBeenCalled();
  expect(postJournal).not.toHaveBeenCalled();
});
