import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const text=async path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const projection=await text('supabase/functions/command-publisher-discovery-status/index.ts');
const status=await text('supabase/functions/command-executive-status/index.ts');
const dashboard=await text('assets/executive-command-center.js');

test('Publisher Discovery projection reads authoritative discovery tables',()=>{
  assert.match(projection,/publisher_discovery_runs/);
  assert.match(projection,/publisher_discovery_candidates/);
  assert.doesNotMatch(projection,/command_discovery_runs/);
  assert.match(projection,/mission_type_key:'PUBLISHER_DISCOVERY'/);
});

test('Executive browser consumes publisher intelligence through unified status without a second polling dependency',()=>{
  assert.match(status,/publisher_registry\?select=/);
  assert.match(status,/publisher_registry:publishers/);
  assert.match(dashboard,/renderPublisherDirectory/);
  assert.match(dashboard,/d\.publisher_registry/);
  assert.doesNotMatch(dashboard,/invoke\('command-publisher-discovery-status'/);
});
