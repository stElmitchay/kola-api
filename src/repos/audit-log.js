//@ts-check

import { createSupabaseClient } from '../utils/supabase.js';

const supabase = createSupabaseClient();

/**
 * Insert an append-only audit row for an admin/operator action (F12).
 *
 * Never throws. A write failure (RPC error or rejection) is
 * console.error'd at alert level and swallowed — the admin action this
 * describes has already happened and must never be rolled back or blocked
 * by an audit write failing.
 *
 * @param {object} params
 * @param {string} params.actor - admin key label (or 'system:<job>')
 * @param {string} params.action - e.g. 'api_key.create', 'rate.set'
 * @param {string} [params.resourceType]
 * @param {string} [params.resourceId]
 * @param {object|null} [params.before]
 * @param {object|null} [params.after]
 * @param {string|null} [params.ip]
 */
export async function writeAudit({ actor, action, resourceType, resourceId, before, after, ip }) {
  try {
    const { error } = await supabase.from('audit_log').insert({
      actor,
      action,
      resource_type: resourceType ?? null,
      resource_id: resourceId ?? null,
      before: before ?? null,
      after: after ?? null,
      ip: ip ?? null
    });
    if (error) {
      console.error(`[Audit] ALERT: writeAudit failed action=${action} resource=${resourceType}:${resourceId}: ${error.message}`);
    }
  } catch (e) {
    console.error(`[Audit] ALERT: writeAudit threw action=${action} resource=${resourceType}:${resourceId}: ${e.message}`);
  }
}
