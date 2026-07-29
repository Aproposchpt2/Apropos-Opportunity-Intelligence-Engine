import { corsHeaders, db, invoke, json, parseBody, requireDashboardAuth } from '../_shared/command.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const authError = await requireDashboardAuth(request); if (authError) return authError;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = await parseBody(request) as any;
    const alertId = body?.alert_id;
    const action = body?.selected_action;
    if (!alertId || !action) return json({ error: 'alert_id and selected_action are required' }, 400);
    const allowed = ['Resume Publisher Job','Retry Failed Stage','Send to Engineering Review','Change Acquisition Mode','Defer Publisher','Cancel Publisher Job'];
    if (!allowed.includes(action)) return json({ error: 'Unsupported operator action' }, 400);
    const alerts = await db(`aadp_action_needed_alerts?id=eq.${alertId}&select=*`);
    const alert = alerts?.[0];
    if (!alert) return json({ error: 'ACTION NEEDED alert not found' }, 404);
    await db(`aadp_action_needed_alerts?id=eq.${alertId}`, { method: 'PATCH', body: JSON.stringify({ status: action === 'Defer Publisher' ? 'DEFERRED' : action === 'Cancel Publisher Job' ? 'CANCELLED' : 'RESOLVED', selected_action: action, resolved_at: new Date().toISOString() }) });
    let resume = null;
    if (['Resume Publisher Job','Retry Failed Stage'].includes(action) && alert.command_run_id) {
      resume = await invoke('command-aadp-run', { resume_run_id: alert.command_run_id });
    }
    return json({ success: true, alert_id: alertId, selected_action: action, resume });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
