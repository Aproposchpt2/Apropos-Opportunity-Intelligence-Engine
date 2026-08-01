import { corsHeaders, db, json, parseBody, requireDashboardAuth } from '../_shared/command.ts';

type J=Record<string,unknown>;
const rec=(v:unknown):J=>v&&typeof v==='object'&&!Array.isArray(v)?v as J:{};
const txt=(v:unknown)=>typeof v==='string'?v.trim():v==null?'':String(v);

Deno.serve(async request=>{
  if(request.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});
  const authError=await requireDashboardAuth(request);if(authError)return authError;
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  try{
    const body=rec(await parseBody(request));
    const stateCode=txt(body.state_code).toUpperCase();
    if(!/^[A-Z]{2}$/.test(stateCode))return json({error:'Valid state_code is required.'},400);
    const publishers=await db(`publisher_registry?state_code=eq.${encodeURIComponent(stateCode)}&verified=eq.true&access_status=eq.APPROVED_FOR_REGISTRY&select=id,publisher_name,state_code,organization_type,acquisition_method,search_endpoint,verified,access_status&order=publisher_name.asc`);
    const assignments=await db('publisher_assignments?select=id,publisher_id,publisher_name,status,acquisition_method,search_endpoint,updated_at');
    const byPublisher=new Map((assignments||[]).map((a:any)=>[txt(a.publisher_id),a]));
    return json({state_code:stateCode,publishers:(publishers||[]).map((p:any)=>{const a=byPublisher.get(txt(p.id));return {publisher_id:p.id,publisher_name:p.publisher_name,organization_type:p.organization_type,registry_verified:p.verified===true,registry_status:p.access_status,assignment_id:a?.id||null,assignment_status:a?.status||'ONBOARDING_REQUIRED',acquisition_method:a?.acquisition_method||p.acquisition_method||null,search_endpoint:a?.search_endpoint||p.search_endpoint||null,selectable:txt(a?.status).toUpperCase()==='READY'};})});
  }catch(error){return json({error:error instanceof Error?error.message:String(error)},500);}
});
