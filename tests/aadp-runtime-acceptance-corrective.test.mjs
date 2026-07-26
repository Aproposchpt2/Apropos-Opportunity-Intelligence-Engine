import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const shared = fs.readFileSync('supabase/functions/_shared/aadp.ts','utf8');
const runner = fs.readFileSync('supabase/functions/command-aadp-run/index.ts','utf8');
const executor = fs.readFileSync('supabase/functions/aadp-task-executor-v2/index.ts','utf8');
const migration = fs.readFileSync('supabase/migrations/20260726210000_aadp_runtime_acceptance_corrective_v1.sql','utf8');
const html = fs.readFileSync('index.html','utf8');
const ui = fs.readFileSync('assets/command-center.js','utf8');

test('AOIE task graph enforces language analysis before review', () => {
  const analysis = shared.indexOf("'PROCUREMENT_LANGUAGE_ANALYSIS'");
  const review = shared.indexOf("'AOIE_BATCH_REVIEW'", analysis);
  assert.ok(analysis >= 0 && review > analysis);
  assert.match(shared, /RUN_RECONCILIATION'[\s\S]*PROCUREMENT_LANGUAGE_ANALYSIS'[\s\S]*AOIE_BATCH_REVIEW'/);
});

test('AOIE review fails closed on count variance', () => {
  assert.match(executor, /expected !== actual/);
  assert.match(executor, /AOIE_ANALYSIS_COUNT_VARIANCE/);
  assert.match(executor, /expected_analysis_count/);
  assert.match(executor, /actual_analysis_count/);
  assert.match(executor, /Recommendation determination would be incomplete/);
});

test('semantic completion is database-authoritative', () => {
  assert.match(migration, /aadp_validate_semantic_completion/);
  assert.match(migration, /SEMANTICALLY_COMPLETE/);
  assert.match(migration, /v_raw = v_disposed/);
  assert.match(migration, /v_qualified = v_qualified_upserts/);
  assert.match(migration, /v_qualified = v_analyses/);
  assert.match(migration, /v_analyses = v_reviewed/);
  assert.match(runner, /semanticValidation/);
  assert.match(runner, /semantic\.valid === true/);
});

test('version governance distinguishes required relationships', () => {
  for (const value of ['EXACT_DUPLICATE','CONTENT_UPDATE','AMENDMENT','NEW_SOURCE_VERSION','SUPERSEDED_PREDECESSOR','CURRENT_LATEST_VERSION']) {
    assert.match(migration, new RegExp(value));
    assert.match(executor, new RegExp(value));
  }
  for (const column of ['canonical_opportunity_id','version_id','version_number','predecessor_record_id','superseded_by_record_id','amendment_of_record_id','is_current_version','version_reason']) {
    assert.match(migration, new RegExp(column));
  }
});

test('controlled retry and safe resume preserve attempts', () => {
  assert.match(executor, /CONTROLLED_TRANSIENT_ACCEPTANCE_FAILURE/);
  assert.match(shared, /RETRY_PENDING/);
  assert.match(shared, /retry_scheduled_for/);
  assert.match(runner, /resume_run_id/);
  assert.match(runner, /resume_source_stage/);
  assert.match(runner, /AADP_RUN_RESUMED/);
  assert.match(runner, /createTaskGraph\(run\.id/);
});

test('command submission is asynchronous and pollable', () => {
  assert.match(runner, /EdgeRuntime\.waitUntil/);
  assert.match(runner, /asynchronous:\s*true/);
  assert.match(runner, /status:\s*'QUEUED'/);
  assert.match(runner, /poll:/);
});

test('qualified destination is protected by approved RLS model', () => {
  assert.match(migration, /alter table public\.state_contract_opportunities enable row level security/);
  assert.match(migration, /revoke all on public\.state_contract_opportunities from anon, public/);
  assert.match(migration, /revoke insert, update, delete on public\.state_contract_opportunities from authenticated/);
  assert.match(migration, /grant select, insert, update, delete on public\.state_contract_opportunities to service_role/);
  assert.match(migration, /state_contract_opportunities_operator_read/);
});

test('process projection supports the required display states', () => {
  assert.match(migration, /aadp_process_stage_projection/);
  for (const state of ['NOT STARTED','QUEUED','IN PROGRESS','COMPLETED','COMPLETED WITH WARNINGS','ACTION NEEDED','FAILED','CANCELLED']) {
    assert.match(migration, new RegExp(state));
  }
  assert.match(runner, /refreshStageProjection/);
});

test('Command Center contains AADP process, alerts, and recommendation surfaces', () => {
  for (const id of ['aadpProcessIndicator','aadpActionNeeded','aadpPublisherRun','aadpRecommendationReport']) assert.match(html, new RegExp(id));
  for (const name of ['renderAadpProcess','renderAadpAlerts','renderAadpPublisherRun','renderAadpRecommendations']) assert.match(ui, new RegExp(name));
});
