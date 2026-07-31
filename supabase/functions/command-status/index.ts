import { corsHeaders, db, json, requireDashboardAuth } from '../_shared/command.ts';

const upper=(v:unknown)=>String(v??'').toUpperCase();
const ageMinutes=(v:unknown)=>v?Math.max(0,(Date.now()-new Date(String(v)).getTime())/60000):null;

async function testProvider(provider:string){
  const observed_at=new Date().toISOString();
  if(provider==='manual')return{provider,status:'MANUAL',observed_at,detail:'Operator-controlled provider; no network provider connection is asserted.'};
  if(provider==='openai'){
    const key=Deno.env.get('OPENAI_API_KEY')||'';
    if(!key)return{provider,status:'NOT_CONFIGURED',observed_at};
    const response=await fetch('https://api.openai.com/v1/models',{headers:{Authorization:`Bearer ${key}`}}).catch(()=>null);
    return{provider,status:response?.ok?'CONNECTED':'FAILED',http_status:response?.status||null,observed_at,source:'OpenAI /v1/models'};
  }
  if(provider==='anthropic'){
    const key=Deno.env.get('ANTHROPIC_API_KEY')||'';
    if(!key)return{provider,status:'NOT_CONFIGURED',observed_at};
    const response=await fetch('https://api.anthropic.com/v1/models?limit=1',{headers:{'x-api-key':key,'anthropic-version':'2023-06-01'}}).catch(()=>null);
    return{provider,status:response?.ok?'CONNECTED':'FAILED',http_status:response?.status||null,observed_at,source:'Anthropic /v1/models'};
  }
  return{provider,status:'UNSUPPORTED',observed_at};
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const authError = await requireDashboardAuth(request); if (authError) return authError;
  const payload=await request.json().catch(()=>({}));
  try {
    const runs = await db('command_runs?select=*&order=created_at.desc&limit=20');
    const run = runs[0] || null;
    const jobs = run ? await db(`command_jobs?run_id=eq.${run.id}&select=*&order=sequence_number.asc`) : [];
    const failures = run ? await db(`command_failures?run_id=eq.${run.id}&select=*&order=created_at.desc&limit=50`) : [];
    const rows = run ? await db(`command_metrics?run_id=eq.${run.id}&select=metric_name,metric_value,metric_text,recorded_at&order=recorded_at.desc`) : [];
    const metrics:any = {};
    for (const row of rows.reverse()) metrics[row.metric_name] = row.metric_value ?? row.metric_text;
    const [statusRows,registryRows]=await Promise.all([
      db('system_status?singleton=eq.true&select=*'),
      db('publisher_registry?select=id,verified,last_verified_at,updated_at')
    ]);
    const status = statusRows[0] || {};
    const statusObservedAt=status.updated_at||status.created_at||null;
    const statusAge=ageMinutes(statusObservedAt);
    const rawConnector=upper(status.connector_health?.overall||status.connector_health?.status||'UNKNOWN');
    const connectorStatus=statusAge!==null&&statusAge>30&&['HEALTHY','CONNECTED','OPERATIONAL','READY'].includes(rawConnector)?'STALE':rawConnector;
    const verified=registryRows.filter((r:any)=>r.verified);
    const freshVerified=verified.filter((r:any)=>{const age=ageMinutes(r.last_verified_at);return age!==null&&age<=60*24*30;});
    const registryStatus=registryRows.length===0?'EMPTY':verified.length===0?'UNEVALUATED':freshVerified.length===0?'STALE':'EVIDENCED';
    const observedAt=new Date().toISOString();
    const health={
      database:{status:'CONNECTED',source:'command-status server-side PostgREST reads',observed_at:observedAt},
      connector:{status:connectorStatus,source:'system_status.connector_health',observed_at:statusObservedAt},
      publisher_registry:{status:registryStatus,source:'publisher_registry.verified + last_verified_at',observed_at:verified.map((r:any)=>r.last_verified_at).filter(Boolean).sort().at(-1)||null},
      command_runtime:{status:jobs.some((j:any)=>['running','retrying'].includes(j.status))?'RUNNING':'IDLE',source:'command_jobs',observed_at:run?.updated_at||run?.created_at||observedAt}
    };
    metrics.system_status = status.operational_status;
    metrics.connector_health = connectorStatus;
    metrics.running_jobs = jobs.filter((job:any) => ['running','retrying'].includes(job.status)).length;
    metrics.completed_jobs = jobs.filter((job:any) => job.status === 'completed').length;
    metrics.failed_jobs = jobs.filter((job:any) => job.status === 'failed').length;
    metrics.retry_count = jobs.reduce((sum:number, job:any) => sum + Math.max(0, (job.attempt_count || 0) - 1), 0);
    metrics.queue_depth = jobs.filter((job:any) => job.status === 'pending').length;

    let aadp_process:any[] = [], aadp_action_needed:any[] = [], aadp_publisher_run:any = null, aadp_recommendations:any[] = [];
    if (run?.publisher_assignment_id) {
      aadp_process = await db(`aadp_process_stage_projection?command_run_id=eq.${run.id}&select=*&order=updated_at.asc`);
      aadp_action_needed = await db(`aadp_action_needed_alerts?command_run_id=eq.${run.id}&status=eq.OPEN&select=*&order=created_at.asc`);
      const acquisitionRuns = await db(`acquisition_runs?command_run_id=eq.${run.id}&select=*,publisher_assignments(publisher_name,publisher_registry(state_code))&order=created_at.desc&limit=1`);
      const acquisition = acquisitionRuns?.[0] || null;
      aadp_publisher_run = acquisition ? {
        ...acquisition,
        publisher_name: acquisition.publisher_assignments?.publisher_name,
        state_code: acquisition.publisher_assignments?.publisher_registry?.state_code
      } : null;
      if (acquisition) {
        const reviews = await db(`aoie_batch_reviews?acquisition_run_id=eq.${acquisition.id}&select=id`);
        if (reviews?.[0]) aadp_recommendations = await db(`aoie_change_recommendations?batch_review_id=eq.${reviews[0].id}&select=*&order=created_at.asc`);
      }
    }

    const provider_test=payload?.provider_test?await testProvider(String(payload.provider_test)):null;
    return json({ run, jobs, metrics, failures, history: runs, health, provider_test, aadp_process, aadp_action_needed, aadp_publisher_run, aadp_recommendations });
  } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 500); }
});
