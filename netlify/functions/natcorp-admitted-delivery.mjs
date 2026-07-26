import { createClient } from '@supabase/supabase-js';
import { getNatcorpAuthorizedDelivery } from './_shared/admission-control.mjs';

const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return json(503, { error: 'SERVER_CONFIGURATION_INCOMPLETE' });

  const payload = JSON.parse(event.body || '{}');
  if (!payload.admitted_contract_id) return json(400, { error: 'ADMITTED_CONTRACT_ID_REQUIRED' });

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  try {
    const delivery = await getNatcorpAuthorizedDelivery(supabase, payload.admitted_contract_id, payload.business_profile_id || null);
    return json(200, { authorized: true, delivery });
  } catch (error) {
    const statusCode = ['NOT_ADMITTED', 'DELIVERY_NOT_AUTHORIZED'].includes(error.code) ? 403 : 500;
    return json(statusCode, { authorized: false, error: error.code || 'DELIVERY_LOOKUP_FAILED', message: error.message });
  }
}
