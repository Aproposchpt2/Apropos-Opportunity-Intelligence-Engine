import {corsHeaders,db,json,requireDashboardAuth} from '../_shared/command.ts';
const lower=(v:unknown)=>String(v??'').toLowerCase();
Deno.serve(async request=>{
  if(request.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});
  const authError=await requireDashboardAuth(request);if(authError)return authError;
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  try{
    const [runs,candidates]=await Promise.all([
      db('publisher_discovery_runs?select=id,command_run_id,state_code,status,current_stage,official_sources_identified,publishers_presented,publishers_approved,evidence,started_at,completed_at,created_at,updated_at,mission_name&order=updated_at.desc&limit=50'),
      db('publisher_discovery_candidates?select=id,discovery_run_id,publisher_name,state_code,organization_type,official_website,procurement_website,acquisition_method,official_sources,official_source_verified,duplicate_status,review_status,review_notes,reviewed_at,admitted_publisher_id,created_at,updated_at&order=updated_at.desc&limit=200')
    ]);
    const normalizedRuns=(runs||[]).map((r:any)=>({...r,mission_type_key:'PUBLISHER_DISCOVERY',result_count:Number(r.publishers_presented||0)}));
    const normalizedCandidates=(candidates||[]).map((c:any)=>({...c,organization_name:c.publisher_name,source_verified:c.official_source_verified===true}));
    return json({
      generated_at:new Date().toISOString(),
      source:'publisher_discovery_runs + publisher_discovery_candidates',
      runs:normalizedRuns,
      candidates:normalizedCandidates,
      pending_review:normalizedCandidates.filter((c:any)=>lower(c.review_status)==='pending_review').length,
      research_required:normalizedCandidates.filter((c:any)=>lower(c.review_status)==='research_required').length,
      source_verified:normalizedCandidates.filter((c:any)=>c.source_verified).length
    });
  }catch(error){return json({error:error instanceof Error?error.message:String(error)},500)}
});
