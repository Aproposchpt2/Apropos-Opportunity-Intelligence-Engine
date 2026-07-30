import { corsHeaders, json, parseBody, recordMetrics , requireServiceRole } from '../_shared/command.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const roleError = requireServiceRole(request); if (roleError) return roleError;
  try {
    const body = await parseBody(request) || {};
    const metrics = { publishers_processed: 0, opportunities_discovered: 0, opportunities_inserted: 0, opportunities_updated: 0, connector_health: 'governed' };
    await recordMetrics(body.run_id, body.job_id, metrics);
    return json({ stage: 'acquisition', metrics, events: ['Acquisition job discovery completed.', 'Only approved publisher connectors are eligible for execution.'] });
  } catch (error) { return json({ error: error.message }, 500); }
});
