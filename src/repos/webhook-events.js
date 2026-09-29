//@ts-check
import { createHash } from 'crypto';
import { createSupabaseClient } from '../utils/supabase.js';

const supabase = createSupabaseClient();

/**
 * Insert-first exactly-once gate. isNew=false ⇒ this exact event was
 * already recorded (duplicate delivery or replay) and must not be
 * re-processed.
 * @param {'monime'|'helius'} provider
 * @param {string | undefined} eventId - provider event id; falls back to body hash
 * @param {string} eventName
 * @param {object} payload
 * @param {string} rawBody
 */
export async function recordWebhookEvent(provider, eventId, eventName, payload, rawBody) {
  const id = eventId || createHash('sha256').update(rawBody).digest('hex');
  const { data, error } = await supabase
    .from('webhook_events')
    .upsert(
      { provider, event_id: id, event_name: eventName, payload },
      { onConflict: 'provider,event_id', ignoreDuplicates: true }
    )
    .select()
    .maybeSingle();
  if (error) return { isNew: false, error };      // fail closed: never double-process on a gate error
  return { isNew: data !== null, error: null };
}
