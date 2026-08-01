import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const text=async path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('root is the procurement-only Executive Command Center',async()=>{
  const html=await text('index.html');
  for(const label of ['APROPOS INTELLIGENCE OPERATING SYSTEM','Executive Command Center','Configure and Execute','Active Mission Monitors','Publisher Directory','Acquisition Operations','Procurement Inventory','Recurring Automation','Action Required','Lifecycle Control','Evidence-Backed Status','Mission History','Completed Mission Outcomes','Operational Notifications']) assert.match(html,new RegExp(label,'i'));
  for(const removed of ['NAT-CORP Delivery','OTP Monitoring','Estimated Runtime','Estimated Opportunities','Mission Confidence']) assert.doesNotMatch(html,new RegExp(removed,'i'));
  assert.match(html,/Internal APROPOS operations/i);
  assert.match(html,/id="gatePassword"/);
  assert.match(html,/noindex,nofollow/i);
});

test('operator launch is task state target and execute with system-selected agent',async()=>{
  const html=await text('index.html');
  const launch=await text('assets/executive-launch.js');
  for(const id of ['eccMissionType','eccAgent','eccAgentDisplay','eccMissionState','eccTaskConfiguration','eccLaunchForm','eccActiveMissions','eccStateInventory','eccSchedules','eccActionRequired','eccHealth']) assert.match(html,new RegExp(`id="${id}"`));
  assert.doesNotMatch(html,/id="eccMissionName"/);
  assert.match(html,/>Task<select id="eccMissionType"/);
  assert.match(html,/>State<select id="eccMissionState"/);
  assert.match(html,/Execution Agent<input id="eccAgentDisplay"[^>]*readonly/);
  assert.match(html,/>EXECUTE</);
  assert.match(html,/APIE will resolve the technical configuration/i);
  assert.match(launch,/automation_mode:'FULLY_AUTOMATED'/);
  assert.match(launch,/setAgent\(task\?\.agent/);
});

test('mission launch state selector includes all 50 U.S. states',async()=>{
  const html=await text('index.html');
  const codes=['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
  for(const code of codes) assert.match(html,new RegExp(`<option value="${code}">`));
  const selector=html.match(/<select id="eccMissionState"[^>]*>([\s\S]*?)<\/select>/)?.[1]||'';
  const stateOptions=[...selector.matchAll(/<option value="([A-Z]{2})">/g)].map(x=>x[1]);
  assert.equal(stateOptions.length,50);
  assert.equal(new Set(stateOptions).size,50);
});

test('every dashboard task has predefined automatic configuration',async()=>{
  const launch=await text('assets/executive-launch.js');
  for(const key of ['PUBLISHER_DISCOVERY','ACQUISITION_DISCOVERY','STATE_MISSION','AADP_PROCESSING','AOIE_ANALYSIS','PROCUREMENT_INVENTORY','CONTRACT_LIFECYCLE','BUSINESS_DEVELOPMENT_DISCOVERY','OPPORTUNITY_PARTNER_DISCOVERY','INSTITUTIONAL_BUYER_DISCOVERY']) assert.match(launch,new RegExp(`${key}:\\{`));
  assert.match(launch,/manual_onboarding:false/);
  assert.match(launch,/manual_assignment:false/);
  assert.match(launch,/manual_connector_configuration:false/);
});

test('dashboard invokes password-protected executive command functions',async()=>{
  const core=await text('assets/executive-core.js');
  const launch=await text('assets/executive-launch.js');
  const dashboard=await text('assets/executive-command-center.js');
  assert.match(core,/x-dashboard-password/);
  for(const fn of ['command-executive-status','command-acquisition-mission','command-automated-task','command-publisher-options']) assert.match(core,new RegExp(fn));
  assert.match(launch,/command-mission-control/);
  assert.match(dashboard,/setInterval\(eccLoad,15000\)/);
});

test('Executive Dashboard cards and fields remain dark-theme compatible',async()=>{
  const css=await text('assets/executive-command-center.css');
  assert.match(css,/\.ecc-shell\{color-scheme:dark\}/);
  assert.match(css,/\.ecc-shell \.ecc-mission-card[\s\S]*background:rgba\(255,255,255,\.035\)/);
  assert.match(css,/\.ecc-shell \.ecc-launch select,[\s\S]*background:var\(--panel2\);color:var\(--text\)/);
  assert.match(css,/\.ecc-shell \.ecc-state-selector button[\s\S]*background:var\(--panel2\);color:var\(--text\)/);
  assert.doesNotMatch(css,/\.ecc-shell \.ecc-mission-card[^}]*background:#fff/);
});

test('mission workspace provides visual stage monitoring and Publisher Discovery candidate review',async()=>{
  const html=await text('missions/index.html');
  const js=await text('assets/mission-workspace.js');
  const core=await text('assets/executive-core.js');
  for(const label of ['Mission Workspace','Execution Stages','Live Activity','Action Required','Candidate Review']) assert.match(html,new RegExp(label,'i'));
  for(const field of ['Current Stage','Progress','Warnings','Failures','Last Activity']) assert.match(js,new RegExp(field,'i'));
  assert.match(js,/command-mission-status/);
  assert.match(js,/command-aadp-publisher-candidate-review/);
  assert.match(core,/command-aadp-publisher-candidate-review/);
  assert.match(js,/setInterval\(loadMission,10000\)/);
});

test('core discovery and AADP runtimes retain governed execution',async()=>{
  const mission=await text('supabase/functions/command-mission-control/index.ts');
  const aadp=await text('supabase/functions/command-aadp-run/index.ts');
  const pub=await text('supabase/functions/command-aadp-publisher-discovery/index.ts');
  assert.match(mission,/command-aadp-publisher-discovery/);
  assert.match(mission,/command-research-discovery/);
  assert.match(aadp,/STOPPED_BY_OPERATOR/);
  assert.match(pub,/api\.openai\.com\/v1\/responses/);
  assert.match(pub,/official_source_verified/);
});

test('browser assets contain no server secrets',async()=>{
  const files=[await text('index.html'),await text('assets/executive-core.js'),await text('assets/executive-command-center.js'),await text('assets/executive-launch.js'),await text('assets/mission-workspace.js')].join('\n');
  assert.doesNotMatch(files,/service_role|SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY/i);
});
