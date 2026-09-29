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

/**
 * The one response envelope every error path (errorHandler, the global
 * onError, notFound, and every middleware 4xx) emits — one shape
 * integrators can program against.
 * @param {string} code
 * @param {string} message
 * @param {string|undefined} [requestId]
 * @returns {{ error: { code: string, message: string, request_id: string|null } }}
 */
export function errorEnvelope(code, message, requestId) {
  return { error: { code, message, request_id: requestId ?? null } };
}

/**
 * Readable message from a ZodError: first issue's path + message
 * (e.g. "amount: Expected number, received string").
 * @param {import('zod').ZodError} zodError
 * @returns {string}
 */
export function zodErrorMessage(zodError) {
  const issue = zodError.issues[0];
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}
