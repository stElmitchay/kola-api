import { jest } from '@jest/globals';
import { createHmac } from 'crypto';

process.env.MONIME_WEBHOOK_SECRET = 'test-secret';

const recordWebhookEvent = jest.fn();
const getDepositById = jest.fn();
const updateDepositIfStatus = jest.fn();
const transferUsdc = jest.fn();

jest.unstable_mockModule('../../src/repos/webhook-events.js', () => ({ recordWebhookEvent }));
jest.unstable_mockModule('../../src/repos/deposits.js', () => ({
  getDepositById, updateDepositIfStatus,
  updateDeposit: jest.fn(), createDeposit: jest.fn(),
  getDeposit: jest.fn(), listDeposits: jest.fn()
}));
jest.unstable_mockModule('../../src/repos/withdrawals.js', () => ({
  getWithdrawalById: jest.fn(), getWithdrawalByMonimePayoutId: jest.fn(),
  updateWithdrawal: jest.fn()
}));
jest.unstable_mockModule('../../src/utils/solana.js', () => ({
  transferUsdc, getTreasuryAddress: () => 'TREASURY'
}));

const { default: app } = await import('../../src/routes/webhooks/monime.js');

/** Build a valid Monime-Signature header matching verifyWebhookSignature's format. */
function sign(body) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', process.env.MONIME_WEBHOOK_SECRET)
    .update(`${t}_${body}`, 'utf8')
    .digest('base64');
  return `t=${t},v1=${v1}`;
}

function post(bodyObj) {
  const body = JSON.stringify(bodyObj);
  return app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Monime-Signature': sign(body) },
    body
  });
}

const deposit = {
  id: 'd-1', status: 'pending', amount_sle: 10_000, amount_usdc: 4_000_000, wallet_address: 'W'
};

beforeEach(() => jest.clearAllMocks());

test('a duplicate event_id is acked 200 and processes nothing', async () => {
  recordWebhookEvent.mockResolvedValue({ isNew: false });

  const res = await post({
    event: { id: 'evt-1', name: 'payment_code.completed' },
    data: { reference: 'd-1', amount: { value: 10_000 } }
  });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ received: true, duplicate: true });
  expect(getDepositById).not.toHaveBeenCalled();
});

test('Review Focus #1: collected amount != quoted amount parks the deposit, never transfers', async () => {
  recordWebhookEvent.mockResolvedValue({ isNew: true });
  getDepositById.mockResolvedValue({ data: { ...deposit }, error: null });

  const res = await post({
    event: { id: 'evt-2', name: 'payment_code.completed' },
    data: { reference: 'd-1', amount: { value: 9_999 } }
  });

  expect(res.status).toBe(200);
  expect(updateDepositIfStatus).toHaveBeenCalledWith('d-1', 'pending', {
    status: 'amount_mismatch',
    failure_reason: 'collected=9999 quoted=10000'
  });
  expect(transferUsdc).not.toHaveBeenCalled();
});

// TEST-CODE-BINDING note: the brief's third scenario constructs "processed"
// then "completed" as two deliveries of the *same* payment. To prove the
// event gate alone can't be relied on for dedup (it only catches identical
// event ids) and that the CAS layer is what actually prevents the double
// transfer, the two deliveries below use DIFFERENT event ids (so both pass
// the recordWebhookEvent gate) and DIFFERENT event names (processed, then
// completed) for the same deposit reference. Exactly one transfer must
// result.
test('processed-after-completed does not double-fire (different event ids)', async () => {
  recordWebhookEvent.mockResolvedValue({ isNew: true }); // both deliveries pass the event gate
  getDepositById.mockResolvedValue({ data: { ...deposit }, error: null });

  // First delivery ('processed'): CAS claim wins, transfer happens once.
  updateDepositIfStatus
    .mockResolvedValueOnce({ data: { ...deposit, status: 'processing' }, error: null }) // claim
    .mockResolvedValueOnce({ data: { ...deposit, status: 'completed' }, error: null }); // finish
  transferUsdc.mockResolvedValueOnce('SIG1');

  const res1 = await post({
    event: { id: 'evt-processed', name: 'payment_code.processed' },
    data: { reference: 'd-1', amount: { value: 10_000 } }
  });
  expect(res1.status).toBe(200);
  expect(transferUsdc).toHaveBeenCalledTimes(1);

  // Second delivery ('completed', different event id): passes the event
  // gate (different event id), but loses the CAS claim (deposit is no
  // longer 'pending' in the real DB) — no second transfer.
  updateDepositIfStatus.mockResolvedValueOnce({ data: null, error: null }); // lost claim

  const res2 = await post({
    event: { id: 'evt-completed', name: 'payment_code.completed' },
    data: { reference: 'd-1', amount: { value: 10_000 } }
  });
  expect(res2.status).toBe(200);
  expect(transferUsdc).toHaveBeenCalledTimes(1); // still exactly once
});
