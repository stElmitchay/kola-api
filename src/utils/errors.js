//@ts-check

/**
 * @param {string} message
 * @returns {Error}
 */
export function createValidationError(message) {
  const error = new Error(message);
  error.name = 'ValidationError';
  return error;
}

/**
 * @param {string} message
 * @returns {Error}
 */
export function createNotFoundError(message) {
  const error = new Error(message);
  error.name = 'NotFoundError';
  return error;
}

/**
 * @param {string} message
 * @returns {Error}
 */
export function createDatabaseError(message) {
  const error = new Error(message);
  error.name = 'DatabaseError';
  return error;
}

/**
 * @param {string} message
 * @returns {Error}
 */
export function createOnChainError(message) {
  const error = new Error(message);
  error.name = 'OnChainError';
  return error;
}

/**
 * @param {string} message
 * @returns {Error}
 */
export function createMonimeError(message) {
  const error = new Error(message);
  error.name = 'MonimeError';
  return error;
}
