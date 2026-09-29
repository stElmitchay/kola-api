//@ts-check
import { Hono } from 'hono';
import { verifyCronAuth } from '../../utils/cron-auth.js';
import { handleHeliusEvent } from '../webhooks/helius-handler.js';
import { getTreasuryUsdcBalanceMinor } from '../../utils/solana.js';
import {
  getRecentTreasurySignatures, hasProcessedSignature, getParsedTransfersForSignature,
  getLedgerTreasuryBalanceMinor, listStaleInflight, deleteExpiredIdempotencyKeys
} from '../../repos/reconciliation.js';
import { errorEnvelope } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

// Balance proof tolerance: USDC (unlike SOL, which pays gas) never moves on
// its own — any non-zero difference between the on-chain treasury ATA
// balance and the ledger's treasury_usdc account is a real gap, not noise.
const BALANCE_TOLERANCE_MINOR = 0n;
const DEFAULT_SIGNATURE_LIMIT = 50;
const DEFAULT_STUCK_THRESHOLD_MINUTES = 30;

const app = new Hono();

app.post('/', async (c) => {
  if (!verifyCronAuth(c)) {
    return c.json(errorEnvelope('Unauthorized', 'unauthorized', c.get('requestId')), 401);
  }
  const results = await runReconcile();
  return c.json(results);
});

/**
 * Pass 1 — missed-event sweep. Walks the most recent signatures on the
 * treasury USDC ATA; for any signature not already accounted for by the
 * normal webhook-driven paths (`hasProcessedSignature`), fetches and adapts
 * the parsed transaction and replays it through `handleHeliusEvent`. All
 * downstream writes triggered from there are CAS/unique-keyed, so a replay
 * of an already-processed transfer is safe by construction — this pass
 * only exists to catch the transfers Helius silently never delivered a
 * webhook for.
 * @returns {Promise<{checked: number, replayed: string[]}>}
 */
export async function sweepMissedEvents() {
  const signatures = await getRecentTreasurySignatures(DEFAULT_SIGNATURE_LIMIT);
  const replayed = [];
  for (const signature of signatures) {
    const processed = await hasProcessedSignature(signature);
    if (processed) continue;

    const events = await getParsedTransfersForSignature(signature);
    if (events.length === 0) continue;

    await handleHeliusEvent(events);
    replayed.push(signature);
  }
  if (replayed.length > 0) {
    logger.error({ alert: true }, `[Reconcile] ALERT: replayed ${replayed.length} missed signature(s): ${replayed.join(', ')}`);
  }
  return { checked: signatures.length, replayed };
}

/**
 * Pass 2 — balance proof. On-chain treasury USDC balance vs. the ledger's
 * treasury_usdc account balance. Tolerance is 0: gas is paid in SOL, not
 * USDC, so the two must match exactly at every tick. Any mismatch logs
 * RECONCILIATION_MISMATCH at alert level (C4 wires this to paging).
 * @returns {Promise<{onchain: string, ledger: string, mismatch: boolean}>}
 */
export async function proveBalance() {
  const [onchain, ledger] = await Promise.all([
    getTreasuryUsdcBalanceMinor(),
    getLedgerTreasuryBalanceMinor()
  ]);
  const diff = onchain > ledger ? onchain - ledger : ledger - onchain;
  const mismatch = diff > BALANCE_TOLERANCE_MINOR;
  if (mismatch) {
    logger.error({ alert: true }, `[Reconcile] ALERT: RECONCILIATION_MISMATCH onchain=${onchain} ledger=${ledger}`);
  }
  return { onchain: onchain.toString(), ledger: ledger.toString(), mismatch };
}

/**
 * Pass 3 — stuck-state sweep. Surfaces (does not touch) rows sitting in a
 * non-terminal state longer than `STUCK_THRESHOLD_MINUTES` (default 30) —
 * an operator-visible symptom of a stalled webhook, a dead cron, or an RPC
 * outage. Each stale row logs a `STUCK <id>` alert line.
 * @returns {Promise<{table: string, id: string, status: string, age_minutes: number}[]>}
 */
export async function sweepStuckRows() {
  const thresholdMinutes = Number(process.env.STUCK_THRESHOLD_MINUTES) || DEFAULT_STUCK_THRESHOLD_MINUTES;
  const stale = await listStaleInflight(thresholdMinutes);
  for (const row of stale) {
    logger.error(
      { alert: true },
      `[Reconcile] ALERT: STUCK ${row.id} table=${row.table} status=${row.status} age_minutes=${row.age_minutes}`
    );
  }
  return stale;
}

/**
 * Pass 4 — housekeeping. Deletes `idempotency_keys` rows older than 24h
 * (B7 created the table; nothing pruned it until now).
 * @returns {Promise<{deleted: number}>}
 */
export async function cleanupIdempotencyKeys() {
  const deleted = await deleteExpiredIdempotencyKeys();
  return { deleted };
}

/**
 * Run all four reconciliation passes. Each is wrapped independently — one
 * pass throwing must never stop the others (e.g. an RPC outage killing the
 * missed-event sweep must not also prevent the balance proof or the stuck
 * sweep from running). A pass that throws logs an ALERT and its slot in the
 * returned summary reports `ok: false` with the error message.
 * @returns {Promise<Record<string, {ok: boolean, result?: any, error?: string}>>}
 */
export async function runReconcile() {
  const passes = [
    ['sweepMissedEvents', sweepMissedEvents],
    ['proveBalance', proveBalance],
    ['sweepStuckRows', sweepStuckRows],
    ['cleanupIdempotencyKeys', cleanupIdempotencyKeys]
  ];

  const results = {};
  for (const [name, pass] of passes) {
    try {
      results[name] = { ok: true, result: await pass() };
    } catch (e) {
      logger.error({ alert: true }, `[Reconcile] ALERT: pass ${name} threw and was skipped: ${e.message}`);
      results[name] = { ok: false, error: e.message };
    }
  }
  return results;
}

export default app;
