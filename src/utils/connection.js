//@ts-check

import { Connection } from '@solana/web3.js';
import { logger } from './logger.js';

/** @type {Connection | null} */
let connection = null;

/** @type {Connection | null} */
let fallbackConnection = null;

/**
 * Get or create the primary Solana RPC connection, at 'finalized' commitment
 * (B3 deferral, F17). 'confirmed' can still be rolled back by a fork; this
 * codebase already special-cased several call sites to 'finalized' one at a
 * time (getCurrentBlockHeight, buildSignedUsdcTransfer's blockhash) because
 * the connection default lagged behind — mixing commitment levels across the
 * same codebase was flagged in B3's review as a gap. Moving the connection's
 * own default to 'finalized' closes that gap at the source instead of
 * requiring every call site to remember to override it.
 * @returns {Connection}
 */
export function getConnection() {
  if (!connection) {
    connection = new Connection(process.env.HELIUS_URL, 'finalized');
  }
  return connection;
}

/**
 * Get or create the fallback Solana RPC connection, lazily. Returns `null`
 * when `SOLANA_RPC_FALLBACK_URL` is unset — `withRpcFailover` treats that as
 * "failover disabled" and rethrows the primary's error instead of retrying.
 * @returns {Connection | null}
 */
export function getFallbackConnection() {
  if (!process.env.SOLANA_RPC_FALLBACK_URL) return null;
  if (!fallbackConnection) {
    fallbackConnection = new Connection(process.env.SOLANA_RPC_FALLBACK_URL, 'finalized');
  }
  return fallbackConnection;
}

/**
 * Run `fn` against the primary connection; on any failure, retry it ONCE
 * against the fallback connection if `SOLANA_RPC_FALLBACK_URL` is
 * configured. No further retries beyond that — a fallback failure
 * propagates as-is. Any throw from `fn` is treated as retryable; callers
 * keep their own logic simple rather than trying to classify errors.
 *
 * Safe for both reads and sends: a send re-broadcast through this wrapper
 * after a primary failure is protected by the B3 signature-fence (the
 * signature is persisted before broadcast) — re-broadcasting an identical
 * serialized transaction is idempotent on-chain, so retrying a send here
 * can never double-spend.
 *
 * The other half of that story: if the primary DID actually broadcast
 * before failing (e.g. it accepted the tx but timed out waiting for
 * confirmation), the fallback's re-send of the same serialized transaction
 * lands on an already-processed signature — the fallback RPC throws an
 * "already processed" error, which this function does not swallow (no
 * second retry). That throw is expected, not a bug: it burns one
 * transfer-job `bumpAttempt` and the job is picked up again next
 * transfer-tick, where `checkSignatureLanded` finds the signature already
 * finalized on-chain and finishes the job normally. Self-healing by
 * design — see `checkSignatureLanded` and the transfer-tick worker.
 *
 * @template T
 * @param {(connection: Connection) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withRpcFailover(fn) {
  try {
    return await fn(getConnection());
  } catch (err) {
    const fallback = getFallbackConnection();
    if (!fallback) throw err;
    logger.error({ alert: true, err: err.message }, '[RPC] primary failed, trying fallback');
    return fn(fallback);
  }
}

/** Test-only: clears the cached connections so env var changes take effect. */
export function __resetConnectionsForTests() {
  connection = null;
  fallbackConnection = null;
}
