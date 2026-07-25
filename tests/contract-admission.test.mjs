import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const text = async path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('migration creates governed Zone B and Zone C objects', async () => {
  const sql = await text('supabase/migrations/20260725190000_contract_admission_v1.sql');
  for (const object of [
    'contract_admission_policy_versions',
    'contract_admission_evaluations',
    'contract_rejection_ledger',
    'contract_admission_review_queue',
    'contract_evidence_references',
    'admitted_contracts',
    'contract_admission_events'
  ]) assert.match(sql, new RegExp(`create table if not exists public\\.${object}`));
});

test('candidate key uses authoritative uuid type', async () => {
  const sql = await text('supabase/migrations/20260725190000_contract_admission_v1.sql');
  assert.match(sql, /candidate_opportunity_id uuid not null references public\.state_contract_opportunities\(id\)/);
});

test('policy seed is approved but not active', async () => {
  const sql = await text('supabase/migrations/20260725190000_contract_admission_v1.sql');
  assert.match(sql, /'1\.0','APROPOS Contract Admission Policy','APPROVED'/);
  assert.doesNotMatch(sql, /'1\.0','APROPOS Contract Admission Policy','ACTIVE'/);
});

test('mandatory rejection vocabulary is present', async () => {
  const sql = await text('supabase/migrations/20260725190000_contract_admission_v1.sql');
  for (const code of [
    'MISSING_CONTRACT_CONTACT','MISSING_CONTRACT_REQUIREMENTS','MISSING_SCOPE_OF_WORK',
    'INACCESSIBLE_SOLICITATION_PACKAGE','UNVERIFIED_OFFICIAL_SOURCE','CONTACT_NOT_VERIFIABLE'
  ]) assert.match(sql, new RegExp(code));
});

test('all admission tables have RLS and browser writes are revoked', async () => {
  const sql = await text('supabase/migrations/20260725190000_contract_admission_v1.sql');
  for (const table of [
    'contract_admission_policy_versions','contract_admission_evaluations','contract_evidence_references',
    'contract_rejection_ledger','contract_admission_review_queue','admitted_contracts','contract_admission_events'
  ]) assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
  assert.match(sql, /revoke all on[\s\S]*from anon, authenticated;/);
});

test('current admitted view excludes revoked, closed, and expired contracts', async () => {
  const sql = await text('supabase/migrations/20260725190000_contract_admission_v1.sql');
  assert.match(sql, /a\.admission_status='ADMITTED'/);
  assert.match(sql, /a\.revoked_at is null/);
  assert.match(sql, /lower\(a\.lifecycle_status\)='open'/);
  assert.match(sql, /a\.response_deadline>now\(\)/);
});

test('rollback preserves evidence and removes downstream views', async () => {
  const sql = await text('supabase/rollback/20260725190000_contract_admission_v1_rollback.sql');
  assert.match(sql, /drop view if exists public\.aoie_admitted_contract_candidates_v1/);
  assert.match(sql, /drop view if exists public\.admitted_contracts_current/);
  assert.doesNotMatch(sql, /drop table/i);
});
