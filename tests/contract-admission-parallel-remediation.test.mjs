import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(
  new URL('../supabase/migrations/20260725222000_contract_admission_parallel_remediation_v1.sql', import.meta.url),
  'utf8',
);
const hardening = await readFile(
  new URL('../supabase/migrations/20260725223000_contract_admission_runtime_hardening_v1.sql', import.meta.url),
  'utf8',
);

test('adds required FK covering indexes without duplicating rejection evaluation index', () => {
  for (const token of [
    'admitted_contracts_contact_evidence_id_idx',
    'admitted_contracts_official_source_evidence_id_idx',
    'admitted_contracts_policy_id_idx',
    'admitted_contracts_scope_evidence_id_idx',
    'admitted_contracts_superseded_by_id_idx',
    'apios_natcorp_delivery_v2_evaluation_id_idx',
    'apios_natcorp_delivery_v2_policy_id_idx',
    'contract_admission_evaluations_policy_id_idx',
    'contract_admission_events_admitted_contract_id_idx',
    'contract_admission_events_evaluation_id_idx',
    'contract_admission_events_policy_id_idx',
    'contract_admission_review_candidate_id_idx',
    'contract_admission_review_evaluation_id_idx',
    'contract_evidence_references_evaluation_id_idx',
    'contract_rejection_ledger_policy_id_idx',
    'contract_rejection_ledger_superseded_eval_id_idx',
    'piee_document_sources_opportunity_id_idx',
    'piee_document_sources_profile_id_idx',
    'piee_solicitation_profiles_opportunity_id_idx',
  ]) assert.match(migration, new RegExp(token));
  assert.doesNotMatch(migration, /create index[^;]+contract_rejection_ledger\(evaluation_id\)/is);
});

test('keeps direct browser roles fail closed', () => {
  for (const role of ['public', 'anon', 'authenticated']) {
    assert.match(migration, new RegExp(`revoke all[\\s\\S]+from ${role}`, 'i'));
  }
  assert.match(migration, /grant execute[\s\S]+to service_role/i);
  assert.match(migration, /security_invoker=true/);
});

test('fallback fails closed for malformed JSON and mandatory exclusions', () => {
  assert.match(migration, /apios_jsonb_nonempty_array/);
  assert.match(migration, /apios_jsonb_substantive_requirements/);
  for (const token of [
    'contact_email', 'contact_phone', 'description', 'requirements', 'official_source_url',
    'document_urls', 'response_deadline', 'duplicate_of', 'is_latest_version', 'qa_status',
    'document%access%fail', 'customer%release%fail', 'extraction%review%required',
  ]) assert.match(migration, new RegExp(token.replaceAll('%', '%'), 'i'));
});

test('hardens evaluator evidence, deadline, and idempotency logic', () => {
  assert.match(hardening, /extensions\.digest/);
  assert.match(hardening, /ISSUING_ORGANIZATION/);
  assert.match(hardening, /CONTACT_NOT_VERIFIABLE/);
  assert.match(hardening, /REQUIREMENTS_NOT_EXTRACTABLE/);
  assert.match(hardening, /open_continuous/);
  assert.match(hardening, /evidence_set_fingerprint/);
  assert.match(hardening, /on conflict \(evaluation_id\) do nothing/i);
  assert.match(hardening, /contract_review_one_active_evaluation_idx/);
});

test('delivery publication and removal are idempotent and admitted-only', () => {
  assert.match(hardening, /from public\.admitted_contracts_current/);
  assert.match(hardening, /pg_advisory_xact_lock/);
  assert.match(hardening, /DELIVERY_PUBLISHED/);
  assert.match(hardening, /DELIVERY_REMOVED/);
  assert.match(hardening, /request_fingerprint/);
});
