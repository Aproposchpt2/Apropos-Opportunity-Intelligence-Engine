import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const text = async (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const migrationPath = 'supabase/migrations/20260725220000_contract_admission_compatibility_idempotency_v1.sql';

test('CP4R hardening uses an explicit fixed extensions search path', async () => {
  const sql = await text(migrationPath);
  assert.match(sql, /alter function %s set search_path = public, extensions, pg_temp/i);
  for (const name of [
    'evaluate_contract_candidate',
    'promote_candidate_to_admitted_contract',
    'revoke_admitted_contract',
    'activate_contract_admission_policy',
    'publish_admitted_contract_to_natcorp',
    'remove_contract_from_natcorp_delivery'
  ]) {
    assert.match(sql, new RegExp(`'${name}'`));
  }
});

test('rejection ledger has one deterministic row per evaluation', async () => {
  const sql = await text(migrationPath);
  assert.match(sql, /partition by evaluation_id/i);
  assert.match(sql, /duplicate_rank > 1/i);
  assert.match(sql, /create unique index if not exists contract_rejection_evaluation_unique_idx\s+on public\.contract_rejection_ledger\(evaluation_id\)/i);
});

test('evaluator retains conflict-safe rejection insertion', async () => {
  const sql = await text('supabase/migrations/20260725200000_contract_admission_functions_v1.sql');
  assert.match(sql, /insert into public\.contract_rejection_ledger/i);
  assert.match(sql, /on conflict do nothing/i);
});

test('mandatory contact and admitted-only delivery controls remain present', async () => {
  const evaluator = await text('supabase/migrations/20260725200000_contract_admission_functions_v1.sql');
  const delivery = await text('supabase/migrations/20260725210000_admitted_delivery_control_v1.sql');
  assert.match(evaluator, /MISSING_CONTRACT_CONTACT/);
  assert.match(evaluator, /evidence_type='CONTACT'.*verification_status='VERIFIED'/s);
  assert.match(delivery, /admitted_contracts_current/);
  assert.doesNotMatch(delivery, /natcorp_release_status\s*=\s*'eligible'/i);
});
