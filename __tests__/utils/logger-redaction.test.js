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

test('redacts phone_number/phoneNumber/wallet_address/walletAddress nested TWO levels deep', () => {
  const { stream, lines } = makeSink();
  const log = createLogger(stream);

  log.error({
    response: {
      status: 400,
      data: { phone_number: '+23279688339' }
    },
    withdrawal: {
      meta: { walletAddress: 'Ew1abc...', wallet_address: 'Ew1abc...', phoneNumber: '+23279688339' }
    }
  }, 'two-level nesting');

  const entry = lines[0];
  expect(entry.response.data.phone_number).toBe('[redacted]');
  expect(entry.withdrawal.meta.walletAddress).toBe('[redacted]');
  expect(entry.withdrawal.meta.wallet_address).toBe('[redacted]');
  expect(entry.withdrawal.meta.phoneNumber).toBe('[redacted]');
});

test('DOES NOT redact PII nested THREE+ levels deep — pino/fast-redact wildcards match an exact depth, not "any depth" — this is why src/utils/monime.js logs a derived {status, detail} subset instead of the raw vendor payload', () => {
  const { stream, lines } = makeSink();
  const log = createLogger(stream);

  log.error({
    response: {
      data: {
        destination: { phoneNumber: '+23279688339' } // 3 levels deep — out of reach of *.*.phoneNumber
      }
    }
  }, 'three-level nesting, not covered');

  const entry = lines[0];
  expect(entry.response.data.destination.phoneNumber).toBe('+23279688339'); // NOT redacted — documents the gap
});
