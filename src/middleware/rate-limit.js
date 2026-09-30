//@ts-check

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { errorEnvelope } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** @type {import('@upstash/redis').Redis | null} */
let redis = null;
/** env fingerprint the cached client above was built from */
let cachedEnvKey = null;
let warnedMissingEnv = false;

/**
 * Lazily builds the Redis client from env. Returns null (and warns once)
 * when UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN aren't set — never
 * called at module load, so importing this file without Upstash configured
 * (e.g. every existing test) never throws. The env presence check runs on
 * every call (cheap) so the built client is reused across requests on a
 * warm instance without ever masking a since-cleared env var.
 */
function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (!warnedMissingEnv) {
      logger.warn('[RateLimit] UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN not set — rate limiting disabled (fail-open)');
      warnedMissingEnv = true;
    }
    return null;
  }
  const envKey = `${url}:${token}`;
  if (redis && cachedEnvKey === envKey) return redis;
  redis = Redis.fromEnv();
  cachedEnvKey = envKey;
  return redis;
}

/** @type {Map<string, Ratelimit>} */
const limiters = new Map();

/**
 * Keyed on `${UPSTASH_REDIS_REST_URL}|${perMinute}`, not just `perMinute` —
 * a `Ratelimit` instance closes over whatever `Redis` client `getRedis()`
 * returned at construction time. Keying on `perMinute` alone would keep
 * serving requests through the OLD client forever on a warm instance:
 * `getRedis()` already rebuilds its cached client when the URL/token env
 * vars change (credential rotation), but a `Ratelimit` already cached here
 * under the same `perMinute` would never be rebuilt to pick it up. Folding
 * the URL into the cache key makes a rotation naturally mint a fresh
 * `Ratelimit` (and therefore a fresh client) instead of only working after
 * a cold start.
 */
function limiterFor(perMinute) {
  const key = `${process.env.UPSTASH_REDIS_REST_URL}|${perMinute}`;
  if (!limiters.has(key)) {
    limiters.set(key, new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(perMinute, '60 s'),
      prefix: `rl:${perMinute}`
    }));
  }
  return limiters.get(key);
}

/**
 * Per-key rate limiting (F20). Reads the `rate_limit` column exposed by
 * api-key-auth.js as `c.get('rateLimit')` (requests/minute, default 60) and
 * enforces it per `application` via a sliding-window counter in Upstash
 * Redis. Fails open (passes through, logs) whenever Redis is unconfigured
 * or unreachable — availability beats throttling for a payments API whose
 * real abuse ceiling is the daily cap.
 * @param {import('hono').Context} c
 * @param {Function} next
 */
export async function rateLimit(c, next) {
  if (!getRedis()) {
    return next();
  }

  const application = c.get('application');
  const perMinute = c.get('rateLimit') || 60;

  try {
    const { success, limit, remaining, reset } = await limiterFor(perMinute).limit(String(application));
    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(Math.max(0, remaining)));
    c.header('X-RateLimit-Reset', String(Math.ceil(reset / 1000)));
    if (!success) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((reset - Date.now()) / 1000))));
      return c.json(errorEnvelope('RateLimited', 'Rate limit exceeded', c.get('requestId')), 429);
    }
  } catch (e) {
    const log = c.get('log') || logger;
    log.error(`[RateLimit] fail-open: ${e.message}`);
  }

  await next();
}
