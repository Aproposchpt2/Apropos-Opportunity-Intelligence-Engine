import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const text=async path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

const html=await text('index.html');
const discoveryUi=await text('assets/command-center-discovery.js');
const discoveryFn=await text('supabase/functions/command-aadp-publisher-discovery/index.ts');
const reviewFn=await text('supabase/functions/command-aadp-publisher-candidate-review/index.ts');
const migration=await text('supabase/migrations/20260728210000_publisher_discovery_live_acceptance_corrective.sql');
const acquisition=await text('supabase/functions/command-aadp-run/index.ts');

test('Discovery Step 03 exposes state scope multi-select and governed controls',()=>{
  for(const id of ['discoveryScopeConfiguration','discoveryState','discoveryScope','discoveryOrganizationTypes','selectAllDiscoveryTypes','governanceOfficialSources','governanceDuplicateDetection','governanceCandidateStaging','governanceHumanApproval']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/id="discoveryOrganizationTypes"\s+multiple/);
  for(const type of ['State Agencies','Counties','Cities / Municipalities','Universities','Community Colleges','School Districts','Transportation Authorities','Public Utilities','Water Districts','Special Districts','Public Authorities','Independent Agencies','Other Public Procurement Publishers']) assert.match(html,new RegExp(type));
  assert.match(html,/assets\/command-center-discovery\.js/);
  assert.match(html,/Existing publisher selection is not required/);
});

test('Discovery readiness is mission-type specific and does not require an existing publisher',()=>{
  assert.match(discoveryUi,/isDiscoveryMission\(\)/);
  assert.match(discoveryUi,/selectedDiscoveryTypes\(\)/);
  assert.match(discoveryUi,/discoveryGovernanceAvailable\(\)/);
  assert.match(discoveryUi,/BEGIN STATE DISCOVERY/);
  assert.match(discoveryUi,/publishers:Boolean\(\$\('discoveryState'\)\.value\)/);
  assert.match(discoveryUi,/queue:types\.length>0/);
  assert.match(discoveryUi,/estimate:discoveryGovernanceAvailable\(\)/);
  assert.doesNotMatch(discoveryUi,/isDiscoveryMission\(\)[\s\S]{0,500}state\.selected\.length>0/);
});

test('Known-publisher acquisition readiness and launcher remain protected',()=>{
  assert.match(discoveryUi,/if\(!isDiscoveryMission\(\)\)return baseReadiness\(\)/);
  assert.match(discoveryUi,/if\(!isDiscoveryMission\(\)\)return baseRenderReadiness\(\)/);
  assert.match(html,/id="publisherSelect"/);
  assert.match(html,/id="addPublisherButton"/);
  assert.match(html,/BEGIN DAILY OPERATIONS/);
  assert.match(acquisition,/assignment_id is required/);
  assert.match(acquisition,/publisher_assignments\?id=eq/);
});

test('Discovery candidates are staged outside the authoritative Publisher Registry',()=>{
  assert.match(migration,/create table if not exists public\.publisher_discovery_candidates/);
  assert.match(migration,/human_review_before_registry_admission_required/);
  assert.match(discoveryFn,/publisher_discovery_candidates/);
  assert.match(discoveryFn,/existing_publisher_selection_required:\s*false/);
  assert.match(discoveryFn,/registry_records_created:\s*0/);
  assert.match(discoveryFn,/duplicate_registry_matches/);
  assert.doesNotMatch(discoveryFn,/db\('publisher_registry'\s*,\s*\{\s*method:\s*'POST'/);
  assert.doesNotMatch(discoveryFn,/db\(`publisher_registry\?id=.*method:\s*'PATCH'/s);
});

test('Human review is the only corrective admission path and enforces verification and duplicate gates',()=>{
  assert.match(reviewFn,/decision must be APPROVE or REJECT/);
  assert.match(reviewFn,/official_source_verified !== true/);
  assert.match(reviewFn,/duplicate_publisher_id/);
  assert.match(reviewFn,/Duplicate Publisher Registry record detected during final admission check/);
  assert.match(reviewFn,/db\('publisher_registry'/);
  assert.match(reviewFn,/review_status:\s*'APPROVED_ADMITTED'/);
  assert.match(reviewFn,/admitted_by_human_review:\s*true/);
});

test('Corrective migration preserves acquisition integrity and least privilege',()=>{
  assert.doesNotMatch(migration,/alter table public\.publisher_assignments[\s\S]*drop not null/i);
  assert.doesNotMatch(migration,/alter table public\.acquisition_runs[\s\S]*drop not null/i);
  assert.match(migration,/publisher_discovery_candidates/);
  assert.match(migration,/enable row level security/);
  assert.match(migration,/revoke all on public\.publisher_discovery_candidates from anon, authenticated/);
  assert.match(migration,/grant select on public\.publisher_discovery_candidates to authenticated/);
});
