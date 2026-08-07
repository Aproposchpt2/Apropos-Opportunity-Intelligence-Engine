import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const migration = readFileSync(new URL('../supabase/migrations/20260806040000_mission_report_lifecycle_source_of_truth_v2.sql', import.meta.url), 'utf8');
const rollback = readFileSync(new URL('../supabase/migrations/rollback/20260806040000_mission_report_lifecycle_source_of_truth_v2_rollback.sql', import.meta.url), 'utf8');

function sha(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function ledger() {
  const rows = [];
  return {
    insert(row) {
      assert.ok(['DRAFT', 'FINAL', 'AMENDED', 'SUPERSEDED'].includes(row.report_state));
      assert.ok(!rows.some(item => item.command_run_id === row.command_run_id && item.report_version === row.report_version), 'silent overwrite blocked');
      const prior = rows.find(item => item.command_run_id === row.command_run_id && item.report_version === row.report_version - 1);
      if (row.report_version > 1) {
        assert.ok(prior, 'immediately preceding immutable version required');
        assert.notEqual(row.report_hash, prior.report_hash, 'new version requires distinct hash');
        row = { ...row, supersedes_report_id: row.supersedes_report_id || prior.id };
      }
      rows.push(Object.freeze(structuredClone(row)));
      return rows.at(-1);
    },
    update() { throw new Error('immutable'); },
    delete() { throw new Error('immutable'); },
    rows
  };
}

test('migration SQL contains required identity fields and lifecycle states', () => {
  for (const field of ['report_id', 'command_run_id', 'report_version', 'report_state', 'operational_outcome', 'authoritative_run_status', 'report_data', 'report_hash', 'generated_at', 'finalized_at', 'supersedes_report_id', 'production_provenance']) {
    assert.match(migration, new RegExp(`\\b${field}\\b`));
  }
  for (const state of ['DRAFT', 'FINAL', 'AMENDED', 'SUPERSEDED']) assert.match(migration, new RegExp(`'${state}'`));
});

test('PostgreSQL migration and rollback pass static syntax contract checks', () => {
  for (const sql of [migration, rollback]) {
    assert.equal((sql.match(/\$\$/g) || []).length % 2, 0, 'dollar quotes balanced');
    assert.equal((sql.match(/\bbegin;/gi) || []).length, (sql.match(/\bcommit;/gi) || []).length, 'transaction boundaries balanced');
    assert.doesNotMatch(sql, /drop table\s+public\.mission_execution_reports/i);
  }
  assert.match(rollback, /Rollback blocked: DRAFT or SUPERSEDED report versions exist/);
});

test('unique run/version and immutable controls are present', () => {
  assert.match(migration, /mission_execution_reports_run_version_unique/);
  assert.match(migration, /before update or delete/i);
  assert.match(migration, /Mission execution reports are immutable/i);
  assert.match(migration, /distinct deterministic evidence hash/i);
});

test('executive-only read policy and service-role write boundary are present', () => {
  assert.match(migration, /mission_execution_reports_executive_read/);
  assert.match(migration, /in \('executive', 'owner'\)/);
  assert.match(migration, /grant select on table public\.mission_execution_reports to authenticated/i);
  assert.match(migration, /grant select, insert on table public\.mission_execution_reports to service_role/i);
  assert.match(migration, /revoke update, delete, truncate/i);
});

test('DRAFT Version 1 persists and FINAL Version 2 supersedes without mutation', () => {
  const store = ledger();
  const run = '3258d329-a84c-4598-8597-8ae163e4c628';
  const v1Data = { state: 'DRAFT', outcome: 'STALLED_AT_CAPTURE' };
  const v1 = store.insert({ id: 'v1', command_run_id: run, report_version: 1, report_state: 'DRAFT', report_hash: sha(v1Data), report_data: v1Data });
  const v1Snapshot = structuredClone(v1);
  const v2Data = { state: 'FINAL', outcome: 'COMPLETED', accepted: true };
  const v2 = store.insert({ id: 'v2', command_run_id: run, report_version: 2, report_state: 'FINAL', report_hash: sha(v2Data), report_data: v2Data });
  assert.equal(v2.supersedes_report_id, 'v1');
  assert.notEqual(v2.report_hash, v1.report_hash);
  assert.deepEqual(v1, v1Snapshot);
  assert.throws(() => store.update(v1), /immutable/);
  assert.throws(() => store.delete(v1), /immutable/);
});

test('silent overwrite is rejected', () => {
  const store = ledger();
  const row = { id: 'v1', command_run_id: 'run', report_version: 1, report_state: 'DRAFT', report_hash: sha({ a: 1 }), report_data: { a: 1 } };
  store.insert(row);
  assert.throws(() => store.insert({ ...row, id: 'replacement' }), /silent overwrite blocked/);
});
