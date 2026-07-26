import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(
  new URL('../supabase/migrations/20260725210000_admitted_delivery_control_v1.sql', import.meta.url),
  'utf8'
);

test('delivery feed v2 is sourced from admitted contracts', () => {
  assert.match(sql, /create table if not exists public\.apios_natcorp_delivery_feed_v2/i);
  assert.match(sql, /references public\.admitted_contracts\(admitted_contract_id\)/i);
  assert.match(sql, /from public\.admitted_contracts_current/i);
});

test('publish function fails closed when contract is not admitted', () => {
  assert.match(sql, /'NOT_ADMITTED'/i);
  assert.match(sql, /where admitted_contract_id=p_admitted_contract_id/i);
});

test('delivery publication is service-role only', () => {
  assert.match(sql, /revoke all on function public\.publish_admitted_contract_to_natcorp[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.publish_admitted_contract_to_natcorp[\s\S]*to service_role/i);
});

test('delivery removal is service-role only and requires a reason', () => {
  assert.match(sql, /at least one removal reason is required/i);
  assert.match(sql, /grant execute on function public\.remove_contract_from_natcorp_delivery[\s\S]*to service_role/i);
});

test('current delivery view excludes removed and expired rows', () => {
  assert.match(sql, /where d\.delivery_status='RELEASED'/i);
  assert.match(sql, /d\.expiration_timestamp is null or d\.expiration_timestamp>now\(\)/i);
});

test('command center metrics distinguish candidates, admissions, revocations, and delivery', () => {
  for (const field of [
    'candidate_count',
    'pending_evaluation_count',
    'rejected_evaluation_count',
    'current_admitted_count',
    'revoked_count',
    'current_natcorp_delivery_count'
  ]) assert.match(sql, new RegExp(field));
});
