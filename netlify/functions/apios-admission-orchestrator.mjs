import { createClient } from '@supabase/supabase-js';
import { executeAdmissionWorkflow, deriveEnterpriseStatus } from './_shared/admission-workflow.mjs';

const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return json(503, { error: 'SERVER_CONFIGURATION_INCOMPLETE' });

  const payload = JSON.parse(event.body || '{}');
  const candidateId = payload.candidate_opportunity_id;
  if (!candidateId) return json(400, { error: 'CANDIDATE_ID_REQUIRED' });

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  try {
    const result = await executeAdmissionWorkflow({
      candidateId,
      correlationId: payload.correlation_id,
      runId: payload.run_id,
      evaluate: async ({ candidateId, correlationId, runId }) => {
        const { data, error } = await supabase.rpc('evaluate_contract_candidate', {
          p_candidate_opportunity_id: candidateId,
          p_evaluation_reason: 'APIOS_ENTRYPOINT',
          p_correlation_id: correlationId,
          p_run_id: runId,
          p_requested_policy_version: null
        });
        if (error) throw error;
        return data;
      },
      promote: async ({ candidateId, evaluationId, correlationId }) => {
        const { data, error } = await supabase.rpc('promote_candidate_to_admitted_contract', {
          p_candidate_opportunity_id: candidateId,
          p_expected_evaluation_id: evaluationId,
          p_correlation_id: correlationId
        });
        if (error) throw error;
        return data;
      },
      reject: async ({ evaluation }) => evaluation,
      aoie: async () => ({ status: 'NOT_EXECUTED_IN_ORCHESTRATOR', delegated: true }),
      deliver: async () => ({ status: 'NOT_EXECUTED_IN_ORCHESTRATOR', delegated: true })
    });

    const enterpriseStatus = deriveEnterpriseStatus({ workflow: result });
    return json(200, { ...result, enterprise_status: enterpriseStatus });
  } catch (error) {
    return json(500, { error: 'ADMISSION_WORKFLOW_FAILED', message: error.message });
  }
}
