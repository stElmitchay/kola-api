//@ts-check

import {
  getActiveRate,
  setRate as setRateRepo,
  getRateHistory as getRateHistoryRepo
} from '../../repos/exchange-rates.js';
import { createDatabaseError, createValidationError } from '../../utils/errors.js';

/**
 * Set a new exchange rate for an application
 * @param {string} application
 * @param {number} rate - SLE per 1 USDC
 * @param {string} setBy
 */
export async function setExchangeRate(application, rate, setBy) {
  if (rate <= 0) {
    throw createValidationError('Rate must be a positive number');
  }

  const { data, error } = await setRateRepo(application, rate, setBy);

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
