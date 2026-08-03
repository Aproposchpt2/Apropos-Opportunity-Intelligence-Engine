import { response, parseBody, requireDashboardAuth, db } from './_shared/native-runtime.js';
import { extractAcquisitionRun } from './_shared/detail-extraction-engine.js';

export const handler=async event=>{
  if(event?.httpMethod!=='POST')return response(405,{error:'Method not allowed'});
  if(!requireDashboardAuth(event))return response(401,{error:'Unauthorized'});
  try{
    const body=parseBody(event);const acquisitionRunId=String(body.acquisition_run_id||'').trim();
    if(!acquisitionRunId)return response(400,{error:'acquisition_run_id is required.'});
    const extraction=await extractAcquisitionRun({db,acquisitionRunId,concurrency:Number(body.concurrency||5)});
    const qualification=await db('rpc/aadp_route_pending_raw_records',{method:'POST',body:JSON.stringify({p_batch_size:500,p_acquisition_run_id:acquisitionRunId})})||{};
    return response(200,{ok:true,acquisition_run_id:acquisitionRunId,extraction,qualification});
  }catch(error){return response(500,{error:error instanceof Error?error.message:String(error)})}
};
