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
    const publishers=await db(`publisher_registry?state_code=eq.${encodeURIComponent(stateCode)}&select=id,publisher_name,state_code,organization_type,official_website,procurement_website,acquisition_method,search_endpoint,verified,access_status,last_verified_at&order=publisher_name.asc`);
    return json({
      state_code:stateCode,
      publishers:(publishers||[]).filter((p:any)=>txt(p.publisher_name)).map((p:any)=>({
        publisher_id:p.id,
        publisher_name:p.publisher_name,
        organization_type:p.organization_type,
        official_website:p.official_website,
        procurement_website:p.procurement_website,
        acquisition_method:p.acquisition_method||'AUTO_RESOLVE',
        search_endpoint:p.search_endpoint||p.procurement_website||p.official_website||null,
        source_verified:p.verified===true,
        access_status:p.access_status||'DISCOVERED',
        last_verified_at:p.last_verified_at,
        selectable:Boolean(p.search_endpoint||p.procurement_website||p.official_website)
      }))
    });
  }catch(error){return json({error:error instanceof Error?error.message:String(error)},500);}
});
