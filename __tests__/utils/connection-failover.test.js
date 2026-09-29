import { jest } from '@jest/globals';
import bs58 from 'bs58';

// Import the REAL @solana/web3.js first (before any mock registration) so
// the mock factory below can delegate to the real Connection class —
// solana.js (imported later, in the "call site" describe block) needs the
// real Keypair/PublicKey/etc. exports to keep working, so only `Connection`
// itself is replaced with a spy that still constructs a real connection.
const web3Actual = await import('@solana/web3.js');
const RealConnection = web3Actual.Connection;
const ConnectionMock = jest.fn().mockImplementation(
  (endpoint, commitment) => new RealConnection(endpoint, commitment)
);
jest.unstable_mockModule('@solana/web3.js', () => ({ ...web3Actual, Connection: ConnectionMock }));

const loggerError = jest.fn();
jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  logger: { error: loggerError, warn: jest.fn(), info: jest.fn() }
}));

const {
  getConnection,
  getFallbackConnection,
  withRpcFailover,
  __resetConnectionsForTests: resetConnectionsForTests
} = await import('../../src/utils/connection.js');

beforeEach(() => {
  jest.clearAllMocks();
  resetConnectionsForTests();
  process.env.HELIUS_URL = 'https://primary.test';
  delete process.env.SOLANA_RPC_FALLBACK_URL;
});

test('primary and fallback connections are both constructed at finalized commitment', () => {
  process.env.SOLANA_RPC_FALLBACK_URL = 'https://fallback.test';

  getConnection();
  getFallbackConnection();

  expect(ConnectionMock).toHaveBeenCalledWith('https://primary.test', 'finalized');
  expect(ConnectionMock).toHaveBeenCalledWith('https://fallback.test', 'finalized');
});

test('getFallbackConnection returns null when SOLANA_RPC_FALLBACK_URL is unset', () => {
  expect(getFallbackConnection()).toBeNull();
});

test('primary rejects, fallback configured -> resolves via fallback and logs an alert', async () => {
  process.env.SOLANA_RPC_FALLBACK_URL = 'https://fallback.test';
  const primaryErr = new Error('fetch failed');

  const fn = jest.fn()
    .mockRejectedValueOnce(primaryErr)
    .mockResolvedValueOnce('fallback-result');

  const result = await withRpcFailover(fn);

  expect(result).toBe('fallback-result');
  expect(fn).toHaveBeenCalledTimes(2);
  expect(fn).toHaveBeenNthCalledWith(1, getConnection());
  expect(fn).toHaveBeenNthCalledWith(2, getFallbackConnection());
  expect(loggerError).toHaveBeenCalledWith(
    { alert: true, err: primaryErr.message },
    '[RPC] primary failed, trying fallback'
  );
});

test('primary rejects, no fallback configured -> rethrows the original error', async () => {
  const primaryErr = new Error('fetch failed');
  const fn = jest.fn().mockRejectedValueOnce(primaryErr);

  await expect(withRpcFailover(fn)).rejects.toThrow('fetch failed');
  expect(fn).toHaveBeenCalledTimes(1);
  expect(loggerError).not.toHaveBeenCalled();
});

test('primary rejects, fallback also rejects -> the fallback error propagates', async () => {
  process.env.SOLANA_RPC_FALLBACK_URL = 'https://fallback.test';
  const primaryErr = new Error('fetch failed');
  const fallbackErr = new Error('fallback also down');

  const fn = jest.fn()
    .mockRejectedValueOnce(primaryErr)
    .mockRejectedValueOnce(fallbackErr);

  await expect(withRpcFailover(fn)).rejects.toThrow('fallback also down');
  expect(fn).toHaveBeenCalledTimes(2);
});

describe('call site: getTreasuryUsdcBalanceMinor / buildSignedUsdcTransfer go through withRpcFailover', () => {
  let getTreasuryUsdcBalanceMinor;
  let buildSignedUsdcTransfer;
  let mockWithRpcFailover;

  beforeAll(async () => {
    process.env.TREASURY_SECRET_KEY = bs58.encode(web3Actual.Keypair.generate().secretKey);
    process.env.USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    mockWithRpcFailover = jest.fn().mockResolvedValue(0n);
    jest.resetModules();
    jest.unstable_mockModule('../../src/utils/connection.js', () => ({
      getConnection: jest.fn(),
      getFallbackConnection: jest.fn(),
      withRpcFailover: mockWithRpcFailover
    }));

    ({ getTreasuryUsdcBalanceMinor, buildSignedUsdcTransfer } = await import('../../src/utils/solana.js'));
  });

  test('getTreasuryUsdcBalanceMinor calls withRpcFailover instead of talking to the connection directly', async () => {
    mockWithRpcFailover.mockResolvedValueOnce(42n);

    const result = await getTreasuryUsdcBalanceMinor();

    expect(mockWithRpcFailover).toHaveBeenCalledTimes(1);
    expect(mockWithRpcFailover).toHaveBeenCalledWith(expect.any(Function));
    expect(result).toBe(42n);
  });

  test('buildSignedUsdcTransfer calls withRpcFailover for getLatestBlockhash', async () => {
    // A blockhash is a 32-byte value, base58-encoded — reuse a fresh
    // keypair's public key bytes as a stand-in so Transaction.sign()'s
    // internal encoding doesn't reject it for being the wrong length.
    const fakeBlockhash = web3Actual.Keypair.generate().publicKey.toBase58();
    mockWithRpcFailover.mockResolvedValueOnce({ blockhash: fakeBlockhash, lastValidBlockHeight: 999 });

    const result = await buildSignedUsdcTransfer('11111111111111111111111111111111', 1_000_000);

    expect(mockWithRpcFailover).toHaveBeenCalledTimes(1);
    expect(mockWithRpcFailover).toHaveBeenCalledWith(expect.any(Function));
    expect(result.blockhash).toBe(fakeBlockhash);
    expect(result.lastValidBlockHeight).toBe(999);
  });
});

describe('call site: getTreasuryUsdcBalanceMinor distinguishes not-found from transport failure', () => {
  let getTreasuryUsdcBalanceMinor;
  let __resetConnectionsForTests;
  let getAccountMock;
  let splTokenActual;

  beforeAll(async () => {
    splTokenActual = await import('@solana/spl-token');
    getAccountMock = jest.fn();

    process.env.TREASURY_SECRET_KEY = bs58.encode(web3Actual.Keypair.generate().secretKey);
    process.env.USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    process.env.HELIUS_URL = 'https://primary.test';

    jest.resetModules();
    // '@solana/spl-token' is mocked here, but its real TokenAccountNotFoundError/
    // TokenInvalidAccountOwnerError classes are re-exported unchanged — solana.js's
    // `instanceof` check needs the exact same class reference the test throws.
    jest.unstable_mockModule('@solana/spl-token', () => ({ ...splTokenActual, getAccount: getAccountMock }));
    // connection.js was registered as a bare-stub mock in the earlier describe
    // block; re-point that registration at the REAL exports (captured at the
    // top of this file, before any mock was registered) so withRpcFailover's
    // actual retry logic runs end-to-end here against the mocked getAccount —
    // jest.unstable_mockModule has no "unmock", so pass-through is how this
    // file un-does an earlier mock registration for the same specifier.
    jest.unstable_mockModule('../../src/utils/connection.js', () => ({
      getConnection, getFallbackConnection, withRpcFailover, __resetConnectionsForTests: resetConnectionsForTests
    }));

    ({ getTreasuryUsdcBalanceMinor } = await import('../../src/utils/solana.js'));
    ({ __resetConnectionsForTests } = await import('../../src/utils/connection.js'));
  });

  beforeEach(() => {
    getAccountMock.mockReset();
    __resetConnectionsForTests();
    delete process.env.SOLANA_RPC_FALLBACK_URL;
  });

  test('TokenAccountNotFoundError resolves to 0n with no failover retry', async () => {
    getAccountMock.mockRejectedValueOnce(new splTokenActual.TokenAccountNotFoundError());

    const result = await getTreasuryUsdcBalanceMinor();

    expect(result).toBe(0n);
    expect(getAccountMock).toHaveBeenCalledTimes(1);
  });

  test('a generic network error propagates out of the primary attempt and resolves via the fallback', async () => {
    process.env.SOLANA_RPC_FALLBACK_URL = 'https://fallback.test';
    getAccountMock
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({ amount: 777n });

    const result = await getTreasuryUsdcBalanceMinor();

    expect(result).toBe(777n);
    expect(getAccountMock).toHaveBeenCalledTimes(2);
  });
});
