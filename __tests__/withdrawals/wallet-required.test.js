import { createWithdrawalSchema } from '../../src/schemas/withdrawal.js';

const base = {
  amountUsdc: 1_000_000,
  phoneNumber: '+23276123456',
  providerCode: 'm17'
};

test('fromWalletAddress rejects a 20-char address', () => {
  expect(() => createWithdrawalSchema.parse({
    ...base,
    fromWalletAddress: 'a'.repeat(20)
  })).toThrow();
});

test('fromWalletAddress accepts a valid Solana address', () => {
  expect(createWithdrawalSchema.parse({
    ...base,
    fromWalletAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  })).toBeTruthy();
});
