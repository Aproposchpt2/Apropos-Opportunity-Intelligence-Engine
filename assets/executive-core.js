let dashboardPassword=sessionStorage.getItem('apieDashboardPassword')||'';
let statusTransportFailures=0;
let statusCircuitUntil=0;
const NETLIFY_FUNCTIONS={
  auth:'auth',
  'provider-health':'provider-health',
  'command-mission-control':'command-mission-control',
  'command-acquisition-mission':'command-acquisition-mission',
  'command-automated-task':'command-automated-task',
  'command-executive-status':'command-executive-status',
  'command-dashboard-inventory':'command-dashboard-inventory',
  'command-publisher-discovery-status':'command-publisher-discovery-status',
  'command-county-options':'command-county-options',
  'command-publisher-options':'command-publisher-options',
  'command-mission-status':'mission-status',
  'command-aadp-publisher-candidate-review':'candidate-review',
  'command-stop':'stop',
  'command-resume':'resume'
};
function dashboardHeaders(){return {'Content-Type':'application/json','x-dashboard-password':dashboardPassword}}
function statusCircuitOpen(name){return name==='command-executive-status'&&Date.now()<statusCircuitUntil}
function recordTransportSuccess(name){if(name==='command-executive-status'){statusTransportFailures=0;statusCircuitUntil=0}}
function recordTransportFailure(name){if(name!=='command-executive-status')return;statusTransportFailures++;statusCircuitUntil=Date.now()+Math.min(60000,15000*Math.max(1,statusTransportFailures))}
async function invoke(name,payload={}){
  if(statusCircuitOpen(name))throw new Error('Executive status temporarily paused after transport failure');
  const endpoint=NETLIFY_FUNCTIONS[name];
  if(!endpoint)throw new Error(`Unsupported Executive operation: ${name}`);
  let response;
  try{
    response=await fetch(`/.netlify/functions/${endpoint}`,{
      method:'POST',
      headers:dashboardHeaders(),
      body:JSON.stringify(payload),
      signal:AbortSignal.timeout(30000)
    });
  }catch(error){
    recordTransportFailure(name);
    throw new Error(`${name} transport unavailable${error?.name==='TimeoutError'?' (timeout)':''}`);
  }
  if(response.status===401){dashboardPassword='';sessionStorage.removeItem('apieDashboardPassword');showGate('Authorization required.');throw new Error('Unauthorized')}
  const data=await response.json().catch(()=>({}));
  if(!response.ok){if(response.status>=500)recordTransportFailure(name);throw new Error(data.error||data.message||`${name} failed (${response.status})`)}
  recordTransportSuccess(name);
  return data;
}
function showGate(error=''){document.getElementById('gateOverlay').classList.add('gate-visible');document.getElementById('gateError').textContent=error}
function hideGate(){document.getElementById('gateOverlay').classList.remove('gate-visible');window.dispatchEvent(new Event('apie:authenticated'))}
async function authenticatePassword(password){dashboardPassword=password;const data=await invoke('auth',{});if(!data?.authenticated)throw new Error('Unauthorized');sessionStorage.setItem('apieDashboardPassword',password);hideGate();try{const status=await invoke('command-executive-status',{});const systemStatus=document.getElementById('systemStatus');if(systemStatus)systemStatus.textContent=String(status.system?.operational_status||'OPERATIONAL').toUpperCase()}catch(error){console.error('Executive status load after authentication failed:',error)}}
document.getElementById('gateForm').addEventListener('submit',async event=>{event.preventDefault();const password=document.getElementById('gatePassword').value;if(!password)return;try{await authenticatePassword(password)}catch(error){showGate(error.message==='Unauthorized'?'Incorrect password.':'Authentication service unavailable.')}});
window.addEventListener('DOMContentLoaded',async()=>{if(!dashboardPassword)return;try{await authenticatePassword(dashboardPassword)}catch{showGate('Authorization required.')}});
