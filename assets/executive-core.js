let dashboardPassword=sessionStorage.getItem('apieDashboardPassword')||'';
const NETLIFY_FUNCTIONS={
  'auth':'auth',
  'command-mission-control':'command',
  'command-executive-status':'command-status',
  'command-mission-status':'mission-status',
  'command-stop':'stop',
  'command-resume':'resume',
  'provider-health':'provider-health'
};
function apiHeaders(){return {'Content-Type':'application/json','x-dashboard-password':dashboardPassword};}
async function invoke(name,payload={}){const endpoint=NETLIFY_FUNCTIONS[name];if(!endpoint)throw new Error(`Unsupported Executive gateway operation: ${name}`);const r=await fetch(`/.netlify/functions/${endpoint}`,{method:'POST',headers:apiHeaders(),body:JSON.stringify(payload)});if(r.status===401){dashboardPassword='';sessionStorage.removeItem('apieDashboardPassword');showGate('Authorization required.');throw new Error('Unauthorized');}const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||d.message||`${name} failed (${r.status})`);return d;}
function showGate(err=''){document.getElementById('gateOverlay').classList.add('gate-visible');document.getElementById('gateError').textContent=err;}
function hideGate(){document.getElementById('gateOverlay').classList.remove('gate-visible');window.dispatchEvent(new Event('apie:authenticated'));}
async function authenticatePassword(pw){dashboardPassword=pw;const d=await invoke('auth',{});if(!d?.authenticated)throw new Error('Unauthorized');sessionStorage.setItem('apieDashboardPassword',pw);hideGate();try{const status=await invoke('command-executive-status',{});document.getElementById('systemStatus').textContent=String(status.system?.operational_status||'OPERATIONAL').toUpperCase();}catch(err){console.error('Executive status load after authentication failed:',err);}}
document.getElementById('gateForm').addEventListener('submit',async e=>{e.preventDefault();const pw=document.getElementById('gatePassword').value;if(!pw)return;try{await authenticatePassword(pw);}catch(err){showGate(err.message==='Unauthorized'?'Incorrect password.':'Authentication service unavailable.')}});
window.addEventListener('DOMContentLoaded',async()=>{if(!dashboardPassword)return;try{await authenticatePassword(dashboardPassword);}catch{showGate('Authorization required.')}});
