import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = {
  orchestrator: await readFile(new URL('../netlify/functions/apios-admission-orchestrator.mjs', import.meta.url), 'utf8'),
  aoie: await readFile(new URL('../netlify/functions/aoie-admitted-contracts.mjs', import.meta.url), 'utf8'),
  delivery: await readFile(new URL('../netlify/functions/natcorp-admitted-delivery.mjs', import.meta.url), 'utf8'),
  analyzeFit: await readFile(new URL('../netlify/functions/analyze-fit-admitted.mjs', import.meta.url), 'utf8')
};

test('orchestrator invokes evaluation before promotion', () => {
  const evaluation = files.orchestrator.indexOf("rpc('evaluate_contract_candidate'");
  const promotion = files.orchestrator.indexOf("rpc('promote_candidate_to_admitted_contract'");
  assert.ok(evaluation >= 0);
  assert.ok(promotion > evaluation);
});

test('AOIE entry point requires admitted_contract_id and admitted-only lookup', () => {
  assert.match(files.aoie, /ADMITTED_CONTRACT_ID_REQUIRED/);
  assert.match(files.aoie, /getAoieAdmittedCandidate/);
  assert.doesNotMatch(files.aoie, /state_contract_opportunities/);
});

test('NAT-CORP entry point requires admitted delivery authorization', () => {
  assert.match(files.delivery, /ADMITTED_CONTRACT_ID_REQUIRED/);
  assert.match(files.delivery, /getNatcorpAuthorizedDelivery/);
  assert.match(files.delivery, /DELIVERY_NOT_AUTHORIZED/);
  assert.doesNotMatch(files.delivery, /natcorp_release_status/);
});

test('Analyze Fit requires admitted contract and business profile', () => {
  assert.match(files.analyzeFit, /ADMITTED_CONTRACT_ID_REQUIRED/);
  assert.match(files.analyzeFit, /BUSINESS_PROFILE_ID_REQUIRED/);
  assert.match(files.analyzeFit, /validateAnalyzeFitAdmission/);
});

test('Analyze Fit denies mandatory admission failures', () => {
  for (const code of [
    'NOT_ADMITTED',
    'ADMISSION_REVOKED',
    'CONTRACT_EXPIRED',
    'CONTACT_EVIDENCE_INVALID',
    'SCOPE_EVIDENCE_INVALID',
    'REQUIREMENTS_EVIDENCE_INVALID'
  ]) assert.match(files.analyzeFit, new RegExp(code));
});

test('all entry points keep service credentials server-side', () => {
  for (const source of Object.values(files)) {
    assert.match(source, /process\.env\.SUPABASE_SERVICE_ROLE_KEY/);
    assert.doesNotMatch(source, /window\.|localStorage|sessionStorage/);
  }
});
