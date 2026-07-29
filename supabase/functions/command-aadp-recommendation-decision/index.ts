import { corsHeaders, db, json, parseBody, requireDashboardAuth } from '../_shared/command.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const authError = await requireDashboardAuth(request); if (authError) return authError;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = await parseBody(request) as any;
    const recommendationId = body?.recommendation_id;
    const decision = body?.decision;
    const allowed = ['APPROVE FOR FURTHER TESTING','RETURN FOR RESEARCH','DEFER','REJECT','ACCEPT NO CHANGE'];
    if (!recommendationId || !allowed.includes(decision)) return json({ error: 'Valid recommendation_id and decision are required' }, 400);
    const recommendations = await db(`aoie_change_recommendations?id=eq.${recommendationId}&select=*`);
    if (!recommendations?.[0]) return json({ error: 'Recommendation not found' }, 404);
    await db('aadp_recommendation_decisions', { method: 'POST', body: JSON.stringify({ recommendation_id: recommendationId, decision, decision_evidence: { source: 'COMMAND_CENTER', production_matching_changed: false } }) });
    const state = decision === 'APPROVE FOR FURTHER TESTING' ? 'TEST_CANDIDATE' : decision === 'RETURN FOR RESEARCH' ? 'RESEARCH_CANDIDATE' : decision === 'REJECT' ? 'REJECTED_UPDATE' : recommendations[0].state;
    await db(`aoie_change_recommendations?id=eq.${recommendationId}`, { method: 'PATCH', body: JSON.stringify({ state, production_applied: false }) });
    return json({ success: true, recommendation_id: recommendationId, decision, production_matching_changed: false });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
