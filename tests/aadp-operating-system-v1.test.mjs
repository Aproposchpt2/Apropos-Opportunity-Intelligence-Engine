import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const text = async path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('AADP migration extends rather than replaces Command Center', async () => {
  const sql = await text('supabase/migrations/20260726010000_aadp_operating_system_v1.sql');
  assert.match(sql, /alter table public\.command_runs add column if not exists/);
  assert.doesNotMatch(sql, /drop table\s+public\.command_runs/i);
  for (const table of [
    'command_definitions','command_tasks','command_task_dependencies','command_task_attempts','publisher_registry',
    'publisher_assignments','acquisition_runs','acquisition_raw_records','acquisition_record_dispositions',
    'acquisition_rejections','procurement_language_analysis','aoie_batch_reviews','aoie_change_recommendations',
    'executive_run_reports'
  ]) assert.match(sql, new RegExp(`create table if not exists public\\.${table}`));
});

test('AADP task and run states are complete', async () => {
  const sql = await text('supabase/migrations/20260726010000_aadp_operating_system_v1.sql');
  for (const state of ['CREATED','AUTHORIZED','QUEUED','RUNNING','PAUSED','PARTIALLY_COMPLETE','COMPLETED','FAILED','CANCELLED','ESCALATED']) assert.match(sql, new RegExp(`'${state}'`));
  for (const state of ['BLOCKED','READY','ASSIGNED','RETRY_PENDING']) assert.match(sql, new RegExp(`'${state}'`));
});

test('task completion requires results and evidence', async () => {
  const sql = await text('supabase/migrations/20260726010000_aadp_operating_system_v1.sql');
  const service = await text('supabase/functions/_shared/aadp.ts');
  assert.match(sql, /state <> 'COMPLETED'.*measurable_result/s);
  assert.match(service, /Task completion requires measurable result and execution evidence/);
});

test('raw acquisition stays separate and qualification is PostgreSQL authoritative', async () => {
  const sql = await text('supabase/migrations/20260726010000_aadp_operating_system_v1.sql');
  assert.match(sql, /create table if not exists public\.acquisition_raw_records/);
  assert.match(sql, /create or replace function public\.aadp_qualify_raw_record/);
  assert.match(sql, /MISSING_CONTRACT_REQUIREMENTS/);
  assert.match(sql, /MISSING_CONTRACT_CONTACT/);
  assert.match(sql, /v_disposition := 'QUALIFIED'/);
});

test('reconciliation fails unexplained variance', async () => {
  const sql = await text('supabase/migrations/20260726010000_aadp_operating_system_v1.sql');
  assert.match(sql, /v_acquired <> v_disposed/);
  assert.match(sql, /AADP reconciliation failed/);
});

test('AOIE recommendations cannot auto-apply to production', async () => {
  const sql = await text('supabase/migrations/20260726010000_aadp_operating_system_v1.sql');
  assert.match(sql, /production_applied boolean not null default false check \(production_applied = false\)/);
  for (const state of ['OBSERVATION','RESEARCH_CANDIDATE','TEST_CANDIDATE','RECOMMENDED_UPDATE','APPROVED_UPDATE','REJECTED_UPDATE']) assert.match(sql, new RegExp(`'${state}'`));
});

test('orchestrator is assignment-scoped and idempotent', async () => {
  const code = await text('supabase/functions/command-aadp-run/index.ts');
  assert.match(code, /assignment_id is required/);
  assert.match(code, /idempotency_key/);
  assert.match(code, /idempotent_replay/);
  assert.match(code, /createTaskGraph/);
  assert.match(code, /runAadpTask/);
});
