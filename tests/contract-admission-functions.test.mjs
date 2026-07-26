import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(
  new URL('../supabase/migrations/20260725200000_contract_admission_functions_v1.sql', import.meta.url),
  'utf8'
);

const privilegedFunctions = [
  'evaluate_contract_candidate',
  'promote_candidate_to_admitted_contract',
  'revoke_admitted_contract',
  'activate_contract_admission_policy',
  'is_contract_currently_admitted',
  'get_current_admitted_contract'
];

test('privileged admission functions exist', () => {
  for (const fn of privilegedFunctions) {
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}\\(`, 'i'));
  }
});

test('privileged functions use fixed secure search path', () => {
  const occurrences = sql.match(/security definer[\s\S]*?set search_path = public, pg_temp/gi) || [];
  assert.ok(occurrences.length >= privilegedFunctions.length);
});

test('public, anon, and authenticated execution are revoked', () => {
  for (const fn of privilegedFunctions) {
    assert.match(
      sql,
      new RegExp(`revoke all on function public\\.${fn}\\([\\s\\S]*?from public, anon, authenticated`, 'i')
    );
  }
});

test('service-role execution is explicitly granted', () => {
  for (const fn of privilegedFunctions) {
    assert.match(
      sql,
      new RegExp(`grant execute on function public\\.${fn}\\([\\s\\S]*?to service_role`, 'i')
    );
  }
});

test('promotion does not accept caller supplied evidence truth values', () => {
  assert.doesNotMatch(sql, /p_contact_verified|p_requirements_verified|p_scope_verified|p_official_source_verified/i);
});

test('promotion is idempotent and serialized', () => {
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /idempotent',true/i);
});

test('revocation preserves historical admission and records an event', () => {
  assert.match(sql, /update public\.admitted_contracts set admission_status='REVOKED'/i);
  assert.match(sql, /'ADMISSION_REVOKED'/i);
  assert.doesNotMatch(sql, /delete\s+from\s+public\.admitted_contracts/i);
});

test('evaluation requires verified evidence and rejects missing mandatory fields', () => {
  for (const code of [
    'MISSING_CONTRACT_CONTACT',
    'MISSING_CONTRACT_REQUIREMENTS',
    'MISSING_SCOPE_OF_WORK',
    'UNVERIFIED_OFFICIAL_SOURCE'
  ]) assert.match(sql, new RegExp(code));

  assert.match(sql, /verification_status='VERIFIED'/i);
});
