let dashboardPassword=sessionStorage.getItem('apieDashboardPassword')||'';
const NETLIFY_FUNCTIONS={
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
document.getElementById('gateForm').addEventListener('submit',async e=>{e.preventDefault();const pw=document.getElementById('gatePassword').value;if(!pw)return;dashboardPassword=pw;try{const d=await invoke('command-executive-status',{});sessionStorage.setItem('apieDashboardPassword',pw);document.getElementById('systemStatus').textContent=String(d.system?.operational_status||'OPERATIONAL').toUpperCase();hideGate();}catch(err){showGate('Incorrect password or command service unavailable.')}});
window.addEventListener('DOMContentLoaded',async()=>{if(!dashboardPassword)return;try{const d=await invoke('command-executive-status',{});document.getElementById('systemStatus').textContent=String(d.system?.operational_status||'OPERATIONAL').toUpperCase();hideGate();}catch{showGate('Authorization required.')}});
