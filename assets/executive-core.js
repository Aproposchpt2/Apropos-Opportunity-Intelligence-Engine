let dashboardSessionToken=localStorage.getItem('apieExecutiveSession')||'';
let dashboardOperatorEmail=localStorage.getItem('apieExecutiveEmail')||'';
let recoveryAccessToken='';
let statusTransportFailures=0;
let statusCircuitUntil=0;
let authenticatedDispatchComplete=false;

const NETLIFY_FUNCTIONS={
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

const EXECUTIVE_AUTH_ENDPOINT='/.netlify/functions/executive-auth';
const configuredOperatorEmail=String(window.AP_COMMAND_CONFIG?.operatorEmail||'jmitchell@aproposgroupllc.com');

function installAuthInterface(){
  if(!document.querySelector('link[href="assets/executive-auth.css"]')){
    const stylesheet=document.createElement('link');
    stylesheet.rel='stylesheet';
    stylesheet.href='assets/executive-auth.css';
    document.head.appendChild(stylesheet);
  }

  const overlay=document.getElementById('gateOverlay');
  overlay.innerHTML=`
    <div class="ecc-auth-shell" role="dialog" aria-modal="true" aria-labelledby="gateTitle">
      <section class="gate-panel">
        <div class="ecc-auth-mark">A</div>
        <p class="section-kicker">APROPOS GROUP LLC</p>
        <h2 id="gateTitle" class="gate-title">Executive Command Center</h2>
        <p id="gateCopy" class="gate-copy">Secure access for the authorized APROPOS operator.</p>

        <div id="gateLoginView" class="ecc-auth-view">
          <form id="gateForm" class="gate-form">
            <label>Email<input id="gateEmail" type="email" autocomplete="username" placeholder="operator@aproposgroupllc.com" class="gate-input" required></label>
            <label>Password<input id="gatePassword" type="password" autocomplete="current-password" placeholder="Password" class="gate-input" required></label>
            <button class="primary-action gate-submit" type="submit">Enter Command Center</button>
            <button id="gateForgot" class="ecc-auth-link" type="button">Forgot password?</button>
          </form>
        </div>

        <div id="gateForgotView" class="ecc-auth-view" hidden>
          <form id="gateForgotForm" class="gate-form">
            <label>Email<input id="gateForgotEmail" type="email" autocomplete="email" placeholder="operator@aproposgroupllc.com" class="gate-input" required></label>
            <button class="primary-action gate-submit" type="submit">Send Recovery Email</button>
            <button id="gateForgotBack" class="ecc-auth-link" type="button">Return to sign in</button>
          </form>
        </div>

        <div id="gateResetView" class="ecc-auth-view" hidden>
          <form id="gateResetForm" class="gate-form">
            <label>New Password<input id="gateNewPassword" type="password" autocomplete="new-password" minlength="12" placeholder="At least 12 characters" class="gate-input" required></label>
            <label>Confirm New Password<input id="gateConfirmPassword" type="password" autocomplete="new-password" minlength="12" placeholder="Confirm new password" class="gate-input" required></label>
            <button class="primary-action gate-submit" type="submit">Update Password</button>
            <button id="gateResetBack" class="ecc-auth-link" type="button">Return to sign in</button>
          </form>
        </div>

        <p id="gateError" class="gate-error" role="alert"></p>
        <p id="gateSuccess" class="gate-success" role="status"></p>
        <div class="ecc-auth-security">Authorized operator access only</div>
      </section>

      <aside class="ecc-auth-aside">
        <p class="section-kicker">EXECUTIVE MISSION CONTROL</p>
        <h3>Command procurement operations securely.</h3>
        <p>Email authentication, session control, and account recovery are managed through the APROPOS Supabase identity service.</p>
      </aside>
    </div>`;

  const footer=document.querySelector('.ecc-sidebar-footer');
  if(footer){
    footer.innerHTML=`
      <small>AUTHORIZED OPERATOR</small>
      <strong id="eccOperatorEmail">Session not established</strong>
      <button id="eccSignOut" class="ecc-sign-out" type="button">Sign out</button>
      <span>Executive Mission Control · Internal Controlled System</span>`;
  }
}

installAuthInterface();

function dashboardHeaders(){
  return {
    'Content-Type':'application/json',
    ...(dashboardSessionToken?{Authorization:`Bearer ${dashboardSessionToken}`}:{})
  };
}

function statusCircuitOpen(name){return name==='command-executive-status'&&Date.now()<statusCircuitUntil}
function recordTransportSuccess(name){if(name==='command-executive-status'){statusTransportFailures=0;statusCircuitUntil=0}}
function recordTransportFailure(name){if(name!=='command-executive-status')return;statusTransportFailures++;statusCircuitUntil=Date.now()+Math.min(60000,15000*Math.max(1,statusTransportFailures))}

function clearExecutiveSession(){
  dashboardSessionToken='';
  dashboardOperatorEmail='';
  localStorage.removeItem('apieExecutiveSession');
  localStorage.removeItem('apieExecutiveEmail');
}

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

  if(response.status===401){
    clearExecutiveSession();
    showGate('Authorization required.');
    throw new Error('Unauthorized');
  }

  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    if(response.status>=500)recordTransportFailure(name);
    throw new Error(data.error||data.message||`${name} failed (${response.status})`);
  }

  recordTransportSuccess(name);
  return data;
}

function authView(id){return document.getElementById(id)}

function setAuthMode(mode,{error='',success=''}={}){
  const overlay=authView('gateOverlay');
  const login=authView('gateLoginView');
  const forgot=authView('gateForgotView');
  const reset=authView('gateResetView');
  const title=authView('gateTitle');
  const copy=authView('gateCopy');
  const errorNode=authView('gateError');
  const successNode=authView('gateSuccess');

  overlay.classList.add('gate-visible');
  login.hidden=mode!=='login';
  forgot.hidden=mode!=='forgot';
  reset.hidden=mode!=='reset';
  errorNode.textContent=error;
  successNode.textContent=success;

  if(mode==='login'){
    title.textContent='Executive Command Center';
    copy.textContent='Secure access for the authorized APROPOS operator.';
    authView('gateEmail').value=authView('gateEmail').value||configuredOperatorEmail;
    setTimeout(()=>authView('gatePassword')?.focus(),0);
  }else if(mode==='forgot'){
    title.textContent='Reset your password';
    copy.textContent='Request a secure recovery link for the authorized operator account.';
    authView('gateForgotEmail').value=authView('gateForgotEmail').value||authView('gateEmail').value||configuredOperatorEmail;
    setTimeout(()=>authView('gateForgotEmail')?.focus(),0);
  }else{
    title.textContent='Choose a new password';
    copy.textContent='Complete recovery for the authorized Executive Command Center account.';
    setTimeout(()=>authView('gateNewPassword')?.focus(),0);
  }
}

function showGate(error=''){setAuthMode('login',{error})}

function hideGate(email){
  const overlay=authView('gateOverlay');
  dashboardOperatorEmail=String(email||dashboardOperatorEmail||configuredOperatorEmail);
  localStorage.setItem('apieExecutiveEmail',dashboardOperatorEmail);
  authView('eccOperatorEmail').textContent=dashboardOperatorEmail;
  overlay.classList.remove('gate-visible');

  if(!authenticatedDispatchComplete){
    authenticatedDispatchComplete=true;
    window.dispatchEvent(new Event('apie:authenticated'));
  }
}

async function authRequest(action,payload={},token=''){
  const response=await fetch(EXECUTIVE_AUTH_ENDPOINT,{
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      ...(token?{Authorization:`Bearer ${token}`}:{})
    },
    body:JSON.stringify({action,...payload}),
    cache:'no-store',
    signal:AbortSignal.timeout(30000)
  });

  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||data.message||`Authentication failed (${response.status})`);
  return data;
}

async function login(email,password){
  const data=await authRequest('login',{email,password});
  dashboardSessionToken=data.dashboard_token;
  dashboardOperatorEmail=data.email;
  localStorage.setItem('apieExecutiveSession',dashboardSessionToken);
  localStorage.setItem('apieExecutiveEmail',dashboardOperatorEmail);
  hideGate(data.email);
}

async function restoreSession(){
  if(!dashboardSessionToken){showGate();return}
  try{
    const data=await authRequest('session',{},dashboardSessionToken);
    hideGate(data.email);
  }catch{
    clearExecutiveSession();
    showGate('Your session expired. Sign in again.');
  }
}

function recoveryFromLocation(){
  const hash=new URLSearchParams(location.hash.replace(/^#/,''));
  const query=new URLSearchParams(location.search);
  const type=hash.get('type')||query.get('type');
  const access=hash.get('access_token')||query.get('access_token');
  if(type==='recovery'&&access)return access;
  return '';
}

function returnToLogin(message=''){
  recoveryAccessToken='';
  history.replaceState({},'', '/');
  authView('gateNewPassword').value='';
  authView('gateConfirmPassword').value='';
  setAuthMode('login',{success:message});
}

document.getElementById('gateForm').addEventListener('submit',async event=>{
  event.preventDefault();
  setAuthMode('login');
  const email=authView('gateEmail').value.trim();
  const password=authView('gatePassword').value;
  if(!email||!password){setAuthMode('login',{error:'Email and password are required.'});return}
  try{await login(email,password)}
  catch(error){setAuthMode('login',{error:error.message})}
});

authView('gateForgot').addEventListener('click',()=>setAuthMode('forgot'));

authView('gateForgotBack').addEventListener('click',()=>setAuthMode('login'));

authView('gateForgotForm').addEventListener('submit',async event=>{
  event.preventDefault();
  const email=authView('gateForgotEmail').value.trim();
  if(!email){setAuthMode('forgot',{error:'Enter the operator email.'});return}
  try{
    const data=await authRequest('reset',{email});
    setAuthMode('forgot',{success:data.message});
  }catch(error){
    setAuthMode('forgot',{error:error.message});
  }
});

authView('gateResetBack').addEventListener('click',()=>returnToLogin());

authView('gateResetForm').addEventListener('submit',async event=>{
  event.preventDefault();
  const password=authView('gateNewPassword').value;
  const confirm=authView('gateConfirmPassword').value;

  if(!recoveryAccessToken){setAuthMode('reset',{error:'This recovery link is invalid or expired.'});return}
  if(password.length<12){setAuthMode('reset',{error:'Use at least 12 characters.'});return}
  if(password!==confirm){setAuthMode('reset',{error:'The passwords do not match.'});return}

  try{
    const data=await authRequest('update-password',{password},recoveryAccessToken);
    clearExecutiveSession();
    returnToLogin(data.message||'Password updated. Sign in with the new password.');
  }catch(error){
    setAuthMode('reset',{error:error.message});
  }
});

authView('eccSignOut').addEventListener('click',()=>{
  clearExecutiveSession();
  location.reload();
});

window.addEventListener('DOMContentLoaded',async()=>{
  recoveryAccessToken=recoveryFromLocation();
  if(location.pathname==='/reset-password'||recoveryAccessToken){
    setAuthMode('reset',{
      error:recoveryAccessToken?'':'This recovery link is invalid or expired. Request a new link.'
    });
    return;
  }
  await restoreSession();
});
