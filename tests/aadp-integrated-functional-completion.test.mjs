import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const executorPath = 'supabase/functions/aadp-task-executor/index.ts';
const executorV2Path = 'supabase/functions/aadp-task-executor-v2/index.ts';
const discoveryPath = 'supabase/functions/command-aadp-publisher-discovery/index.ts';
const sharedPath = 'supabase/functions/_shared/aadp.ts';
const commandPath = 'supabase/functions/command-aadp-run/index.ts';
const migrationPath = 'supabase/migrations/20260726010000_aadp_operating_system_v1.sql';

const executor = fs.readFileSync(executorPath, 'utf8');
const executorV2 = fs.readFileSync(executorV2Path, 'utf8');
const discovery = fs.readFileSync(discoveryPath, 'utf8');
const shared = fs.readFileSync(sharedPath, 'utf8');
const command = fs.readFileSync(commandPath, 'utf8');
const migration = fs.readFileSync(migrationPath, 'utf8');

test('AADP task executor exposes the complete Version 1 execution path', () => {
  const handlers = [
    'PUBLISHER_ASSIGNMENT_CREATE','ACQUISITION_RUN_START','ACQUISITION_PAGE_FETCH','ACQUISITION_RECORD_STORE',
    'ACQUISITION_RUN_CLOSE','RECORD_NORMALIZATION','RECORD_DEDUPLICATION','RECORD_QUALIFICATION',
    'QUALIFIED_RECORD_UPSERT','REJECTION_RECORD_CREATE','RUN_RECONCILIATION','AOIE_BATCH_REVIEW',
    'PROCUREMENT_LANGUAGE_ANALYSIS','MATCHING_RECOMMENDATION_CREATE','MATCHING_RECOMMENDATION_TEST',
    'EXECUTIVE_REPORT_CREATE'
  ];
  for (const handler of handlers) assert.match(executor, new RegExp(`case '${handler}'`));
});

test('acquisition uses publisher assignment controls and bounded pagination', () => {
  for (const pattern of [/assignment\.search_endpoint/, /pagination_instructions/, /max_pages/, /page_size/, /Publisher retrieval failed/, /pagination_complete/]) {
    assert.match(executor, pattern);
  }
});

test('raw records preserve source and content identities', () => {
  for (const pattern of [/acquisition_raw_records/, /source_record_id/, /source_fingerprint/, /content_fingerprint/, /canonicalJson/, /SHA-256/]) {
    assert.match(executor, pattern);
  }
});

test('qualification remains PostgreSQL authoritative', () => {
  assert.match(executor, /rpc\/aadp_qualify_raw_record/);
  assert.match(executor, /RECORD_QUALIFICATION/);
  assert.doesNotMatch(executor, /processing_status:\s*'QUALIFIED'/);
});

test('qualified records are delivered to state_contract_opportunities', () => {
  for (const pattern of [/state_contract_opportunities/, /source_platform/, /source_record_id/, /qualified_record_id/]) {
    assert.match(executor, pattern);
  }
});

test('AOIE creates controlled recommendations without changing production matching', () => {
  for (const pattern of [/procurement_language_analysis/, /aoie_batch_reviews/, /aoie_change_recommendations/, /NO RECOMMENDATIONS AT THIS TIME/, /NEEDS YOUR ATTENTION/, /production_matching_changed:\s*false/, /production_applied:\s*false/]) {
    assert.match(executor, pattern);
  }
});

test('manual intervention is emitted as an auditable ACTION NEEDED event', () => {
  for (const pattern of [/'ACTION_NEEDED'/, /recommended_action/, /resume_point/, /unrelated_publishers_may_continue:\s*true/]) {
    assert.match(executor, pattern);
  }
});

test('state publisher discovery is separate from recurring acquisition', () => {
  assert.match(discovery, /publisher_discovery_runs/);
  assert.match(discovery, /PUBLISHER_DISCOVERY_STARTED/);
  assert.match(discovery, /PROJECT_OWNER_APPROVAL_OR_EXCEPTION_REVIEW/);
  assert.match(discovery, /PUBLISHER_RESULTS_PRESENTED/);
  assert.match(discovery, /ACTION_NEEDED/);
  assert.doesNotMatch(discovery, /acquisition_raw_records/);
});

test('authoritative migration uses an expression unique index rather than an invalid expression constraint', () => {
  assert.match(migration, /publisher_registry_name_state_unique_idx/);
  assert.match(migration, /coalesce\(state_code,\s*''\)/i);
  assert.doesNotMatch(migration, /unique\s*\(\s*publisher_name\s*,\s*coalesce/i);
});

test('migration includes state discovery and action-needed persistence', () => {
  assert.match(migration, /create table if not exists public\.publisher_discovery_runs/);
  assert.match(migration, /create table if not exists public\.aadp_action_needed_alerts/);
  assert.match(migration, /unrelated_publishers_may_continue/);
  assert.match(migration, /resume_point/);
});

test('corrected executive reporting does not self-reference unresolved Promise results', () => {
  assert.match(executorV2, /const \[raw, dispositions, rejections, analyses, reviews, tasks, failures\] = await Promise\.all/);
  assert.match(executorV2, /const review = reviews\?\.\[0\] \?\? null/);
  assert.match(executorV2, /const recommendations = review/);
  assert.doesNotMatch(executorV2, /Promise\.all\([\s\S]*batch_review_id=eq\.\$\{reviews/);
});

test('the orchestrator routes tasks through the corrected executor', () => {
  assert.match(shared, /invoke\('aadp-task-executor-v2'/);
  assert.match(executorV2, /invoke\('aadp-task-executor'/);
  assert.match(command, /runAadpTask/);
  assert.match(command, /createTaskGraph/);
});

test('no service-role secret is embedded in AADP function source', () => {
  for (const source of [executor, executorV2, discovery]) {
    assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY\s*=\s*['"]/);
    assert.doesNotMatch(source, /eyJ[A-Za-z0-9_-]{20,}/);
  }
});
