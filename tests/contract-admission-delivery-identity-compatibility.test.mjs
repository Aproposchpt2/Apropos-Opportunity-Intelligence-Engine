import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const compatibilityPath = new URL(
  '../supabase/migrations/20260725222900_contract_admission_delivery_identity_compatibility_v1.sql',
  import.meta.url,
);
const runtimePath = new URL(
  '../supabase/migrations/20260725223000_contract_admission_runtime_hardening_v1.sql',
  import.meta.url,
);

const compatibilitySql = (await readFile(compatibilityPath, 'utf8')).toLowerCase();
const runtimeSql = (await readFile(runtimePath, 'utf8')).toLowerCase();

test('catalog inspection distinguishes constraint-backed and independent index states', () => {
  for (const catalog of ['pg_catalog.pg_constraint', 'pg_catalog.pg_class', 'pg_catalog.pg_namespace', 'pg_catalog.pg_index', 'pg_catalog.pg_depend']) {
    assert.match(compatibilitySql, new RegExp(catalog.replaceAll('.', '\\.')));
  }
  assert.match(compatibilitySql, /alter table public\.apios_natcorp_delivery_feed_v2\s+drop constraint if exists/);
  assert.match(compatibilitySql, /drop index if exists public\.apios_natcorp_delivery_feed_v_admitted_contract_id_business_key/);
  assert.doesNotMatch(compatibilitySql, /cascade/);
});

test('migration fails closed on existing null-safe delivery duplicates', () => {
  assert.match(compatibilitySql, /coalesce\(business_profile_id,'00000000-0000-0000-0000-000000000000'::uuid\)/);
  assert.match(compatibilitySql, /coalesce\(match_id,'00000000-0000-0000-0000-000000000000'::uuid\)/);
  assert.match(compatibilitySql, /having count\(\*\) > 1/);
  assert.match(compatibilitySql, /raise exception/);
  assert.match(compatibilitySql, /no delivery rows were changed/);
});

test('runtime migration creates the replacement null-safe identity idempotently', () => {
  assert.match(runtimeSql, /create unique index if not exists apios_natcorp_delivery_v2_identity_unique_idx/);
  assert.match(runtimeSql, /coalesce\(business_profile_id,'00000000-0000-0000-0000-000000000000'::uuid\)/);
  assert.match(runtimeSql, /coalesce\(match_id,'00000000-0000-0000-0000-000000000000'::uuid\)/);
});

test('compatibility migration safely permits constraint, index, absent, and replay states', () => {
  assert.match(compatibilitySql, /if v_constraint_exists then/);
  assert.match(compatibilitySql, /if v_independent_index_exists then/);
  assert.match(compatibilitySql, /drop constraint if exists/);
  assert.match(compatibilitySql, /drop index if exists/);
  assert.doesNotMatch(compatibilitySql, /delete\s+from\s+public\.apios_natcorp_delivery_feed_v2/);
  assert.doesNotMatch(compatibilitySql, /truncate\s+public\.apios_natcorp_delivery_feed_v2/);
});
