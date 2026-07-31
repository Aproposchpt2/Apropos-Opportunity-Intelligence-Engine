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

test('Executive Mission Control exposes governed Publisher Discovery launch',()=>{
  assert.match(html,/<option value="PUBLISHER_DISCOVERY">Publisher Discovery<\/option>/);
  for(const id of ['eccMissionType','eccMissionState','eccAgent','eccLaunchForm']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/All task parameters are predefined by APIOS/i);
  assert.match(launch,/command-mission-control/);
  assert.match(missionControl,/PUBLISHER_DISCOVERY/);
  assert.match(missionControl,/command-aadp-publisher-discovery/);
  assert.match(missionControl,/child_mission_auto_authorized:false/);
});

test('legacy discovery readiness runtime is retired',async()=>{
  const legacy=await text('assets/command-center-discovery.js');
  assert.match(legacy,/RETIRED BY VAR CYCLE 2/);
  assert.match(legacy,/authoritative server\/database evidence/i);
  assert.doesNotMatch(legacy,/CONFIG\.anonKey\?'Connected'/);
  assert.doesNotMatch(legacy,/overallSystemHealth/);
  assert.doesNotMatch(legacy,/database:Boolean\(CONFIG\.supabaseUrl&&CONFIG\.anonKey\)/);
});

test('Discovery service enforces scope and publisher types before creating a new run',()=>{
  assert.match(discoveryFn,/discovery_scope and organization_types are required/);
  assert.match(discoveryFn,/existing_publisher_selection_required|candidate_intake/);
  assert.match(discoveryFn,/official_source_research_required:true/);
  assert.match(discoveryFn,/duplicate_registry_detection_required:true/);
  assert.match(discoveryFn,/candidate_record_creation_enabled:true/);
  assert.match(discoveryFn,/human_review_before_registry_admission_required:true/);
});

test('Autonomous Publisher Discovery is time-bounded and fails closed instead of remaining RUNNING forever',()=>{
  assert.match(discoveryFn,/RESEARCH_TIMEOUT_MS=60000/);
  assert.match(discoveryFn,/AbortSignal\.timeout\(RESEARCH_TIMEOUT_MS\)/);
  assert.match(discoveryFn,/gpt-5\.6-terra/);
  assert.match(discoveryFn,/reasoning:\{effort:'low'\}/);
  assert.match(discoveryFn,/search_context_size:'low'/);
  assert.match(discoveryFn,/Publisher research provider timed out/);
  assert.match(discoveryFn,/status:'failed'/);
  assert.match(discoveryFn,/current_stage:'RESEARCH_FAILED'/);
  assert.match(discoveryFn,/action_required:true/);
  assert.match(discoveryFn,/MISSION_FAILURE/);
});

test('Publisher Discovery fails closed when research returns no usable candidates',()=>{
  assert.match(discoveryFn,/Publisher research completed without candidate records/);
  assert.match(discoveryFn,/NO_CANDIDATES_FOUND/);
  assert.match(discoveryFn,/Publisher research returned no candidates; operator review or retry required/);
});

test('Discovery candidates are staged outside authoritative Publisher Registry',()=>{
  assert.match(migration,/create table if not exists public\.publisher_discovery_candidates/);
  assert.match(migration,/human_review_before_registry_admission_required/);
  assert.match(discoveryFn,/publisher_discovery_candidates/);
  assert.match(discoveryFn,/registry_records_created:0/);
  assert.match(discoveryFn,/duplicate_registry_matches/);
  assert.doesNotMatch(discoveryFn,/db\('publisher_registry'\s*,\s*\{\s*method:\s*'POST'/);
});

test('Mission Workspace provides evidence review before Publisher Registry admission',()=>{
  assert.match(workspace,/publisherCandidates/);
  assert.match(workspace,/official_source_verified===true/);
  assert.match(workspace,/Candidates without verified official-source evidence cannot be approved/);
  assert.match(workspace,/data-review="APPROVE"/);
  assert.match(workspace,/data-review="REJECT"/);
  assert.match(workspace,/command-aadp-publisher-candidate-review/);
  assert.match(executiveCore,/command-aadp-publisher-candidate-review/);
  assert.doesNotMatch(workspace,/invoke\('command-publisher-candidate-review'/);
});

test('Human review is protected and enforces verification and duplicate gates',()=>{
  assert.match(reviewFn,/requireServiceRole/);
  assert.match(reviewFn,/requireDashboardAuth/);
  assert.match(reviewFn,/serviceError \? await requireDashboardAuth/);
  assert.match(reviewFn,/decision must be APPROVE or REJECT/);
  assert.match(reviewFn,/official_source_verified !== true/);
  assert.match(reviewFn,/duplicate_publisher_id/);
  assert.match(reviewFn,/Duplicate Publisher Registry record detected during final admission check/);
  assert.match(reviewFn,/db\('publisher_registry'/);
  assert.match(reviewFn,/review_status: 'APPROVED_ADMITTED'/);
  assert.match(reviewFn,/admitted_by_human_review: true/);
});

test('Every human candidate decision produces an auditable command event',()=>{
  assert.match(reviewFn,/recordReviewDecision/);
  assert.match(reviewFn,/PUBLISHER_DISCOVERY_CANDIDATE_APPROVED/);
  assert.match(reviewFn,/PUBLISHER_DISCOVERY_CANDIDATE_REJECTED/);
  assert.match(reviewFn,/decision_source: 'DASHBOARD_HUMAN_REVIEW'/);
  assert.match(reviewFn,/candidate_id/);
  assert.match(reviewFn,/publisher_id/);
});

test('Corrective migration preserves acquisition integrity and least privilege',()=>{
  assert.doesNotMatch(migration,/alter table public\.publisher_assignments[\s\S]*drop not null/i);
  assert.doesNotMatch(migration,/alter table public\.acquisition_runs[\s\S]*drop not null/i);
  assert.match(migration,/publisher_discovery_candidate_admitted_idx/);
  assert.match(migration,/enable row level security/);
  assert.match(migration,/revoke all on public\.publisher_discovery_candidates from anon, authenticated/);
  assert.match(migration,/grant select on public\.publisher_discovery_candidates to authenticated/);
});
