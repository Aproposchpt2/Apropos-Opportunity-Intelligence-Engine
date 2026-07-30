import { corsHeaders, db, json, requireDashboardAuth } from '../_shared/command.ts';

const lower=(v:unknown)=>String(v??'').toLowerCase();
const count=(rows:any[],fn:(r:any)=>boolean)=>rows.filter(fn).length;

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const authError = await requireDashboardAuth(request); if (authError) return authError;
  try {
    const [runs, states, capabilities, missionTypes, recommendations, schedules, scheduleRuns, notifications, audit, publishers, opportunities, lifecycle, systemRows, discoveryCommands, candidates, dispositions, outreach, intakes, fitRuns, fitReports, serviceRequests, contractors, subscriptionEvents] = await Promise.all([
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
      db('state_contract_opportunities?select=id,pdas_record_id,title,state_code,issuing_organization,status,response_deadline,lifecycle_status,lifecycle_verification_required,natcorp_release_status,natcorp_contract_dna_status,natcorp_contract_dna_updated_at'),
      db('contract_lifecycle_events?select=*&order=evaluated_at.desc&limit=50'),
      db('system_status?singleton=eq.true&select=*'),
      db('natcorp_business_discovery_commands?select=*&order=created_at.desc&limit=100'),
      db('natcorp_business_discovery_candidates?select=candidate_id,command_id,opportunity_id,business_name,discovery_rank,discovery_score,selected,verification_status,contact_name,contact_email,contact_verified,created_at,updated_at&order=updated_at.desc&limit=250'),
      db('natcorp_candidate_dispositions?select=*&order=created_at.desc&limit=100'),
      db('natcorp_outreach_events?select=outreach_id,opportunity_id,command_id,candidate_id,business_name,contact_name,contact_email,status,response_class,sent_at,replied_at,created_at,updated_at&order=updated_at.desc&limit=100'),
      db('natcorp_business_intakes?select=intake_id,outreach_id,opportunity_id,candidate_id,business_profile_id,status,submitted_at,created_at,updated_at&order=updated_at.desc&limit=100'),
      db('natcorp_analyze_fit_runs?select=run_id,intake_id,opportunity_id,candidate_id,business_profile_id,contract_dna_id,status,score,recommendation,error_message,started_at,completed_at,created_at,updated_at&order=updated_at.desc&limit=100'),
      db('natcorp_analyze_fit_reports?select=report_id,analyze_fit_run_id,opportunity_id,business_profile_id,file_name,generated_at&order=generated_at.desc&limit=100'),
      db('natcorp_service_requests?select=request_id,intake_id,opportunity_id,business_profile_id,service_type,status,created_at,updated_at&order=updated_at.desc&limit=100'),
      db('natcorp_contractor_repository?select=membership_id,business_profile_id,subscription_status,monthly_price,currency,active,subscription_started_at,canceled_at,created_at,updated_at&order=updated_at.desc&limit=250'),
      db('natcorp_subscription_events?select=event_id,membership_id,business_profile_id,event_type,provider,created_at&order=created_at.desc&limit=100')
    ]);
    const activeStates = new Set(['queued','running','retrying','stopping']);
    const activeRuns = runs.filter((r:any)=>activeStates.has(lower(r.status)));
    const attentionRuns = runs.filter((r:any)=>r.action_required || ['failed','interrupted','completed_with_failures'].includes(lower(r.status)));
    const stateCounts:any = {};
    for (const o of opportunities) {
      const s=o.state_code||'--'; stateCounts[s] ||= {total:0,open:0,released:0,verification:0}; stateCounts[s].total++;
      if (lower(o.status)==='open') stateCounts[s].open++; if (lower(o.natcorp_release_status)==='released') stateCounts[s].released++; if (o.lifecycle_verification_required) stateCounts[s].verification++;
    }
    const selectedCandidates=candidates.filter((c:any)=>c.selected);
    const activeMembers=contractors.filter((r:any)=>r.active || ['active','trialing'].includes(lower(r.subscription_status)));
    const otfKpis={
      contract_dna_pending:count(opportunities,(o:any)=>['','not_started'].includes(lower(o.natcorp_contract_dna_status))),
      enrichment_required:count(opportunities,(o:any)=>lower(o.natcorp_contract_dna_status)==='enrichment_required'),
      nomination_ready:count(opportunities,(o:any)=>lower(o.natcorp_contract_dna_status)==='complete'),
      discovery_running:count(discoveryCommands,(r:any)=>['ready','running'].includes(lower(r.status))),
      candidates_discovered:candidates.length,
      selected_businesses:selectedCandidates.length,
      outreach_pending:count(outreach,(r:any)=>['draft','ready'].includes(lower(r.status))),
      outreach_sent:count(outreach,(r:any)=>['sent','delivered'].includes(lower(r.status))),
      awaiting_response:count(outreach,(r:any)=>['sent','delivered'].includes(lower(r.status))&&!r.response_class),
      interested:count(outreach,(r:any)=>lower(r.response_class)==='interested'),
      declined:count(outreach,(r:any)=>['not_interested','declined'].includes(lower(r.response_class)))+count(dispositions,(r:any)=>lower(r.disposition)==='not_interested'),
      intake_in_progress:count(intakes,(r:any)=>['created','started','in_progress'].includes(lower(r.status))),
      analyze_fit_pending:count(fitRuns,(r:any)=>['queued','pending','running'].includes(lower(r.status))),
      analyze_fit_complete:count(fitRuns,(r:any)=>lower(r.status)==='completed'),
      pursue:count(fitRuns,(r:any)=>lower(r.recommendation)==='pursue'),
      reports_ready:fitReports.length,
      proposal_requests:count(serviceRequests,(r:any)=>lower(r.service_type).includes('proposal')),
      active_repository_members:activeMembers.length,
      subscription_mrr:activeMembers.reduce((sum:number,r:any)=>sum+Number(r.monthly_price||0),0)
    };
    const queueDefs=[
      ['CONTRACT DNA PENDING',otfKpis.contract_dna_pending],['CONTRACT ENRICHMENT REQUIRED',otfKpis.enrichment_required],['NOMINATION READY',otfKpis.nomination_ready],['BUSINESS DISCOVERY READY / RUNNING',otfKpis.discovery_running],['CANDIDATE SELECTED',otfKpis.selected_businesses],['OUTREACH READY',otfKpis.outreach_pending],['AWAITING BUSINESS RESPONSE',otfKpis.awaiting_response],['BUSINESS INTERESTED',otfKpis.interested],['INTAKE IN PROGRESS',otfKpis.intake_in_progress],['ANALYZE FIT PENDING',otfKpis.analyze_fit_pending],['ANALYZE FIT COMPLETE',otfKpis.analyze_fit_complete],['REPORT READY',otfKpis.reports_ready],['PROPOSAL DEVELOPMENT REQUEST',otfKpis.proposal_requests]
    ];
    const otfExceptions:any[]=[];
    for(const o of opportunities.filter((x:any)=>lower(x.natcorp_contract_dna_status)==='enrichment_required').slice(0,8)) otfExceptions.push({classification:'VAR-CONTRACT-DNA',opportunity_id:o.id,title:o.title,detail:'Contract DNA enrichment required',retry_available:true,manual_review_required:false});
    for(const r of fitRuns.filter((x:any)=>lower(x.status)==='failed').slice(0,8)) otfExceptions.push({classification:'VAR-ANALYZE-FIT',opportunity_id:r.opportunity_id,business_id:r.business_profile_id,detail:r.error_message||'Analyze Fit failed',retry_available:true,manual_review_required:false});
    for(const c of selectedCandidates.filter((x:any)=>!x.contact_verified).slice(0,8)) otfExceptions.push({classification:'VAR-CONTACT-MISSING',opportunity_id:c.opportunity_id,business_id:c.candidate_id,title:c.business_name,detail:'Selected business contact is not verified',retry_available:false,manual_review_required:true});
    const totals = {states_operational:states.filter((s:any)=>s.inventory_status==='OPERATIONAL').length,states_onboarding:states.filter((s:any)=>['ONBOARDING','MISSION_RUNNING'].includes(s.inventory_status)).length,active_missions:activeRuns.length,missions_requiring_attention:attentionRuns.length,publishers:publishers.length,acquisition_sources:new Set(publishers.map((p:any)=>p.publisher_id)).size,active_procurement_opportunities:opportunities.filter((o:any)=>lower(o.status)==='open'&&(!o.response_deadline||new Date(o.response_deadline)>new Date())).length,canonical_procurement_opportunities:opportunities.length,lifecycle_verification_required:opportunities.filter((o:any)=>o.lifecycle_verification_required).length};
    return json({generated_at:new Date().toISOString(),totals,runs,active_runs:activeRuns,attention_runs:attentionRuns,states,capabilities,mission_types:missionTypes,recommendations,schedules,schedule_runs:scheduleRuns,notifications,audit,lifecycle_events:lifecycle,state_counts:stateCounts,system:systemRows?.[0]||{},otf:{kpis:otfKpis,queues:queueDefs.map(([name,value])=>({name,value})),selected_candidates:selectedCandidates.slice(0,10),recent_discovery:discoveryCommands.slice(0,10),recent_outreach:outreach.slice(0,10),recent_dispositions:dispositions.slice(0,10),recent_fit:fitRuns.slice(0,10),exceptions:otfExceptions,operator_url:'https://natcorp.aproposgroupllc.com/opportunity-fulfillment'}});
  } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 500); }
});