import { corsHeaders, json, parseBody, recordMetrics , requireServiceRole } from '../_shared/command.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const roleError = requireServiceRole(request); if (roleError) return roleError;
  try {
    const body = await parseBody(request) || {};
    const metrics = { documents_registered: 0, documents_processed: 0, contract_dna_completed: 0, intelligence_extractions: 0 };
    await recordMetrics(body.run_id, body.job_id, metrics);
    return json({ stage: 'intelligence_processing', metrics, contract_dna: [], enrichment_required: [] });
  } catch (error) { return json({ error: error.message }, 500); }
});
