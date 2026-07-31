import { corsHeaders, db, json, requireDashboardAuth } from '../_shared/command.ts';

const lower=(v:unknown)=>String(v??'').toLowerCase();
const upper=(v:unknown)=>String(v??'').toUpperCase();
const count=(rows:any[],fn:(r:any)=>boolean)=>rows.filter(fn).length;
const ageMinutes=(value:unknown)=>value?Math.max(0,(Date.now()-new Date(String(value)).getTime())/60000):null;
const latestTimestamp=(rows:any[],fields:string[])=>{
  let latest='';
  for(const row of rows||[])for(const field of fields){const value=row?.[field];if(value&&(!latest||new Date(value)>new Date(latest)))latest=value;}
  return latest||null;
};
const staleAwareStatus=(raw:unknown,observedAt:unknown,maxAgeMinutes=30)=>{
  const status=upper(raw)||'UNKNOWN';
  const age=ageMinutes(observedAt);
  if(age===null)return ['HEALTHY','CONNECTED','OPERATIONAL','READY','AVAILABLE'].includes(status)?'UNVERIFIED':status;
  if(age>maxAgeMinutes&&['HEALTHY','CONNECTED','OPERATIONAL','READY','AVAILABLE'].includes(status))return'STALE';
  return status;
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const authError = await requireDashboardAuth(request); if (authError) return authError;
  try {
    const [
      runs, states, capabilities, missionTypes, recommendations, schedules, scheduleRuns,
      notifications, audit, publishers, publisherRegistry, opportunities, lifecycle, systemRows,
      generalDiscoveryRuns, generalDiscoveryCandidates, acquisitionRuns, rawRecords, briefs,
      discoveryCommands, candidates, dispositions, outreach, intakes, fitRuns, fitReports,
      serviceRequests, contractors, subscriptionEvents
    ] = await Promise.all([
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
      db('publisher_registry?select=id,publisher_name,state_code,organization_type,official_website,procurement_website,acquisition_method,search_endpoint,verified,access_status,last_verified_at,updated_at&order=state_code.asc,publisher_name.asc'),
      db('state_contract_opportunities?select=id,pdas_record_id,title,state_code,issuing_organization,status,response_deadline,lifecycle_status,lifecycle_verification_required,natcorp_release_status,natcorp_contract_dna_status,natcorp_contract_dna_updated_at'),
      db('contract_lifecycle_events?select=*&order=evaluated_at.desc&limit=50'),
      db('system_status?singleton=eq.true&select=*'),
      db('command_discovery_runs?select=id,command_run_id,mission_type_key,state_code,status,current_stage,result_count,started_at,completed_at,created_at,updated_at&order=updated_at.desc&limit=50'),
      db('command_discovery_candidates?select=id,discovery_run_id,mission_type_key,state_code,organization_name,organization_type,official_website,source_verified,duplicate_status,review_status,prospect_score,created_at,updated_at&order=updated_at.desc&limit=100'),
      db('acquisition_runs?select=id,command_run_id,assignment_id,status,records_discovered,records_acquired,pages_processed,retrieval_failures,pagination_complete,resume_stage,started_at,completed_at,created_at&order=created_at.desc&limit=50'),
      db('acquisition_raw_records?select=id,acquisition_run_id,publisher_id,source_record_id,source_url,retrieval_timestamp,processing_status,version_number,is_current_version,detail_retrieval_status,document_manifest_count,amendment_count&order=retrieval_timestamp.desc&limit=250'),
      db('daily_executive_briefs?select=id,run_id,brief_date,overall_status,generated_at,created_at&order=generated_at.desc&limit=25'),
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

    const generatedAt=new Date().toISOString();
    const activeStates = new Set(['queued','running','retrying','stopping']);
    const activeRuns = runs.filter((r:any)=>activeStates.has(lower(r.status)));
    const attentionRuns = runs.filter((r:any)=>r.action_required || ['failed','interrupted','completed_with_failures'].includes(lower(r.status)));
    const stateCounts:any = {};
    for (const o of opportunities) {
      const s=o.state_code||'--'; stateCounts[s] ||= {total:0,open:0,released:0,verification:0}; stateCounts[s].total++;
      if (lower(o.status)==='open') stateCounts[s].open++;
      if (lower(o.natcorp_release_status)==='released') stateCounts[s].released++;
      if (o.lifecycle_verification_required) stateCounts[s].verification++;
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

    const system=systemRows?.[0]||{};
    const systemObservedAt=system.updated_at||system.created_at||null;
    const connectorRaw=system.connector_health?.overall||system.connector_health?.status||'UNKNOWN';
    const connectorStatus=staleAwareStatus(connectorRaw,systemObservedAt,30);
    const verifiedPublishers=publisherRegistry.filter((p:any)=>p.verified);
    const freshVerifiedPublishers=verifiedPublishers.filter((p:any)=>{
      const age=ageMinutes(p.last_verified_at);
      return age!==null&&age<=60*24*30;
    });
    const publisherEvidenceStatus=publisherRegistry.length===0?'EMPTY':verifiedPublishers.length===0?'UNEVALUATED':freshVerifiedPublishers.length===0?'STALE':'EVIDENCED';
    const latestAcquisition=acquisitionRuns[0]||null;
    const acquisitionStatus=latestAcquisition?upper(latestAcquisition.status):'UNEVALUATED';
    const health={
      database:{status:'CONNECTED',source:'command-executive-status server-side PostgREST reads',observed_at:generatedAt,detail:'Authoritative database queries completed successfully for this response.'},
      command_runtime:{status:activeRuns.length?'RUNNING':'IDLE',source:'command_runs',observed_at:latestTimestamp(runs,['updated_at','created_at'])||generatedAt,detail:`${activeRuns.length} active mission(s)`},
      connector_health:{status:connectorStatus,source:'system_status.connector_health',observed_at:systemObservedAt,evidence:system.connector_health||{},stale:connectorStatus==='STALE'},
      publisher_registry:{status:publisherEvidenceStatus,source:'publisher_registry.verified + last_verified_at',observed_at:latestTimestamp(publisherRegistry,['last_verified_at','updated_at']),detail:`${verifiedPublishers.length}/${publisherRegistry.length} verified; ${freshVerifiedPublishers.length} verified within 30 days`},
      acquisition:{status:acquisitionStatus,source:'acquisition_runs',observed_at:latestTimestamp(acquisitionRuns,['completed_at','started_at','created_at']),detail:latestAcquisition?`Latest run ${latestAcquisition.id}`:'No acquisition run evidence'},
      scheduler:{status:schedules.some((s:any)=>s.enabled)?'ENABLED':'DISABLED',source:'operations_schedules.enabled',observed_at:latestTimestamp(schedules,['updated_at','created_at'])||generatedAt},
      lifecycle_apply:{status:'INACTIVE',source:'APIOS governance: lifecycle apply remains operator-controlled',observed_at:generatedAt},
      natcorp_otf:{status:'AVAILABLE',source:'server-side NAT-CORP Service 2 data-plane reads',observed_at:generatedAt,detail:'NAT-CORP discovery, candidate, outreach, intake, fit, report, service-request, and repository tables were queried successfully.'}
    };

    const totals = {
      states_operational:states.filter((s:any)=>s.inventory_status==='OPERATIONAL').length,
      states_onboarding:states.filter((s:any)=>['ONBOARDING','MISSION_RUNNING'].includes(s.inventory_status)).length,
      active_missions:activeRuns.length,
      missions_requiring_attention:attentionRuns.length,
      publishers:publishers.length,
      acquisition_sources:new Set(publishers.map((p:any)=>p.publisher_id)).size,
      active_procurement_opportunities:opportunities.filter((o:any)=>lower(o.status)==='open'&&(!o.response_deadline||new Date(o.response_deadline)>new Date())).length,
      canonical_procurement_opportunities:opportunities.length,
      lifecycle_verification_required:opportunities.filter((o:any)=>o.lifecycle_verification_required).length
    };

    const inventorySummary={
      total:opportunities.length,
      open:count(opportunities,(o:any)=>lower(o.status)==='open'),
      released:count(opportunities,(o:any)=>lower(o.natcorp_release_status)==='released'),
      lifecycle_verification_required:count(opportunities,(o:any)=>Boolean(o.lifecycle_verification_required)),
      contract_dna_complete:count(opportunities,(o:any)=>lower(o.natcorp_contract_dna_status)==='complete')
    };
    const acquisitionSummary={
      recent_runs:acquisitionRuns,
      recent_raw_records:rawRecords,
      recent_raw_record_count:rawRecords.length,
      failed_recent_runs:count(acquisitionRuns,(r:any)=>lower(r.status)==='failed'),
      latest_run:latestAcquisition
    };
    const publisherDiscovery={
      runs:generalDiscoveryRuns,
      candidates:generalDiscoveryCandidates,
      pending_review:count(generalDiscoveryCandidates,(c:any)=>lower(c.review_status)==='pending_review'),
      source_verified:count(generalDiscoveryCandidates,(c:any)=>Boolean(c.source_verified))
    };
    const deliverables={
      executive_briefs:briefs,
      analyze_fit_reports:fitReports,
      executive_brief_count:briefs.length,
      analyze_fit_report_count:fitReports.length
    };

    return json({
      generated_at:generatedAt,
      totals,
      runs,
      active_runs:activeRuns,
      attention_runs:attentionRuns,
      states,
      capabilities,
      mission_types:missionTypes,
      recommendations,
      schedules,
      schedule_runs:scheduleRuns,
      notifications,
      audit,
      lifecycle_events:lifecycle,
      state_counts:stateCounts,
      system,
      health,
      publisher_discovery:publisherDiscovery,
      publisher_registry:publisherRegistry,
      acquisition:acquisitionSummary,
      procurement_inventory:{summary:inventorySummary,recent:opportunities.slice(0,25)},
      deliverables,
      otf:{
        kpis:otfKpis,
        queues:queueDefs.map(([name,value])=>({name,value})),
        selected_candidates:selectedCandidates.slice(0,10),
        recent_discovery:discoveryCommands.slice(0,10),
        recent_outreach:outreach.slice(0,10),
        recent_dispositions:dispositions.slice(0,10),
        recent_fit:fitRuns.slice(0,10),
        exceptions:otfExceptions,
        operator_url:'https://natcorp.aproposgroupllc.com/opportunity-fulfillment'
      }
    });
  } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 500); }
});
