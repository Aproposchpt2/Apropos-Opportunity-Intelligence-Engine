const baseReadiness = readiness;
const baseRenderReadiness = renderReadiness;

const DISCOVERY_GOVERNANCE_IDS = [
  'governanceOfficialSources',
  'governanceDuplicateDetection',
  'governanceCandidateStaging',
  'governanceHumanApproval'
];

function isDiscoveryMission(){return $('missionType').value==='Discovery';}
function selectedDiscoveryTypes(){return Array.from($('discoveryOrganizationTypes')?.selectedOptions||[]).map(option=>option.value).filter(Boolean);}
function discoveryGovernanceAvailable(){return DISCOVERY_GOVERNANCE_IDS.every(id=>Boolean($(id)?.checked));}
function discoveryScopeConfigured(){return Boolean($('discoveryState')?.value&&$('discoveryScope')?.value&&selectedDiscoveryTypes().length);}
function setReadinessCheckLabel(key,label){const node=document.querySelector(`[data-check="${key}"]`);if(node)node.textContent=label;}

function applyMissionTypeLayout(){
  const discovery=isDiscoveryMission();
  $('knownPublisherConfiguration').hidden=discovery;
  $('knownPublisherQueue').hidden=discovery;
  $('discoveryScopeConfiguration').hidden=!discovery;
  $('publisherConfigKicker').textContent=discovery?'DISCOVERY SCOPE CONFIGURATION':'PUBLISHER CONFIGURATION';
  $('publisherConfigTitle').textContent=discovery?'Define the publisher discovery boundary':'Approve the mission acquisition batch';
  $('beginButton').textContent=discovery?'BEGIN STATE DISCOVERY':'BEGIN DAILY OPERATIONS';
  if(discovery){
    setReadinessCheckLabel('provider','Provider Connected');
    setReadinessCheckLabel('publishers','Target State Selected');
    setReadinessCheckLabel('connectors','Discovery Scope Defined');
    setReadinessCheckLabel('database','Database Connected');
    setReadinessCheckLabel('queue','Publisher Types Selected');
    setReadinessCheckLabel('estimate','Discovery Governance Enforced');
    setReadinessCheckLabel('approval','Mission Configuration Complete');
  }else{
    setReadinessCheckLabel('provider','Provider Connected');
    setReadinessCheckLabel('publishers','Publishers Selected');
    setReadinessCheckLabel('connectors','Connectors Healthy');
    setReadinessCheckLabel('database','Database Connected');
    setReadinessCheckLabel('queue','Queue Built');
    setReadinessCheckLabel('estimate','Runtime Estimated');
    setReadinessCheckLabel('approval','Executive Approval Ready');
  }
}

readiness=function(){
  if(!isDiscoveryMission())return baseReadiness();
  const types=selectedDiscoveryTypes();
  const checks={
    provider:state.providerConnected,
    publishers:Boolean($('discoveryState').value),
    connectors:Boolean($('discoveryScope').value),
    database:Boolean(CONFIG.supabaseUrl&&CONFIG.anonKey),
    queue:types.length>0,
    estimate:discoveryGovernanceAvailable(),
    approval:missionConfigValid()
  };
  const passed=Object.values(checks).filter(Boolean).length;
  return{checks,score:Math.round(passed/7*100),ready:Object.values(checks).every(Boolean)};
};

renderReadiness=function(){
  applyMissionTypeLayout();
  if(!isDiscoveryMission())return baseRenderReadiness();
  const r=readiness();
  const types=selectedDiscoveryTypes();
  const scopeComplete=discoveryScopeConfigured();
  $('missionConfigStatus').textContent=missionConfigValid()?'✓ Complete':'Required';
  $('providerConfigStatus').textContent=state.providerConnected?'✓ Connected':'Required';
  $('publisherConfigStatus').textContent=scopeComplete?'✓ Discovery Scope Complete':'Required';
  $('estimateStatus').textContent=discoveryGovernanceAvailable()?'✓ Discovery Governance Ready':'Pending';
  $('readinessStatus').textContent=r.ready?'MISSION READY':'NO';
  $('preflightState').textContent=r.ready?'AUTHORIZED':'INCOMPLETE';
  $('preflightState').className=`status-pill ${r.ready?'status-healthy':'status-idle'}`;
  $('missionReadinessValue').textContent=`${r.score}%`;
  $('missionReadinessState').textContent=r.ready?'READY':'NOT READY';
  $('missionReadinessBar').style.width=`${r.score}%`;
  $('readinessDecision').textContent=r.ready?'Discovery mission validated. State discovery may begin.':'Complete the Discovery-specific pre-flight gates before launch.';
  $('missionPosture').textContent=r.ready?'Ready':'Standby';
  $('missionConfidence').textContent=`${Math.min(97,r.score)}%`;
  document.querySelectorAll('[data-check]').forEach(node=>{const ok=r.checks[node.dataset.check];node.classList.toggle('passed',ok);node.textContent=`${ok?'✓':'○'} ${node.textContent.replace(/^[✓○]\s*/,'')}`;});
  $('beginButton').disabled=!r.ready||Boolean(state.run&&['running','retrying'].includes(state.run.status));
  $('summaryMissionName').textContent=$('missionName').value||'—';
  $('summaryProvider').textContent=PROVIDERS[state.provider]?.name||'—';
  $('summaryPublishers').textContent=types.length?`${types.length} publisher types`:'0 publisher types';
  $('summaryRuntime').textContent='Discovery governed';
  $('summaryOpportunities').textContent='Pending discovery';
  $('summaryReleases').textContent='Human review required';
  $('summaryOperator').textContent=$('missionOperator').value||'—';
  $('summaryTimestamp').textContent=new Date().toLocaleString();
  $('connectorHealth').textContent='Not Required';
  $('registryHealth').textContent='Duplicate Check Ready';
  $('databaseStatus').textContent=CONFIG.anonKey?'Connected':'Not Configured';
  $('overallSystemHealth').textContent=r.ready?'Ready':'Operational';
};

$('missionType').addEventListener('change',()=>{applyMissionTypeLayout();render();});
['discoveryState','discoveryScope','discoveryOrganizationTypes'].forEach(id=>$(id).addEventListener('change',render));
$('selectAllDiscoveryTypes').addEventListener('click',()=>{Array.from($('discoveryOrganizationTypes').options).forEach(option=>{option.selected=true;});render();});

$('beginButton').addEventListener('click',event=>{
  if(!isDiscoveryMission())return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const r=readiness();
  if(!r.ready)return;
  command('command-aadp-publisher-discovery','Creating official Discovery Mission and beginning state publisher discovery…',{
    action:'START',
    state_code:$('discoveryState').value,
    mission_name:$('missionName').value.trim(),
    discovery_scope:$('discoveryScope').value,
    organization_types:selectedDiscoveryTypes(),
    provider:state.provider,
    operator:$('missionOperator').value.trim(),
    notes:$('missionNotes').value.trim(),
    governance:{
      official_source_research_required:true,
      duplicate_registry_detection_required:true,
      candidate_record_creation_enabled:true,
      human_review_before_registry_admission_required:true
    }
  });
},{capture:true});

applyMissionTypeLayout();
render();
