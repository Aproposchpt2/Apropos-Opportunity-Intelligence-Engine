import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const executorPath = 'supabase/functions/aadp-task-executor/index.ts';
const sharedPath = 'supabase/functions/_shared/aadp.ts';
const commandPath = 'supabase/functions/command-aadp-run/index.ts';

const executor = fs.readFileSync(executorPath, 'utf8');
const shared = fs.readFileSync(sharedPath, 'utf8');
const command = fs.readFileSync(commandPath, 'utf8');

test('AADP task executor exists and exposes the complete Version 1 execution path', () => {
  const handlers = [
    'PUBLISHER_ASSIGNMENT_CREATE',
    'ACQUISITION_RUN_START',
    'ACQUISITION_PAGE_FETCH',
    'ACQUISITION_RECORD_STORE',
    'ACQUISITION_RUN_CLOSE',
    'RECORD_NORMALIZATION',
    'RECORD_DEDUPLICATION',
    'RECORD_QUALIFICATION',
    'QUALIFIED_RECORD_UPSERT',
    'REJECTION_RECORD_CREATE',
    'RUN_RECONCILIATION',
    'AOIE_BATCH_REVIEW',
    'PROCUREMENT_LANGUAGE_ANALYSIS',
    'MATCHING_RECOMMENDATION_CREATE',
    'MATCHING_RECOMMENDATION_TEST',
    'EXECUTIVE_REPORT_CREATE'
  ];
  for (const handler of handlers) assert.match(executor, new RegExp(`case '${handler}'`));
});

test('acquisition uses publisher assignment controls and bounded pagination', () => {
  assert.match(executor, /assignment\.search_endpoint/);
  assert.match(executor, /pagination_instructions/);
  assert.match(executor, /max_pages/);
  assert.match(executor, /page_size/);
  assert.match(executor, /Publisher retrieval failed/);
  assert.match(executor, /pagination_complete/);
});

test('raw records preserve source and content identities', () => {
  assert.match(executor, /acquisition_raw_records/);
  assert.match(executor, /source_record_id/);
  assert.match(executor, /source_fingerprint/);
  assert.match(executor, /content_fingerprint/);
  assert.match(executor, /canonicalJson/);
  assert.match(executor, /SHA-256/);
});

test('qualification remains PostgreSQL authoritative', () => {
  assert.match(executor, /rpc\/aadp_qualify_raw_record/);
  assert.match(executor, /RECORD_QUALIFICATION/);
  assert.doesNotMatch(executor, /processing_status:\s*'QUALIFIED'/);
});

test('qualified records are delivered to state_contract_opportunities', () => {
  assert.match(executor, /state_contract_opportunities/);
  assert.match(executor, /source_platform/);
  assert.match(executor, /source_record_id/);
  assert.match(executor, /qualified_record_id/);
});

test('AOIE creates controlled recommendations without changing production matching', () => {
  assert.match(executor, /procurement_language_analysis/);
  assert.match(executor, /aoie_batch_reviews/);
  assert.match(executor, /aoie_change_recommendations/);
  assert.match(executor, /NO RECOMMENDATIONS AT THIS TIME/);
  assert.match(executor, /NEEDS YOUR ATTENTION/);
  assert.match(executor, /production_matching_changed:\s*false/);
  assert.match(executor, /production_applied:\s*false/);
});

test('manual intervention is emitted as an auditable ACTION NEEDED event', () => {
  assert.match(executor, /'ACTION_NEEDED'/);
  assert.match(executor, /recommended_action/);
  assert.match(executor, /resume_point/);
  assert.match(executor, /unrelated_publishers_may_continue:\s*true/);
});

test('reconciliation and reporting are terminal execution handlers', () => {
  assert.match(executor, /rpc\/aadp_reconcile_run/);
  assert.match(executor, /executive_run_reports/);
  assert.match(executor, /reconciliation_variance/);
  assert.match(executor, /final_status/);
});

test('the orchestrator invokes the executor through the shared AADP service', () => {
  assert.match(shared, /invoke\('aadp-task-executor'/);
  assert.match(command, /runAadpTask/);
  assert.match(command, /createTaskGraph/);
});

test('no service-role secret is embedded in executor source', () => {
  assert.doesNotMatch(executor, /SUPABASE_SERVICE_ROLE_KEY\s*=\s*['"]/);
  assert.doesNotMatch(executor, /eyJ[A-Za-z0-9_-]{20,}/);
});
