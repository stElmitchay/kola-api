//@ts-check

import BigNumber from 'bignumber.js';
import {
  getActiveRate,
  setRate as setRateRepo,
  getRateHistory as getRateHistoryRepo
} from '../../repos/exchange-rates.js';
import { createDatabaseError, createValidationError } from '../../utils/errors.js';

/**
 * Set a new exchange rate for an application. Refuses a move of more than
 * RATE_MAX_MOVE_BPS off the current active rate unless opts.force is set —
 * a fat-fingered rate is the single highest-blast-radius mistake an
 * operator can make (F25).
 *
 * `actor` is the authenticated admin key's name (`c.get('adminActor')`),
 * not the request body's `setBy` field — `setBy` is deprecated (C2): the
 * route ignores it in favour of the authenticated actor, which is what
 * gets written to `exchange_rates.set_by` and to the audit log.
 * @param {string} application
 * @param {number} rate - SLE per 1 USDC
 * @param {string} actor - authenticated admin key name
 * @param {{ force?: boolean }} [opts]
 */
export async function setExchangeRate(application, rate, actor, opts = {}) {
  if (rate <= 0) {
    throw createValidationError('Rate must be a positive number');
  }

  const maxMoveBps = parseInt(process.env.RATE_MAX_MOVE_BPS || '500', 10);
  const { data: current } = await getActiveRate(application);
  if (current && !opts.force) {
    const prev = new BigNumber(current.rate);
    const moveBps = new BigNumber(rate).minus(prev).abs()
      .dividedBy(prev).multipliedBy(10_000);
    if (moveBps.gt(maxMoveBps)) {
      throw createValidationError(
        `Rate move of ${moveBps.toFixed(0)}bps exceeds ${maxMoveBps}bps. ` +
        `Re-submit with "force": true if intentional.`
      );
    }
  }

  const { data, error } = await setRateRepo(application, rate, actor);

  if (error) {
    throw createDatabaseError(`Failed to set exchange rate: ${error.message}`);
  }

  return data;
}

/**
 * Get current active rate and rate history
 * @param {string} application
 */
export async function getExchangeRates(application) {
  const { data: current } = await getActiveRate(application);
  const { data: history, error } = await getRateHistoryRepo(application);

  if (error) {
    throw createDatabaseError(`Failed to fetch exchange rates: ${error.message}`);
  }

  return { current, history };
}
