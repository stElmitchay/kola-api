//@ts-check

// CONFIG-SCOPE tradeoff (documented per controller ruling on task C4):
// The brief's original ask was "config() exposes every env var, replace
// every process.env.X read". That would require every one of the ~20 test
// files that set process.env per-test (supabase client, admin-auth,
// rate-limit, etc.) to also seed every REQUIRED var before importing
// anything, or to reach into a config-reset hook — a large, brittle churn
// for a formatting change.
//
// Instead this module is a STARTUP GATE only:
//   - `validateConfig()` throws ONE error listing every missing REQUIRED
//     var. It validates on first call (not at import) and caches the
//     result. Call it once, at app entry (api/index.js), so a missing var
//     fails fast and loudly in production without forcing every test that
//     merely imports a leaf module to also stub the full env.
//   - `envInt`/`envStr` are live readers (no caching) for OPTIONAL vars
//     with defaults — they read `process.env` on every call so tests that
//     set/unset env vars per-test keep working unmodified. They replace
//     the two duplicated local `envInt` helpers that used to live in
//     deposits.js and withdrawals.js.
// Leaf modules continue to read `process.env` directly for vars this file
// doesn't wrap (RATE_MAX_AGE_MINUTES, RATE_MAX_MOVE_BPS, MONIME_TIMEOUT_MS,
// etc.) — the gate guarantees REQUIRED vars are present at startup, not
// that every read is funneled through one accessor.

export const REQUIRED_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'MONIME_ACCESS_TOKEN',
  'MONIME_SPACE_ID',
  'MONIME_WEBHOOK_SECRET',
  'MONIME_FINANCIAL_ACCOUNT_ID',
  'HELIUS_URL',
  'TREASURY_SECRET_KEY',
  'USDC_MINT',
  'HELIUS_WEBHOOK_AUTH_HEADER',
  'API_KEY_SALT',
  'CRON_SECRET'
];

/** Numeric optionals with defaults — consolidates the two duplicated `envInt` helpers. */
const NUMERIC_DEFAULTS = {
  WITHDRAWAL_FEE_BPS: 100,
  WITHDRAWAL_MIN_USDC: 100_000,
  WITHDRAWAL_MAX_USDC: 100_000_000,
  WITHDRAWAL_DAILY_CAP_USDC: 500_000_000,
  DEPOSIT_MIN_SLE: 100,
  DEPOSIT_MAX_SLE: 500_000,
  MONIME_TIMEOUT_MS: 15000,
  RATE_MAX_AGE_MINUTES: 1440,
  RATE_MAX_MOVE_BPS: 500,
  STUCK_THRESHOLD_MINUTES: 30
};

let validated = false;

/**
 * Startup gate — throws one error listing every missing REQUIRED var.
 * Validates on first call and caches the result; safe to call repeatedly.
 * @returns {void}
 */
export function validateConfig() {
  if (validated) return;
  const missing = REQUIRED_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  validated = true;
}

/**
 * Live-reading numeric env accessor with a default (no caching — reads
 * process.env on every call so per-test env mutation keeps working).
 * @param {keyof typeof NUMERIC_DEFAULTS} name
 * @returns {number}
 */
export function envInt(name) {
  const raw = process.env[name];
  const fallback = NUMERIC_DEFAULTS[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Live-reading string env accessor.
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string|undefined}
 */
export function envStr(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

/**
 * Test-only: resets the validated-once cache so tests can exercise both
 * the missing-vars and the happy path in the same file.
 * @returns {void}
 */
export function __resetConfigForTests() {
  validated = false;
}
