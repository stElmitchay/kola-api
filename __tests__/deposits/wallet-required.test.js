import { createDepositSchema } from '../../src/schemas/deposit.js';

test('deposit without walletAddress is rejected', () => {
  expect(() => createDepositSchema.parse({
    amount: 10_000, currency: 'SLE', paymentMethod: 'ussd', phoneNumber: '+23276123456'
  })).toThrow();
});

test('deposit with a malformed address is rejected', () => {
  expect(() => createDepositSchema.parse({
    amount: 10_000, currency: 'SLE', paymentMethod: 'ussd',
    phoneNumber: '+23276123456', walletAddress: 'not-base58-!!'
  })).toThrow();
});

test('deposit with a valid address parses', () => {
  expect(createDepositSchema.parse({
    amount: 10_000, currency: 'SLE', paymentMethod: 'ussd',
    phoneNumber: '+23276123456',
    walletAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  })).toBeTruthy();
});
