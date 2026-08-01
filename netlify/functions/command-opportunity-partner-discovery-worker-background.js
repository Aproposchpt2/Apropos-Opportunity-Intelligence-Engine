import { response, requireDashboardAuth } from './_shared/native-runtime.js';
import { executeResearchDiscovery } from './_shared/research-discovery-worker.js';

export const handler=async event=>{
  if(event?.httpMethod!=='POST')return response(405,{error:'Method not allowed'});
  if(!requireDashboardAuth(event))return response(401,{error:'Unauthorized'});
  return executeResearchDiscovery({event,missionType:'OPPORTUNITY_PARTNER_DISCOVERY'});
};
