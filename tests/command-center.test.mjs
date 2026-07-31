import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const text=async path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('root is the internal Executive Command Center',async()=>{
  const html=await text('index.html');
  for(const label of [
    'APROPOS INTELLIGENCE OPERATING SYSTEM','Executive Command Center','State Operations Context',
    'Authorize & Execute','Active Mission Monitors','OTF OPERATIONS','Capability Readiness',
    'Publisher Discovery','Publisher Registry','Acquisition Operations','Procurement Inventory','NAT-CORP Delivery',
    'Recurring Automation','Action Required','Lifecycle Control','Evidence-Backed Infrastructure Status',
    'Audit / History','Deliverables / Results','Operational Notifications'
  ]) assert.match(html,new RegExp(label,'i'));
  assert.match(html,/Internal APROPOS operations/i);
  assert.match(html,/id="gatePassword"/);
  assert.match(html,/noindex,nofollow/i);
});

test('all command-center launches require only Task State Agent and Execute',async()=>{
  const html=await text('index.html');
  const launch=await text('assets/executive-launch.js');
  for(const id of ['eccMissionType','eccAgent','eccMissionState','eccLaunchForm','eccActiveMissions','eccRecommendation','eccStateInventory','eccSchedules','eccActionRequired','eccHealth']) assert.match(html,new RegExp(`id="${id}"`));
  assert.doesNotMatch(html,/id="eccMissionName"/);
  assert.match(html,/>Task<select id="eccMissionType"/);
  assert.match(html,/>State<select id="eccMissionState"/);
  assert.match(html,/>Agent<select id="eccAgent"/);
  assert.match(html,/>EXECUTE</);
  assert.match(html,/All task parameters are predefined by APIOS/i);
  assert.match(launch,/Select Task, State, and Agent before execution/i);
  assert.match(launch,/mission_name:`\$\{stateName\(stateCode\)\} — \$\{taskName\(\)\}`/);
});

test('mission launch state selector includes all 50 U.S. states for acquisition and discovery missions',async()=>{
  const html=await text('index.html');
  const codes=['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
  for(const code of codes) assert.match(html,new RegExp(`<option value="${code}">`));
  const selector=html.match(/<select id="eccMissionState">([\s\S]*?)<\/select>/)?.[1]||'';
  const stateOptions=[...selector.matchAll(/<option value="([A-Z]{2})">/g)].map(x=>x[1]);
  assert.equal(stateOptions.length,50);
  assert.equal(new Set(stateOptions).size,50);
});

test('every governed task has predefined backend parameters',async()=>{
  const js=await text('supabase/functions/command-mission-control/index.ts');
  for(const key of ['PUBLISHER_DISCOVERY','ACQUISITION_DISCOVERY','BUSINESS_DEVELOPMENT_DISCOVERY','OPPORTUNITY_PARTNER_DISCOVERY','INSTITUTIONAL_BUYER_DISCOVERY','STATE_MISSION']) assert.match(js,new RegExp(`${key}:\\{`));
  assert.match(js,/TASK_DEFAULTS/);
  assert.match(js,/predefined_parameters/);
  assert.match(js,/Task, State, and Agent are required/);
});

test('dashboard invokes only password-protected executive command functions',async()=>{
  const core=await text('assets/executive-core.js');
  const launch=await text('assets/executive-launch.js');
  const dashboard=await text('assets/executive-command-center.js');
  assert.match(core,/x-dashboard-password/);
  assert.match(core,/command-executive-status/);
  assert.match(launch,/command-mission-control/);
  assert.match(dashboard,/setInterval\(eccLoad,15000\)/);
});

test('mission workspace provides visual stage monitoring and Publisher Discovery candidate review',async()=>{
  const html=await text('missions/index.html');
  const js=await text('assets/mission-workspace.js');
  const core=await text('assets/executive-core.js');
  const gateway=await text('netlify/functions/candidate-review.js');
  for(const label of ['Mission Workspace','Execution Stages','Live Activity','Action Required','Candidate Review']) assert.match(html,new RegExp(label,'i'));
  for(const field of ['Current Stage','Progress','Warnings','Failures','Last Activity']) assert.match(js,new RegExp(field,'i'));
  assert.match(js,/command-mission-status/);
  assert.match(js,/command-aadp-publisher-candidate-review/);
  assert.match(core,/command-aadp-publisher-candidate-review/);
  assert.doesNotMatch(js,/invoke\('command-publisher-candidate-review'/);
  assert.match(js,/data-review/);
  assert.match(js,/setInterval\(loadMission,10000\)/);
  assert.match(gateway,/command-aadp-publisher-candidate-review/);
});

test('mission control wires all six governed mission families',async()=>{
  const js=await text('supabase/functions/command-mission-control/index.ts');
  for(const key of ['PUBLISHER_DISCOVERY','ACQUISITION_DISCOVERY','BUSINESS_DEVELOPMENT_DISCOVERY','OPPORTUNITY_PARTNER_DISCOVERY','INSTITUTIONAL_BUYER_DISCOVERY','STATE_MISSION']) assert.match(js,new RegExp(key));
  assert.match(js,/command-aadp-run/);
  assert.match(js,/command-aadp-publisher-discovery/);
  assert.match(js,/command-research-discovery/);
  assert.match(js,/child_mission_auto_authorized:false/);
});

test('AADP runtime honors operator stop requests between tasks',async()=>{
  const js=await text('supabase/functions/command-aadp-run/index.ts');
  const stop=await text('supabase/functions/command-stop/index.ts');
  assert.match(js,/async function stopped/);
  assert.match(js,/finalizeStop/);
  assert.match(js,/STOPPED_BY_OPERATOR/);
  assert.match(js,/OPERATOR_STOP/);
  assert.match(stop,/pending_tasks_cancelled:true/);
  assert.match(stop,/state=in\.\(READY,RETRY_PENDING,ASSIGNED\)/);
  assert.match(stop,/OPERATOR_STOP_REQUESTED/);
});

test('generalized and publisher discovery perform autonomous official-source research with review governance',async()=>{
  const js=await text('supabase/functions/command-research-discovery/index.ts');
  const pub=await text('supabase/functions/command-aadp-publisher-discovery/index.ts');
  assert.match(js,/api\.openai\.com\/v1\/responses/);
  assert.match(js,/type:'web_search'/);
  assert.match(js,/command_discovery_candidates/);
  assert.match(js,/PENDING_REVIEW/);
  assert.match(js,/human registry review required/i);
  assert.match(pub,/api\.openai\.com\/v1\/responses/);
  assert.match(pub,/type:'web_search'/);
  assert.match(pub,/autonomous_research/);
  assert.match(pub,/stop_requested_at/);
  assert.match(pub,/official_source_verified/);
  assert.match(pub,/CANDIDATE_REVIEW/);
  assert.match(pub,/human_review_required:true/);
});

test('VAR generalized discovery migration creates RLS-protected persistence',async()=>{
  const sql=await text('supabase/migrations/20260730073500_var_generalized_discovery_runtime.sql');
  for(const table of ['command_discovery_runs','command_discovery_candidates','business_development_registry','opportunity_partner_registry','institutional_buyer_registry']) {
    assert.match(sql,new RegExp(`create table if not exists public\\.${table}`,'i'));
    assert.match(sql,new RegExp(`alter table public\\.${table} enable row level security`,'i'));
  }
});

test('browser assets contain no server secrets',async()=>{
  const files=[await text('index.html'),await text('assets/executive-core.js'),await text('assets/executive-command-center.js'),await text('assets/executive-launch.js'),await text('assets/mission-workspace.js')].join('\n');
  assert.doesNotMatch(files,/service_role|SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY/i);
});
