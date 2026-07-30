import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const text=async path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('root is the internal Executive Command Center',async()=>{
  const html=await text('index.html');
  for(const label of ['APROPOS INTELLIGENCE OPERATING SYSTEM','Executive Command Center','State Operations Context','Authorize an Operation','Active Mission Monitors','NAT-CORP Executive Control Plane','Capability Readiness','Recurring Automation','Action Required','Lifecycle Control','Automation Infrastructure','Operational Notifications'])assert.match(html,new RegExp(label,'i'));
  assert.match(html,/Internal APROPOS operations/i);assert.match(html,/id="gatePassword"/);assert.match(html,/noindex,nofollow/i);
});

test('simplified executive launch exposes governed mission controls',async()=>{
  const html=await text('index.html');
  for(const id of ['eccMissionType','eccMissionName','eccAgent','eccMissionState','eccLaunchForm','eccActiveMissions','eccRecommendation','eccStateInventory','eccSchedules','eccActionRequired','eccHealth'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/AUTHORIZE & EXECUTE/);assert.match(html,/Human authorization remains authoritative/i);
});

test('dashboard invokes only password-protected executive command functions',async()=>{
  const core=await text('assets/executive-core.js');const launch=await text('assets/executive-launch.js');const dashboard=await text('assets/executive-command-center.js');
  assert.match(core,/x-dashboard-password/);assert.match(core,/command-executive-status/);assert.match(launch,/command-mission-control/);assert.match(dashboard,/15s/i);
});

test('mission workspace provides visual stage monitoring',async()=>{
  const html=await text('missions/index.html');const js=await text('assets/mission-workspace.js');
  for(const label of ['Mission Workspace','Execution Stages','Live Activity','Action Required'])assert.match(html,new RegExp(label,'i'));
  for(const field of ['Current Stage','Progress','Warnings','Failures','Last Activity'])assert.match(js,new RegExp(field,'i'));
  assert.match(js,/command-mission-status/);assert.match(js,/setInterval\(loadMission,10000\)/);
});

test('mission control wires all six governed mission families',async()=>{
  const js=await text('supabase/functions/command-mission-control/index.ts');
  for(const key of ['PUBLISHER_DISCOVERY','ACQUISITION_DISCOVERY','BUSINESS_DEVELOPMENT_DISCOVERY','OPPORTUNITY_PARTNER_DISCOVERY','INSTITUTIONAL_BUYER_DISCOVERY','STATE_MISSION'])assert.match(js,new RegExp(key));
  assert.match(js,/command-aadp-run/);assert.match(js,/command-aadp-publisher-discovery/);assert.match(js,/command-research-discovery/);assert.match(js,/child_mission_auto_authorized:false/);
});

test('AADP runtime honors operator stop requests between tasks',async()=>{
  const js=await text('supabase/functions/command-aadp-run/index.ts');const stop=await text('supabase/functions/command-stop/index.ts');
  assert.match(js,/isStopRequested/);assert.match(js,/finalizeStopped/);assert.match(js,/STOPPED_BY_OPERATOR/);assert.match(js,/OPERATOR_STOP/);
  assert.match(stop,/pending_tasks_cancelled:true/);assert.match(stop,/state=in\.\(READY,RETRY_PENDING,ASSIGNED\)/);assert.match(stop,/OPERATOR_STOP_REQUESTED/);
});

test('generalized discovery runtime performs official-source web research and stages review candidates',async()=>{
  const js=await text('supabase/functions/command-research-discovery/index.ts');const pub=await text('supabase/functions/command-aadp-publisher-discovery/index.ts');
  assert.match(js,/api\.openai\.com\/v1\/responses/);assert.match(js,/type:'web_search'/);assert.match(js,/command_discovery_candidates/);assert.match(js,/PENDING_REVIEW/);assert.match(js,/human registry review required/i);
  assert.match(pub,/autonomousResearch/);assert.match(pub,/official_source_verified/);assert.match(pub,/human_review_required:true/);
});

test('VAR generalized discovery migration creates RLS-protected persistence',async()=>{
  const sql=await text('supabase/migrations/20260730073500_var_generalized_discovery_runtime.sql');
  for(const table of ['command_discovery_runs','command_discovery_candidates','business_development_registry','opportunity_partner_registry','institutional_buyer_registry']){assert.match(sql,new RegExp(`create table if not exists public\\.${table}`,'i'));assert.match(sql,new RegExp(`alter table public\\.${table} enable row level security`,'i'));}
});

test('browser assets contain no server secrets',async()=>{
  const files=[await text('index.html'),await text('assets/executive-core.js'),await text('assets/executive-command-center.js'),await text('assets/executive-launch.js'),await text('assets/mission-workspace.js')].join('\n');
  assert.doesNotMatch(files,/service_role|SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY/i);
});