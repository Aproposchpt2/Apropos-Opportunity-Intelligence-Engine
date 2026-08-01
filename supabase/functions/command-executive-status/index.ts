import { corsHeaders, db, json, requireDashboardAuth } from '../_shared/command.ts';

const lower=(v:unknown)=>String(v??'').toLowerCase();
const upper=(v:unknown)=>String(v??'').toUpperCase();
const count=(rows:any[],fn:(r:any)=>boolean)=>rows.filter(fn).length;
const latest=(rows:any[],fields:string[])=>{let value='';for(const row of rows||[])for(const field of fields){const v=row?.[field];if(v&&(!value||new Date(v)>new Date(value)))value=v}return value||null};
const ageMinutes=(value:unknown)=>value?Math.max(0,(Date.now()-new Date(String(value)).getTime())/60000):null;
const evidenceStatus=(raw:unknown,observedAt:unknown,maxAge=30)=>{const status=upper(raw)||'UNKNOWN',age=ageMinutes(observedAt);if(age===null)return['HEALTHY','CONNECTED','OPERATIONAL','READY','AVAILABLE'].includes(status)?'UNVERIFIED':status;if(age>maxAge&&['HEALTHY','CONNECTED','OPERATIONAL','READY','AVAILABLE'].includes(status))return'STALE';return status};

Deno.serve(async request=>{
  if(request.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});
  const authError=await requireDashboardAuth(request);if(authError)return authError;
  try{
    const [runs,states,capabilities,missionTypes,schedules,scheduleRuns,notifications,audit,publishers,assignments,opportunities,lifecycle,systemRows,acquisitionRuns,rawRecords]=await Promise.all([
      db('command_runs?select=*&order=created_at.desc&limit=100'),
      db('state_inventory?select=*&order=state_code.asc'),
      db('state_capability_status?select=*&order=state_code.asc,capability_key.asc'),
      db('command_mission_types?enabled=eq.true&select=*&order=mission_type_key.asc'),
      db('operations_schedules?select=*&order=created_at.desc&limit=50'),
      db('operations_schedule_runs?select=*&order=created_at.desc&limit=50'),
      db('command_notifications?select=*&order=created_at.desc&limit=50'),
      db('command_audit_log?select=*&order=occurred_at.desc&limit=100'),
      db('publisher_registry?select=*&order=state_code.asc,publisher_name.asc'),
      db('publisher_assignments?select=*&order=updated_at.desc'),
      db('state_contract_opportunities?select=id,pdas_record_id,title,state_code,issuing_organization,status,response_deadline,lifecycle_status,lifecycle_verification_required,natcorp_release_status,natcorp_contract_dna_status,natcorp_contract_dna_updated_at,created_at,updated_at&order=updated_at.desc&limit=1000'),
      db('contract_lifecycle_events?select=*&order=evaluated_at.desc&limit=100'),
      db('system_status?singleton=eq.true&select=*'),
      db('acquisition_runs?select=*&order=created_at.desc&limit=100'),
      db('acquisition_raw_records?select=id,acquisition_run_id,publisher_id,source_record_id,source_url,retrieval_timestamp,processing_status,version_number,is_current_version,detail_retrieval_status,document_manifest_count,amendment_count&order=retrieval_timestamp.desc&limit=500')
    ]);
    const generatedAt=new Date().toISOString();
    const activeStatuses=new Set(['queued','running','retrying','stopping']);
    const activeRuns=(runs||[]).filter((r:any)=>activeStatuses.has(lower(r.status)));
    const attentionRuns=(runs||[]).filter((r:any)=>r.action_required||['failed','interrupted','completed_with_failures'].includes(lower(r.status)));
    const assignmentById=new Map((assignments||[]).map((a:any)=>[String(a.id),a]));
    const publisherById=new Map((publishers||[]).map((p:any)=>[String(p.id),p]));
    const enrichedAcquisition=(acquisitionRuns||[]).map((r:any)=>{const a=assignmentById.get(String(r.assignment_id))||{};const p=publisherById.get(String(a.publisher_id))||{};return {...r,publisher_id:a.publisher_id||r.publisher_id||null,publisher_name:a.publisher_name||p.publisher_name||null,state_code:p.state_code||null,acquisition_method:a.acquisition_method||p.acquisition_method||null}});
    const stateCounts:any={};
    for(const o of opportunities||[]){const s=o.state_code||'--';stateCounts[s]||={total:0,open:0,verification:0};stateCounts[s].total++;if(lower(o.status)==='open'&&(!o.response_deadline||new Date(o.response_deadline)>new Date()))stateCounts[s].open++;if(o.lifecycle_verification_required)stateCounts[s].verification++}
    const system=systemRows?.[0]||{},systemObservedAt=system.updated_at||system.created_at||null;
    const connectorRaw=system.connector_health?.overall||system.connector_health?.status||'UNKNOWN';
    const verifiedPublishers=(publishers||[]).filter((p:any)=>p.verified);
    const publisherEvidence=(publishers||[]).length===0?'EMPTY':verifiedPublishers.length===0?'DISCOVERED':'EVIDENCED';
    const latestAcquisition=enrichedAcquisition[0]||null;
    const health={
      database:{status:'CONNECTED',source:'command-executive-status authoritative database reads',observed_at:generatedAt,detail:'Executive procurement operations queries completed successfully.'},
      command_runtime:{status:activeRuns.length?'RUNNING':'IDLE',source:'command_runs',observed_at:latest(runs,['last_activity_at','updated_at','created_at'])||generatedAt,detail:`${activeRuns.length} active mission(s)`},
      connector_health:{status:evidenceStatus(connectorRaw,systemObservedAt,30),source:'system_status.connector_health',observed_at:systemObservedAt,detail:'Derived from recorded connector evidence; no speculative readiness.'},
      publisher_registry:{status:publisherEvidence,source:'publisher_registry',observed_at:latest(publishers,['last_verified_at','updated_at','created_at']),detail:`${(publishers||[]).length} publisher profile(s); ${verifiedPublishers.length} source-evidenced.`},
      acquisition:{status:latestAcquisition?upper(latestAcquisition.status):'UNEVALUATED',source:'acquisition_runs',observed_at:latest(enrichedAcquisition,['completed_at','started_at','created_at']),detail:latestAcquisition?`Latest run ${latestAcquisition.id}`:'No acquisition execution evidence.'},
      scheduler:{status:(schedules||[]).some((s:any)=>s.enabled)?'ENABLED':'DISABLED',source:'operations_schedules.enabled',observed_at:latest(schedules,['updated_at','created_at'])||generatedAt},
      lifecycle_apply:{status:'GOVERNED',source:'contract_lifecycle_events',observed_at:latest(lifecycle,['evaluated_at','created_at'])||generatedAt,detail:'Lifecycle changes are evidence-backed and historically retained.'}
    };
    const totals={
      active_missions:activeRuns.length,
      missions_requiring_attention:attentionRuns.length,
      publishers:(publishers||[]).length,
      active_procurement_opportunities:count(opportunities,(o:any)=>lower(o.status)==='open'&&(!o.response_deadline||new Date(o.response_deadline)>new Date())),
      canonical_procurement_opportunities:(opportunities||[]).length,
      lifecycle_verification_required:count(opportunities,(o:any)=>Boolean(o.lifecycle_verification_required))
    };
    const inventorySummary={
      total:(opportunities||[]).length,
      open:count(opportunities,(o:any)=>lower(o.status)==='open'&&(!o.response_deadline||new Date(o.response_deadline)>new Date())),
      lifecycle_verification_required:count(opportunities,(o:any)=>Boolean(o.lifecycle_verification_required)),
      contract_dna_complete:count(opportunities,(o:any)=>lower(o.natcorp_contract_dna_status)==='complete')
    };
    return json({
      generated_at:generatedAt,
      system:{...system,operational_status:health.database.status==='CONNECTED'?'OPERATIONAL':'ACTION_REQUIRED'},
      totals,
      runs,
      active_runs:activeRuns,
      attention_runs:attentionRuns,
      states,
      capabilities,
      mission_types:missionTypes,
      schedules,
      schedule_runs:scheduleRuns,
      notifications,
      audit,
      lifecycle_events:lifecycle,
      state_counts:stateCounts,
      health,
      publisher_registry:publishers,
      acquisition:{recent_runs:enrichedAcquisition,recent_raw_records:rawRecords,recent_raw_record_count:(rawRecords||[]).length,failed_recent_runs:count(enrichedAcquisition,(r:any)=>lower(r.status)==='failed'),latest_run:latestAcquisition},
      procurement_inventory:{summary:inventorySummary,recent:opportunities}
    });
  }catch(error){return json({error:error instanceof Error?error.message:String(error)},500)}
});
