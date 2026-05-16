//@ts-check

import { randomBytes, randomUUID } from 'crypto';
import { hashApiKey } from '../../utils/crypto.js';
import {
  createApiKey as createApiKeyRepo,
  listApiKeys as listApiKeysRepo,
  deactivateApiKey as deactivateApiKeyRepo
} from '../../repos/api-keys.js';
import { createDatabaseError } from '../../utils/errors.js';

/**
 * Generate a new API key and store its hash
 * @param {object} params
 * @param {string} params.name
 * @param {string} params.businessName
 * @param {string} params.appName
 * @param {string} [params.expiresAt]
 * @param {object} [params.permissions]
 * @param {number} [params.rateLimit]
 * @returns {Promise<{ apiKey: string, record: object }>}
 */
export async function createApiKey(params) {
  const rawKey = `kola_${randomBytes(32).toString('hex')}`;
  const keyHash = hashApiKey(rawKey);

  const { data, error } = await createApiKeyRepo({
    client_id: randomUUID(),
    key_hash: keyHash,
    name: params.name,
    business_name: params.businessName,
    app_name: params.appName,
    expires_at: params.expiresAt,
    permissions: params.permissions || {},
    rate_limit: params.rateLimit || 100
  });

  if (error) {
    throw createDatabaseError(`Failed to create API key: ${error.message}`);
  }

  return { apiKey: rawKey, record: data };
}

/**
 * List all API keys
 */
export async function listApiKeys() {
  const { data, error } = await listApiKeysRepo();

  if (error) {
    throw createDatabaseError(`Failed to list API keys: ${error.message}`);
  }

  return data;
}

/**
 * Deactivate an API key by ID
 * @param {string} id
 */
export async function deactivateApiKey(id) {
  const { data, error } = await deactivateApiKeyRepo(id);

  if (error) {
    throw createDatabaseError(`Failed to deactivate API key: ${error.message}`);
  }

  return data;
}
