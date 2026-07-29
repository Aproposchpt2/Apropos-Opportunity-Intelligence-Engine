import { corsHeaders, db, json, parseBody, requireDashboardAuth } from '../_shared/command.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const authError = await requireDashboardAuth(request); if (authError) return authError;
  try {
    const body = await parseBody(request) || {};
    const runId = body.run_id;
    if (!runId) return json({ error: 'run_id is required' }, 400);
    await db(`command_runs?id=eq.${runId}`, { method: 'PATCH', body: JSON.stringify({ status: 'stopping', stop_requested_at: new Date().toISOString() }) });
    await db('system_status?singleton=eq.true', { method: 'PATCH', body: JSON.stringify({ current_execution_state: 'stopping' }) });
    return json({ run_id: runId, status: 'stopping' });
  } catch (error) { return json({ error: error.message }, 500); }
});
