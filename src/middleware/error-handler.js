//@ts-check

/**
 * Map error names to HTTP status codes
 * @param {Error} err
 * @param {import('hono').Context} c
 * @returns {Response}
 */
export function errorHandler(err, c) {
  const statusMap = {
    ValidationError: 400,
    NotFoundError: 404,
    MonimeError: 502,
    OnChainError: 502,
    DatabaseError: 500
  };

  const status = statusMap[err.name] || 500;
  const message = status === 500 ? 'Internal server error' : err.message;

  console.error(`[${err.name}] ${err.message}`);

  return c.json({ success: false, message }, status);
}
