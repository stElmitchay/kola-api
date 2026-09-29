import { jest } from '@jest/globals';

// TEST-CODE-BINDING note: the brief's sample test scaffolding references a
// `claimJob` mock, but the shipped worker never imports or calls a
// `claimJob` function — the claim is `recordSignature`'s fence on the
// caller's OBSERVED prior state (status + signature), not a separate claim
// step. There is nothing to mock for it. The three original recovery-rule
// assertions (landed→complete without re-sign; expired+not-landed→re-sign
// once; still-valid+pending→leave alone) are unchanged and binding; a
// fourth (pre-broadcast recheck on the rebuild path) and the concurrency
// fence were added per the B3 review ruling.

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
  bumpAttempt.mockResolvedValue({ data: {}, error: null });
});

/** A job already in 'sending' with a persisted signature. last_valid_block_height 100. */
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
    expect(recordSignature).not.toHaveBeenCalled();
    expect(markSent).toHaveBeenCalledWith('j1', 'SIG');
    expect(updateDepositIfStatus).toHaveBeenCalledWith('d1', 'processing', {
      status: 'completed', solana_tx_signature: 'SIG'
    });
  });

  test('a sending job whose blockhash expired (beyond the margin) and signature never landed is re-signed exactly once', async () => {
    const job = sendingJob();
    // decision check, then the pre-broadcast recheck immediately before send
    checkSignatureLanded.mockResolvedValueOnce('not_found').mockResolvedValueOnce('not_found');
    getCurrentBlockHeight.mockResolvedValueOnce(200);         // > 100 + 32-slot margin
    buildSignedUsdcTransfer.mockResolvedValueOnce({
      signature: 'SIG2', serialized: Buffer.from(''), blockhash: 'B2', lastValidBlockHeight: 300
    });
    recordSignature.mockResolvedValueOnce({ data: { id: 'j1' }, error: null });
    sendSerializedTransaction.mockResolvedValueOnce(undefined);
    markSent.mockResolvedValueOnce({ data: { id: 'j1' }, error: null });

    await processJob(job);

    expect(buildSignedUsdcTransfer).toHaveBeenCalledTimes(1);
    expect(recordSignature).toHaveBeenCalledWith(
      'j1',
      { signature: 'SIG2', serialized: expect.any(Buffer), blockhash: 'B2', lastValidBlockHeight: 300 },
      { status: 'sending', signature: 'SIG' }                 // fenced on what this tick observed
    );
    expect(sendSerializedTransaction).toHaveBeenCalledTimes(1);
    expect(markSent).toHaveBeenCalledWith('j1', 'SIG2');
  });

  test('a sending job whose blockhash is within the 32-slot expiry margin and signature pending (not_found) is left alone', async () => {
    const job = sendingJob();                                 // last_valid_block_height 100
    checkSignatureLanded.mockResolvedValueOnce('not_found');
    getCurrentBlockHeight.mockResolvedValueOnce(130);          // <= 100 + 32: still within margin

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

  test('a pre-broadcast recheck that finds the OLD signature already landed finishes with it instead of broadcasting a new one', async () => {
    const job = sendingJob();
    checkSignatureLanded
      .mockResolvedValueOnce('not_found')     // initial recovery decision: not (yet) landed
      .mockResolvedValueOnce('finalized');    // recheck immediately before broadcast: landed in the gap
    getCurrentBlockHeight.mockResolvedValueOnce(200);
    buildSignedUsdcTransfer.mockResolvedValueOnce({
      signature: 'SIG2', serialized: Buffer.from(''), blockhash: 'B2', lastValidBlockHeight: 300
    });
    recordSignature.mockResolvedValueOnce({ data: { id: 'j1' }, error: null });
    markSent.mockResolvedValueOnce({ data: { id: 'j1' }, error: null });

    await processJob(job);

    expect(sendSerializedTransaction).not.toHaveBeenCalled();     // never broadcast the rebuilt tx
    expect(markSent).toHaveBeenCalledWith('j1', 'SIG');            // finished with the OLD signature
    expect(updateDepositIfStatus).toHaveBeenCalledWith('d1', 'processing', {
      status: 'completed', solana_tx_signature: 'SIG'
    });
  });
});

describe('concurrent ticks on the same job — exclusive claim fence', () => {
  test('two overlapping processJob calls on the same job result in exactly one send', async () => {
    const job = queuedJob({ id: 'j9', deposit_id: 'd9' });

    buildSignedUsdcTransfer
      .mockResolvedValueOnce({ signature: 'SIGA', serialized: Buffer.from('a'), blockhash: 'BA', lastValidBlockHeight: 900 })
      .mockResolvedValueOnce({ signature: 'SIGB', serialized: Buffer.from('b'), blockhash: 'BB', lastValidBlockHeight: 901 });

    // First writer's fence matches (observed state still current); the
    // second writer's WHERE no longer matches once the first has committed
    // (the signature column moved out from under it) — mocked via call count.
    recordSignature
      .mockResolvedValueOnce({ data: { id: 'j9' }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });

    sendSerializedTransaction.mockResolvedValue(undefined);
    markSent.mockResolvedValue({ data: { id: 'j9' }, error: null });

    await Promise.all([processJob(job), processJob(job)]);

    expect(buildSignedUsdcTransfer).toHaveBeenCalledTimes(2);   // both ticks built a (valid) tx
    expect(recordSignature).toHaveBeenCalledTimes(2);
    expect(sendSerializedTransaction).toHaveBeenCalledTimes(1); // but only one was ever broadcast
    expect(markSent).toHaveBeenCalledTimes(1);
  });
});

describe('attempts exhausted', () => {
  test('marks the job permanently failed and CASes the deposit to failed from processing, requiring operator action', async () => {
    const job = queuedJob({ attempts: 5 });
    markFailedPermanent.mockResolvedValueOnce({ data: { id: 'j2' }, error: null });
    updateDepositIfStatus.mockResolvedValueOnce({ data: { id: 'd2' }, error: null }); // processing->failed succeeds

    await processJob(job);

    expect(markFailedPermanent).toHaveBeenCalledWith('j2', 'max attempts exceeded');
    expect(updateDepositIfStatus).toHaveBeenCalledTimes(1);      // no confirmed->failed fallback needed
    expect(updateDepositIfStatus).toHaveBeenCalledWith('d2', 'processing', {
      status: 'failed', failure_reason: 'transfer failed permanently — operator action required'
    });
    expect(buildSignedUsdcTransfer).not.toHaveBeenCalled();
  });

  test('exhaustion fallback: a deposit still confirmed (processing->failed no-ops) falls back to confirmed->failed', async () => {
    const job = queuedJob({ id: 'j10', deposit_id: 'd10', attempts: 5 });
    markFailedPermanent.mockResolvedValueOnce({ data: { id: 'j10' }, error: null });
    updateDepositIfStatus
      .mockResolvedValueOnce({ data: null, error: null })            // processing->failed no-ops
      .mockResolvedValueOnce({ data: { id: 'd10' }, error: null });  // confirmed->failed succeeds

    await processJob(job);

    expect(updateDepositIfStatus).toHaveBeenNthCalledWith(1, 'd10', 'processing', {
      status: 'failed', failure_reason: 'transfer failed permanently — operator action required'
    });
    expect(updateDepositIfStatus).toHaveBeenNthCalledWith(2, 'd10', 'confirmed', {
      status: 'failed', failure_reason: 'transfer failed permanently — operator action required'
    });
  });

  test('both CAS fallbacks no-op without error — logs an alert instead of throwing', async () => {
    const job = queuedJob({ id: 'j11', deposit_id: 'd11', attempts: 5 });
    markFailedPermanent.mockResolvedValueOnce({ data: { id: 'j11' }, error: null });
    updateDepositIfStatus.mockResolvedValue({ data: null, error: null }); // both attempts no-op

    await expect(processJob(job)).resolves.toBeUndefined();
    expect(updateDepositIfStatus).toHaveBeenCalledTimes(2);
  });
});

describe('fresh queued job — happy path', () => {
  test('signs, records the signature BEFORE broadcast (fenced on observed state), sends, then marks sent and completes the deposit', async () => {
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

    expect(recordSignature).toHaveBeenCalledWith(
      'j2',
      { signature: 'SIG3', serialized: expect.any(Buffer), blockhash: 'B3', lastValidBlockHeight: 400 },
      { status: 'queued', signature: null }
    );
    expect(updateDepositIfStatus).toHaveBeenCalledWith('d2', 'confirmed', { status: 'processing' });
    expect(sendSerializedTransaction).toHaveBeenCalledWith(
      expect.any(Buffer), 'SIG3', 'B3', 400
    );
    expect(markSent).toHaveBeenCalledWith('j2', 'SIG3');
    expect(updateDepositIfStatus).toHaveBeenCalledWith('d2', 'processing', {
      status: 'completed', solana_tx_signature: 'SIG3'
    });
  });

  test('a lost recordSignature claim (fence no longer matches — another tick already claimed it) does not send or mark sent', async () => {
    const job = queuedJob();
    buildSignedUsdcTransfer.mockResolvedValueOnce({
      signature: 'SIG4', serialized: Buffer.from('x'), blockhash: 'B4', lastValidBlockHeight: 400
    });
    recordSignature.mockResolvedValueOnce({ data: null, error: null }); // fence didn't match — lost the claim

    await processJob(job);

    expect(sendSerializedTransaction).not.toHaveBeenCalled();
    expect(markSent).not.toHaveBeenCalled();
  });

  test('a build/send failure bumps the attempt (status untouched) and leaves the job for the next tick to reconcile', async () => {
    const job = queuedJob();
    buildSignedUsdcTransfer.mockRejectedValueOnce(new Error('rpc timeout'));

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

  test('a poisoned job that throws (e.g. checkSignatureLanded rejects) does not block the rest of the sweep', async () => {
    const poisoned = sendingJob({ id: 'jp', deposit_id: 'dp' });
    const fresh = queuedJob({ id: 'j2', deposit_id: 'd2' });
    listOpenJobs.mockResolvedValueOnce({ data: [poisoned, fresh], error: null });

    checkSignatureLanded.mockRejectedValueOnce(new Error('RPC unreachable'));
    bumpAttempt.mockResolvedValueOnce({ data: { id: 'jp' }, error: null });

    buildSignedUsdcTransfer.mockResolvedValueOnce({
      signature: 'SIG6', serialized: Buffer.from('x'), blockhash: 'B6', lastValidBlockHeight: 600
    });
    recordSignature.mockResolvedValueOnce({ data: { id: 'j2' }, error: null });
    sendSerializedTransaction.mockResolvedValueOnce(undefined);
    markSent.mockResolvedValueOnce({ data: { id: 'j2' }, error: null });

    const processed = await sweepOpenJobs(20);

    expect(processed).toBe(2);
    expect(bumpAttempt).toHaveBeenCalledWith('jp', 'RPC unreachable');  // isolated, pushed to back of queue
    expect(markSent).toHaveBeenCalledWith('j2', 'SIG6');                // second job still fully processed
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
