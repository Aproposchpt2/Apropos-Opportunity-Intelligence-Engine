import { corsHeaders, db, invoke, json, parseBody, requireDashboardAuth } from '../_shared/command.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const authError = await requireDashboardAuth(request); if (authError) return authError;
  try {
    const body = await parseBody(request) || {};
    const runId = body.run_id;
    if (!runId) return json({ error: 'run_id is required' }, 400);
    const run = (await db(`command_runs?id=eq.${runId}&select=*`))[0];
    if (!run) return json({ error: 'Run not found' }, 404);
    if (!['failed','interrupted','stopped','completed_with_failures'].includes(run.status)) return json({ error: `Run cannot resume from status ${run.status}` }, 409);
    await db(`command_runs?id=eq.${runId}`, { method: 'PATCH', body: JSON.stringify({ status: 'running', stop_requested_at: null, completed_at: null }) });
    const result = await invoke('command-begin-daily-operations', { operation_date: run.idempotency_key.replace('daily:',''), resume_run_id: runId });
    return json(result);
  } catch (error) { return json({ error: error.message }, 500); }
});
