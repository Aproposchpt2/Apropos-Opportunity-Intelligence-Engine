import { createClient } from '@supabase/supabase-js';
import { validateAnalyzeFitAdmission } from './_shared/admission-control.mjs';

const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return json(503, { error: 'SERVER_CONFIGURATION_INCOMPLETE' });

  const payload = JSON.parse(event.body || '{}');
  if (!payload.admitted_contract_id) return json(400, { error: 'ADMITTED_CONTRACT_ID_REQUIRED' });
  if (!payload.business_profile_id) return json(400, { error: 'BUSINESS_PROFILE_ID_REQUIRED' });

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  try {
    const contract = await validateAnalyzeFitAdmission(supabase, {
      admittedContractId: payload.admitted_contract_id,
      businessProfileId: payload.business_profile_id,
      aoieMatchId: payload.aoie_match_id || null
    });
    return json(200, { authorized: true, contract, analysis_status: 'READY' });
  } catch (error) {
    const denialCodes = new Set([
      'NOT_ADMITTED','ADMISSION_REVOKED','CONTRACT_NOT_OPEN','CONTRACT_EXPIRED',
      'CONTACT_EVIDENCE_INVALID','SCOPE_EVIDENCE_INVALID','REQUIREMENTS_EVIDENCE_INVALID'
    ]);
    return json(denialCodes.has(error.code) ? 403 : 500, {
      authorized: false,
      analysis_status: 'DENIED',
      error: error.code || 'ANALYZE_FIT_ADMISSION_VALIDATION_FAILED',
      message: error.message
    });
  }
}
