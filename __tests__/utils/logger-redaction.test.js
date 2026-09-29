import { Writable } from 'stream';
import { createLogger } from '../../src/utils/logger.js';

/**
 * In-memory pino destination: collects each written line, parsed as JSON.
 */
function makeSink() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    }
  });
  return { stream, lines };
}

test('redacts phone_number/phoneNumber/wallet_address/walletAddress and propagates request_id', () => {
  const { stream, lines } = makeSink();
  const log = createLogger(stream);
  const child = log.child({ request_id: 'req-123' });

  child.info({
    phone_number: '+23279688339',
    phoneNumber: '+23279688339',
    wallet_address: 'Ew1abc...treasury',
    walletAddress: 'Ew1abc...treasury',
    destination: 'Ew1abc...treasury',
    from_wallet: 'Ew1abc...sender',
    deposit_id: 'dep-1'
  }, 'deposit initiated');

  expect(lines).toHaveLength(1);
  const entry = lines[0];

  expect(entry.phone_number).toBe('[redacted]');
  expect(entry.phoneNumber).toBe('[redacted]');
  expect(entry.wallet_address).toBe('[redacted]');
  expect(entry.walletAddress).toBe('[redacted]');
  expect(entry.destination).toBe('[redacted]');
  expect(entry.from_wallet).toBe('[redacted]');

  // Non-PII fields survive untouched.
  expect(entry.deposit_id).toBe('dep-1');
  expect(entry.msg).toBe('deposit initiated');

  // request_id set via .child() propagates onto every line logged through it.
  expect(entry.request_id).toBe('req-123');
});

test('redacts nested phone_number/wallet_address one level deep via wildcard paths', () => {
  const { stream, lines } = makeSink();
  const log = createLogger(stream);

  log.info({
    withdrawal: { phone_number: '+23279688339', wallet_address: 'Ew1abc...' }
  }, 'withdrawal event');

  const entry = lines[0];
  expect(entry.withdrawal.phone_number).toBe('[redacted]');
  expect(entry.withdrawal.wallet_address).toBe('[redacted]');
});
