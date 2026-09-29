import { jest } from '@jest/globals';

// TEST-CODE-BINDING note: the brief's sample test scaffolding references a
// `claimJob` mock, but the shipped worker never imports or calls a
// `claimJob` function — the claim is `recordSignature`'s CAS (status IN
// ('queued','sending')). There is nothing to mock for it. The three
// recovery-rule assertions themselves (landed→complete without re-sign;
// expired+not-landed→re-sign once; still-valid+pending→leave alone) are
// unchanged and binding.

const listOpenJobs = jest.fn();
const recordSignature = jest.fn();
const markSent = jest.fn();
const markFailedPermanent = jest.fn();
const bumpAttempt = jest.fn();

const buildSignedUsdcTransfer = jest.fn();
const checkSignatureLanded = jest.fn();
const sendSerializedTransaction = jest.fn();
const getCurrentBlockHeight = jest.fn();

const updateDepositIfStatus = jest.fn();

jest.unstable_mockModule('../../src/repos/transfer-jobs.js', () => ({
  listOpenJobs, recordSignature, markSent, markFailedPermanent, bumpAttempt
}));
jest.unstable_mockModule('../../src/utils/solana.js', () => ({
  buildSignedUsdcTransfer, checkSignatureLanded, sendSerializedTransaction, getCurrentBlockHeight
}));
jest.unstable_mockModule('../../src/repos/deposits.js', () => ({
  updateDepositIfStatus,
  getDepositById: jest.fn(), createDeposit: jest.fn(),
  getDeposit: jest.fn(), listDeposits: jest.fn(), updateDeposit: jest.fn()
}));

const { processJob, sweepOpenJobs, default: app } = await import('../../src/routes/internal/transfer-tick.js');

beforeEach(() => {
  jest.clearAllMocks();
  updateDepositIfStatus.mockResolvedValue({ data: {}, error: null });
});

/** A job already in 'sending' with a persisted signature. */
function sendingJob(overrides = {}) {
  return {
    id: 'j1', status: 'sending', signature: 'SIG', deposit_id: 'd1',
    destination: 'WALLET', amount_usdc: 5_000_000, last_valid_block_height: 100,
    attempts: 0, ...overrides
  };
}

/** A never-sent job. */
function queuedJob(overrides = {}) {
  return {
    id: 'j2', status: 'queued', signature: null, deposit_id: 'd2',
    destination: 'WALLET2', amount_usdc: 2_000_000, last_valid_block_height: null,
    attempts: 0, ...overrides
  };
}

describe('recovery rule — the point of the pipeline (F9)', () => {
  test('Review Focus #4: a job stuck in sending whose signature landed is completed WITHOUT re-sending', async () => {
    const job = sendingJob();
    checkSignatureLanded.mockResolvedValueOnce('finalized');
    markSent.mockResolvedValueOnce({ data: { id: 'j1' }, error: null });

    await processJob(job);

    expect(buildSignedUsdcTransfer).not.toHaveBeenCalled();   // never re-sign a landed tx
    expect(markSent).toHaveBeenCalledWith('j1', 'SIG');
    expect(updateDepositIfStatus).toHaveBeenCalledWith('d1', 'processing', {
      status: 'completed', solana_tx_signature: 'SIG'
    });
  });

  test('a sending job whose blockhash expired and signature never landed is re-signed exactly once', async () => {
    const job = sendingJob();
    checkSignatureLanded.mockResolvedValueOnce('not_found');
    getCurrentBlockHeight.mockResolvedValueOnce(200);         // > last_valid_block_height 100
    buildSignedUsdcTransfer.mockResolvedValueOnce({
      signature: 'SIG2', serialized: Buffer.from(''), blockhash: 'B2', lastValidBlockHeight: 300
    });
    recordSignature.mockResolvedValueOnce({ data: { id: 'j1' }, error: null });
    sendSerializedTransaction.mockResolvedValueOnce(undefined);
    markSent.mockResolvedValueOnce({ data: { id: 'j1' }, error: null });

    await processJob(job);

    expect(buildSignedUsdcTransfer).toHaveBeenCalledTimes(1);
    expect(recordSignature).toHaveBeenCalledWith('j1', {
      signature: 'SIG2', serialized: expect.any(Buffer), blockhash: 'B2', lastValidBlockHeight: 300
    });
    expect(markSent).toHaveBeenCalledWith('j1', 'SIG2');
  });

  test('a sending job whose blockhash is still valid and signature pending (not_found) is left alone', async () => {
    const job = sendingJob();
    checkSignatureLanded.mockResolvedValueOnce('not_found');
    getCurrentBlockHeight.mockResolvedValueOnce(50);           // <= 100: tx may still land

    await processJob(job);

    expect(buildSignedUsdcTransfer).not.toHaveBeenCalled();
    expect(markFailedPermanent).not.toHaveBeenCalled();
    expect(bumpAttempt).not.toHaveBeenCalled();
  });

  test('a sending job whose signature is still pending confirmation is left alone without checking block height', async () => {
    const job = sendingJob();
    checkSignatureLanded.mockResolvedValueOnce('pending');

    await processJob(job);

    expect(getCurrentBlockHeight).not.toHaveBeenCalled();
    expect(buildSignedUsdcTransfer).not.toHaveBeenCalled();
  });
});

describe('attempts exhausted', () => {
  test('marks the job permanently failed and CASes the deposit to failed, requiring operator action', async () => {
    const job = queuedJob({ attempts: 5 });
    markFailedPermanent.mockResolvedValueOnce({ data: { id: 'j2' }, error: null });

    await processJob(job);

    expect(markFailedPermanent).toHaveBeenCalledWith('j2', 'max attempts exceeded');
    expect(updateDepositIfStatus).toHaveBeenCalledWith('d2', 'processing', {
      status: 'failed', failure_reason: 'transfer failed permanently — operator action required'
    });
    expect(buildSignedUsdcTransfer).not.toHaveBeenCalled();
  });
});

describe('fresh queued job — happy path', () => {
  test('signs, records the signature BEFORE broadcast, sends, then marks sent and completes the deposit', async () => {
    const job = queuedJob();
    buildSignedUsdcTransfer.mockResolvedValueOnce({
      signature: 'SIG3', serialized: Buffer.from('x'), blockhash: 'B3', lastValidBlockHeight: 400
    });
    recordSignature.mockResolvedValueOnce({ data: { id: 'j2' }, error: null });
    sendSerializedTransaction.mockResolvedValueOnce(undefined);
    markSent.mockResolvedValueOnce({ data: { id: 'j2' }, error: null });

    await processJob(job);

    // The ordering below IS the fix for F9: the signature must be durably
    // recorded before the transaction is ever broadcast.
    const recordOrder = recordSignature.mock.invocationCallOrder[0];
    const sendOrder = sendSerializedTransaction.mock.invocationCallOrder[0];
    expect(recordOrder).toBeLessThan(sendOrder);

    expect(updateDepositIfStatus).toHaveBeenCalledWith('d2', 'confirmed', { status: 'processing' });
    expect(sendSerializedTransaction).toHaveBeenCalledWith(
      expect.any(Buffer), 'SIG3', 'B3', 400
    );
    expect(markSent).toHaveBeenCalledWith('j2', 'SIG3');
    expect(updateDepositIfStatus).toHaveBeenCalledWith('d2', 'processing', {
      status: 'completed', solana_tx_signature: 'SIG3'
    });
  });

  test('a lost recordSignature claim (another tick already claimed it) does not send or mark sent', async () => {
    const job = queuedJob();
    buildSignedUsdcTransfer.mockResolvedValueOnce({
      signature: 'SIG4', serialized: Buffer.from('x'), blockhash: 'B4', lastValidBlockHeight: 400
    });
    recordSignature.mockResolvedValueOnce({ data: null, error: null }); // lost the claim

    await processJob(job);

    expect(sendSerializedTransaction).not.toHaveBeenCalled();
    expect(markSent).not.toHaveBeenCalled();
  });

  test('a build/send failure bumps the attempt and leaves the job for the next tick to reconcile', async () => {
    const job = queuedJob();
    buildSignedUsdcTransfer.mockRejectedValueOnce(new Error('rpc timeout'));
    bumpAttempt.mockResolvedValueOnce({ data: { id: 'j2' }, error: null });

    await processJob(job);

    expect(bumpAttempt).toHaveBeenCalledWith('j2', 'rpc timeout');
    expect(markSent).not.toHaveBeenCalled();
    expect(markFailedPermanent).not.toHaveBeenCalled();
  });
});

describe('sweepOpenJobs', () => {
  test('processes every open job returned by listOpenJobs and reports the count', async () => {
    const landed = sendingJob({ id: 'j1', deposit_id: 'd1' });
    const fresh = queuedJob({ id: 'j2', deposit_id: 'd2' });
    listOpenJobs.mockResolvedValueOnce({ data: [landed, fresh], error: null });

    checkSignatureLanded.mockResolvedValueOnce('finalized');
    markSent.mockResolvedValueOnce({ data: { id: 'j1' }, error: null });

    buildSignedUsdcTransfer.mockResolvedValueOnce({
      signature: 'SIG5', serialized: Buffer.from('x'), blockhash: 'B5', lastValidBlockHeight: 500
    });
    recordSignature.mockResolvedValueOnce({ data: { id: 'j2' }, error: null });
    sendSerializedTransaction.mockResolvedValueOnce(undefined);
    markSent.mockResolvedValueOnce({ data: { id: 'j2' }, error: null });

    const processed = await sweepOpenJobs(20);

    expect(listOpenJobs).toHaveBeenCalledWith(20);
    expect(processed).toBe(2);
    expect(markSent).toHaveBeenNthCalledWith(1, 'j1', 'SIG');
    expect(markSent).toHaveBeenNthCalledWith(2, 'j2', 'SIG5');
  });
});

describe('cron auth on POST /', () => {
  const OLD_SECRET = process.env.CRON_SECRET;
  beforeEach(() => { process.env.CRON_SECRET = 'test-cron-secret'; });
  afterAll(() => { process.env.CRON_SECRET = OLD_SECRET; });

  test('accepts Authorization: Bearer $CRON_SECRET (the form Vercel cron sends)', async () => {
    listOpenJobs.mockResolvedValueOnce({ data: [], error: null });
    const res = await app.request('/', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-cron-secret' }
    });
    expect(res.status).toBe(200);
  });

  test('accepts X-Cron-Secret for manual/operator triggers', async () => {
    listOpenJobs.mockResolvedValueOnce({ data: [], error: null });
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'X-Cron-Secret': 'test-cron-secret' }
    });
    expect(res.status).toBe(200);
  });

  test('rejects a wrong or missing secret', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'X-Cron-Secret': 'wrong' }
    });
    expect(res.status).toBe(401);
    expect(listOpenJobs).not.toHaveBeenCalled();

    const res2 = await app.request('/', { method: 'POST' });
    expect(res2.status).toBe(401);
  });
});
