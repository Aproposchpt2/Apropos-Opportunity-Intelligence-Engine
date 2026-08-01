import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const text = async path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('VAR privileged RPC migration closes anonymous and authenticated execution', async () => {
  const sql = await text('supabase/migrations/20260731133000_var_cycle2_privileged_rpc_boundary.sql');
  for (const fn of ['natcorp_create_business_discovery_command','natcorp_record_business_discovery_candidates','natcorp_select_business_discovery_candidate','natcorp_disposition_candidate','natcorp_build_business_dna','natcorp_get_contract_dna','command_bind_mission_run']) assert.match(sql, new RegExp(fn));
  assert.match(sql, /revoke execute on function %s from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function %s to service_role/i);
});

test('executive status emits timestamped procurement health evidence without OTP projection', async () => {
  const fn = await text('supabase/functions/command-executive-status/index.ts');
  for (const key of ['database','command_runtime','connector_health','publisher_registry','acquisition','scheduler','lifecycle_apply']) assert.match(fn, new RegExp(`${key}:`));
  assert.match(fn, /observed_at/);
  assert.match(fn, /source:/);
  assert.match(fn, /system_status\.connector_health/);
  assert.match(fn, /publisher_registry\?select=/);
  assert.doesNotMatch(fn,/natcorp_otf|otf_|business_discovery_commands/i);
});

test('Executive UI consumes health evidence instead of manufacturing Connected or Healthy', async () => {
  const js = await text('assets/executive-command-center.js');
  assert.match(js, /d\.health/);
  assert.match(js, /healthCard/);
  assert.doesNotMatch(js, /\['Database','Connected'\]/);
  assert.doesNotMatch(js, /CONFIG\.anonKey\?'Connected'/);
});

test('final Executive modules are first-class procurement operations surfaces', async () => {
  const html = await text('index.html');
  const ids = ['eccTaskConfiguration','eccPublisherRegistry','eccAcquisitionOps','eccProcurementInventory','eccSchedules','eccActionRequired','eccLifecycle','eccHealth','eccAuditHistory','eccDeliverables','eccNotifications'];
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`));
  for (const label of ['Publisher Directory','Acquisition Operations','Procurement Inventory','Mission History','Completed Mission Outcomes']) assert.match(html, new RegExp(label, 'i'));
  for(const removed of ['NAT-CORP Delivery','OTP Monitoring','Estimated Runtime','Mission Confidence']) assert.doesNotMatch(html,new RegExp(removed,'i'));
});

test('legacy command status performs live provider validation and returns health evidence', async () => {
  const fn = await text('supabase/functions/command-status/index.ts');
  assert.match(fn, /api\.openai\.com\/v1\/models/);
  assert.match(fn, /api\.anthropic\.com\/v1\/models/);
  assert.match(fn, /provider_test/);
  assert.match(fn, /const health=/);
});
