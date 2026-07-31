import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const text=async path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const projection=await text('supabase/functions/command-publisher-discovery-status/index.ts');
const core=await text('assets/executive-core.js');
const dashboard=await text('assets/executive-command-center.js');

test('Executive Publisher Discovery projection reads the authoritative publisher discovery tables',()=>{
  assert.match(projection,/publisher_discovery_runs/);
  assert.match(projection,/publisher_discovery_candidates/);
  assert.doesNotMatch(projection,/command_discovery_runs/);
  assert.doesNotMatch(projection,/command_discovery_candidates/);
  assert.match(projection,/mission_type_key:'PUBLISHER_DISCOVERY'/);
  assert.match(projection,/result_count:Number\(r\.publishers_presented\|\|0\)/);
  assert.match(projection,/source_verified:c\.official_source_verified===true/);
});

test('Executive browser loads authoritative Publisher Discovery projection without making it a hard dependency for the whole dashboard',()=>{
  assert.match(core,/command-publisher-discovery-status/);
  assert.match(dashboard,/invoke\('command-publisher-discovery-status'/);
  assert.match(dashboard,/Publisher Discovery status projection failed/);
  assert.match(dashboard,/data\.publisher_discovery=/);
});
