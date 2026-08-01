import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const text=async path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const html=await text('index.html');
const launch=await text('assets/executive-launch.js');
const workspace=await text('assets/mission-workspace.js');
const executiveCore=await text('assets/executive-core.js');
const missionControl=await text('supabase/functions/command-mission-control/index.ts');
const discoveryFn=await text('supabase/functions/command-aadp-publisher-discovery/index.ts');
const reviewFn=await text('supabase/functions/command-aadp-publisher-candidate-review/index.ts');
const migration=await text('supabase/migrations/20260728210000_publisher_discovery_live_acceptance_corrective.sql');

test('Executive Mission Control exposes automated Publisher Discovery launch',()=>{
  assert.match(html,/<option value="PUBLISHER_DISCOVERY">Publisher Discovery<\/option>/);
  for(const id of ['eccMissionType','eccMissionState','eccAgent','eccLaunchForm']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/APIE will resolve the technical configuration/i);
  assert.match(launch,/automation_mode:'FULLY_AUTOMATED'/);
  assert.match(launch,/command-mission-control/);
  assert.match(missionControl,/PUBLISHER_DISCOVERY/);
  assert.match(missionControl,/command-aadp-publisher-discovery/);
});

test('legacy discovery readiness runtime is retired',async()=>{const legacy=await text('assets/command-center-discovery.js');assert.match(legacy,/RETIRED BY VAR CYCLE 2/);assert.doesNotMatch(legacy,/CONFIG\.anonKey\?'Connected'/)});
test('Discovery service enforces scope and source evidence',()=>{assert.match(discoveryFn,/official_source_research_required:true/);assert.match(discoveryFn,/duplicate_registry_detection_required:true/);assert.match(discoveryFn,/candidate_record_creation_enabled:true/)});
test('Autonomous Publisher Discovery is time-bounded and fails closed',()=>{assert.match(discoveryFn,/RESEARCH_TIMEOUT_MS=60000/);assert.match(discoveryFn,/AbortSignal\.timeout\(RESEARCH_TIMEOUT_MS\)/);assert.match(discoveryFn,/current_stage:'RESEARCH_FAILED'/);assert.match(discoveryFn,/action_required:true/)});
test('Discovery candidates preserve governed staging',()=>{assert.match(migration,/create table if not exists public\.publisher_discovery_candidates/);assert.match(discoveryFn,/publisher_discovery_candidates/);assert.match(discoveryFn,/duplicate_registry_matches/)});
test('Mission Workspace preserves candidate evidence controls',()=>{assert.match(workspace,/publisherCandidates/);assert.match(workspace,/official_source_verified===true/);assert.match(workspace,/data-review="APPROVE"/);assert.match(workspace,/data-review="REJECT"/);assert.match(workspace,/command-aadp-publisher-candidate-review/);assert.match(executiveCore,/command-aadp-publisher-candidate-review/)});
test('Candidate decision endpoint remains protected and auditable',()=>{assert.match(reviewFn,/requireServiceRole/);assert.match(reviewFn,/requireDashboardAuth/);assert.match(reviewFn,/recordReviewDecision/);assert.match(reviewFn,/PUBLISHER_DISCOVERY_CANDIDATE_APPROVED/);assert.match(reviewFn,/PUBLISHER_DISCOVERY_CANDIDATE_REJECTED/)});
test('Corrective migration preserves least privilege',()=>{assert.match(migration,/enable row level security/);assert.match(migration,/revoke all on public\.publisher_discovery_candidates from anon, authenticated/)});
