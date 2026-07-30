import { corsHeaders, json, parseBody, recordMetrics , requireServiceRole } from '../_shared/command.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const roleError = requireServiceRole(request); if (roleError) return roleError;
  try {
    const body = await parseBody(request) || {};
    const metrics = { opportunities_evaluated: 0, eligible_opportunities: 0, review_required: 0, average_fit_score: 0, average_confidence_score: 0 };
    await recordMetrics(body.run_id, body.job_id, metrics);
    return json({ stage: 'eligibility_matching', metrics, eligible: [], match_evidence: [], confidence_distribution: {} });
  } catch (error) { return json({ error: error.message }, 500); }
});
