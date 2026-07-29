import { corsHeaders, db, json, parseBody, requireDashboardAuth } from '../_shared/command.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const authError = await requireDashboardAuth(request); if (authError) return authError;
  try {
    const body = await parseBody(request) || {};
    const runId = body.run_id;
    const query = runId ? `daily_executive_briefs?run_id=eq.${runId}&select=*&limit=1` : 'daily_executive_briefs?select=*&order=generated_at.desc&limit=1';
    const briefs = await db(query);
    if (!briefs.length) return json({ error: 'Executive brief not found' }, 404);
    return json({ brief: briefs[0] });
  } catch (error) { return json({ error: error.message }, 500); }
});
