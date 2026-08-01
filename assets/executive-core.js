let dashboardPassword=sessionStorage.getItem('apieDashboardPassword')||'';
let statusTransportFailures=0;
let statusCircuitUntil=0;
const NETLIFY_FUNCTIONS={
  auth:'auth',
  'provider-health':'provider-health'
};
const EDGE_FUNCTIONS=new Set([
  'command-mission-control',
  'command-acquisition-mission',
  'command-executive-status',
  'command-publisher-discovery-status',
  'command-publisher-options',
  'command-mission-status',
  'command-aadp-publisher-candidate-review',
  'command-stop',
  'command-resume'
]);
function runtimeConfig(){return window.AP_COMMAND_CONFIG||{};}
function dashboardHeaders(){return {'Content-Type':'application/json','x-dashboard-password':dashboardPassword};}
function edgeHeaders(){const cfg=runtimeConfig();return {...dashboardHeaders(),apikey:cfg.anonKey||'',Authorization:`Bearer ${cfg.anonKey||''}`};}
function statusCircuitOpen(name){return name==='command-executive-status'&&Date.now()<statusCircuitUntil;}
function recordTransportSuccess(name){if(name==='command-executive-status'){statusTransportFailures=0;statusCircuitUntil=0;}}
function recordTransportFailure(name){if(name!=='command-executive-status')return;statusTransportFailures++;const delay=Math.min(60000,15000*Math.max(1,statusTransportFailures));statusCircuitUntil=Date.now()+delay;}
async function invoke(name,payload={}){
  if(statusCircuitOpen(name))throw new Error('command-executive-status temporarily paused after transport failure');
  let url,headers;
  if(EDGE_FUNCTIONS.has(name)){
    const cfg=runtimeConfig();
    if(!cfg.supabaseUrl||!cfg.anonKey)throw new Error('Executive runtime configuration unavailable.');
    url=`${cfg.supabaseUrl}/functions/v1/${name}`;
    headers=edgeHeaders();
  }else{
    const endpoint=NETLIFY_FUNCTIONS[name];
    if(!endpoint)throw new Error(`Unsupported Executive operation: ${name}`);
    url=`/.netlify/functions/${endpoint}`;
    headers=dashboardHeaders();
  }
  let r;
  try{
    r=await fetch(url,{method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
  }catch(err){
    recordTransportFailure(name);
    throw new Error(`${name} transport unavailable${err?.name==='TimeoutError'?' (timeout)':''}`);
  }
  if(r.status===401){dashboardPassword='';sessionStorage.removeItem('apieDashboardPassword');showGate('Authorization required.');throw new Error('Unauthorized');}
  const d=await r.json().catch(()=>({}));
  if(!r.ok){if(r.status>=500)recordTransportFailure(name);throw new Error(d.error||d.message||`${name} failed (${r.status})`);}
  recordTransportSuccess(name);
  return d;
}
function showGate(err=''){document.getElementById('gateOverlay').classList.add('gate-visible');document.getElementById('gateError').textContent=err;}
function hideGate(){document.getElementById('gateOverlay').classList.remove('gate-visible');window.dispatchEvent(new Event('apie:authenticated'));}
async function authenticatePassword(pw){dashboardPassword=pw;const d=await invoke('auth',{});if(!d?.authenticated)throw new Error('Unauthorized');sessionStorage.setItem('apieDashboardPassword',pw);hideGate();try{const status=await invoke('command-executive-status',{});document.getElementById('systemStatus').textContent=String(status.system?.operational_status||'OPERATIONAL').toUpperCase();}catch(err){console.error('Executive status load after authentication failed:',err);}}
document.getElementById('gateForm').addEventListener('submit',async e=>{e.preventDefault();const pw=document.getElementById('gatePassword').value;if(!pw)return;try{await authenticatePassword(pw);}catch(err){showGate(err.message==='Unauthorized'?'Incorrect password.':'Authentication service unavailable.')}});
window.addEventListener('DOMContentLoaded',async()=>{if(!dashboardPassword)return;try{await authenticatePassword(dashboardPassword);}catch{showGate('Authorization required.')}});
