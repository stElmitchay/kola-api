import { jest } from '@jest/globals';

const getSignaturesForAddress = jest.fn();

jest.unstable_mockModule('../../src/utils/connection.js', () => ({
  withRpcFailover: (fn) => fn({ getSignaturesForAddress }),
  getConnection: jest.fn(),
  getFallbackConnection: jest.fn()
}));
jest.unstable_mockModule('../../src/utils/solana.js', () => ({
  getTreasuryAddress: () => 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
}));
jest.unstable_mockModule('../../src/utils/supabase.js', () => ({
  createSupabaseClient: () => ({ from: jest.fn() })
}));

const { getRecentTreasurySignatures } = await import('../../src/repos/reconciliation.js');

const SIGS = [
  { signature: 'NEW1', blockTime: 2_000_000 },
  { signature: 'OLD1', blockTime: 1_000_000 },
  { signature: 'NO_TIME', blockTime: null }
];

describe('RECONCILE_SINCE_UNIX launch watermark', () => {
  beforeAll(() => { process.env.USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; });
  afterEach(() => { delete process.env.RECONCILE_SINCE_UNIX; });

  test('unset (0) — no filtering, all signatures returned', async () => {
    getSignaturesForAddress.mockResolvedValue(SIGS);
    const out = await getRecentTreasurySignatures(50);
    expect(out).toEqual(['NEW1', 'OLD1', 'NO_TIME']);
  });

  test('set — pre-watermark and missing-blockTime signatures are excluded', async () => {
    process.env.RECONCILE_SINCE_UNIX = '1500000';
    getSignaturesForAddress.mockResolvedValue(SIGS);
    const out = await getRecentTreasurySignatures(50);
    expect(out).toEqual(['NEW1']);
  });
});
