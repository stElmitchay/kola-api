import { jest } from '@jest/globals';

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
  __resetConnectionsForTests
} = await import('../../src/utils/connection.js');

beforeEach(() => {
  jest.clearAllMocks();
  __resetConnectionsForTests();
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

describe('call site: getTreasuryUsdcBalanceMinor goes through withRpcFailover', () => {
  let getTreasuryUsdcBalanceMinor;
  let mockWithRpcFailover;

  beforeAll(async () => {
    const bs58 = (await import('bs58')).default;
    process.env.TREASURY_SECRET_KEY = bs58.encode(web3Actual.Keypair.generate().secretKey);
    process.env.USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    mockWithRpcFailover = jest.fn().mockResolvedValue(0n);
    jest.resetModules();
    jest.unstable_mockModule('../../src/utils/connection.js', () => ({
      getConnection: jest.fn(),
      getFallbackConnection: jest.fn(),
      withRpcFailover: mockWithRpcFailover
    }));

    ({ getTreasuryUsdcBalanceMinor } = await import('../../src/utils/solana.js'));
  });

  test('calls withRpcFailover instead of talking to the connection directly', async () => {
    mockWithRpcFailover.mockResolvedValueOnce(42n);

    const result = await getTreasuryUsdcBalanceMinor();

    expect(mockWithRpcFailover).toHaveBeenCalledTimes(1);
    expect(mockWithRpcFailover).toHaveBeenCalledWith(expect.any(Function));
    expect(result).toBe(42n);
  });
});
