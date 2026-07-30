import { corsHeaders, db, json, requireDashboardAuth } from '../_shared/command.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const authError = await requireDashboardAuth(request); if (authError) return authError;
  try {
    const [runs, states, capabilities, missionTypes, recommendations, schedules, scheduleRuns, notifications, audit, publishers, opportunities, lifecycle, systemRows] = await Promise.all([
      db('command_runs?select=*&order=created_at.desc&limit=50'),
      db('state_inventory?select=*&order=state_code.asc'),
      db('state_capability_status?select=*&order=state_code.asc,capability_key.asc'),
      db('command_mission_types?enabled=eq.true&select=*&order=mission_type_key.asc'),
      db('command_recommendations?recommendation_status=eq.PROPOSED&select=*&order=generated_at.desc&limit=20'),
      db('operations_schedules?select=*&order=created_at.desc&limit=50'),
      db('operations_schedule_runs?select=*&order=created_at.desc&limit=50'),
      db('command_notifications?select=*&order=created_at.desc&limit=50'),
      db('command_audit_log?select=*&order=occurred_at.desc&limit=50'),
      db('pdas_publishers?select=publisher_id,state_code,research_status,monitoring_status'),
      db('state_contract_opportunities?select=id,state_code,status,response_deadline,lifecycle_status,lifecycle_verification_required,natcorp_release_status'),
      db('contract_lifecycle_events?select=*&order=evaluated_at.desc&limit=50'),
      db('system_status?singleton=eq.true&select=*')
    ]);
    const activeStates = new Set(['queued','running','retrying','stopping']);
    const activeRuns = runs.filter((r:any)=>activeStates.has(String(r.status).toLowerCase()));
    const attentionRuns = runs.filter((r:any)=>r.action_required || ['failed','interrupted','completed_with_failures'].includes(String(r.status).toLowerCase()));
    const stateCounts:any = {};
    for (const o of opportunities) {
      const s=o.state_code||'--';
      stateCounts[s] ||= {total:0,open:0,released:0,verification:0};
      stateCounts[s].total++;
      if (String(o.status).toLowerCase()==='open') stateCounts[s].open++;
      if (String(o.natcorp_release_status).toLowerCase()==='released') stateCounts[s].released++;
      if (o.lifecycle_verification_required) stateCounts[s].verification++;
    }
    const totals = {
      states_operational: states.filter((s:any)=>s.inventory_status==='OPERATIONAL').length,
      states_onboarding: states.filter((s:any)=>['ONBOARDING','MISSION_RUNNING'].includes(s.inventory_status)).length,
      active_missions: activeRuns.length,
      missions_requiring_attention: attentionRuns.length,
      publishers: publishers.length,
      acquisition_sources: new Set(publishers.map((p:any)=>p.publisher_id)).size,
      active_procurement_opportunities: opportunities.filter((o:any)=>String(o.status).toLowerCase()==='open' && (!o.response_deadline || new Date(o.response_deadline)>new Date())).length,
      canonical_procurement_opportunities: opportunities.length,
      lifecycle_verification_required: opportunities.filter((o:any)=>o.lifecycle_verification_required).length
    };
    return json({
      generated_at:new Date().toISOString(), totals, runs, active_runs:activeRuns, attention_runs:attentionRuns,
      states, capabilities, mission_types:missionTypes, recommendations, schedules, schedule_runs:scheduleRuns,
      notifications, audit, lifecycle_events:lifecycle, state_counts:stateCounts, system:systemRows?.[0]||{}
    });
  } catch (error) { return json({ error: error.message }, 500); }
});
