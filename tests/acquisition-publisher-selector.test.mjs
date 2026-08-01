import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const text=async p=>readFile(new URL(`../${p}`,import.meta.url),'utf8');

test('Acquisition Discovery exposes a state-dependent Publishing Agency selector',async()=>{
  const launch=await text('assets/executive-launch.js');
  const core=await text('assets/executive-core.js');
  assert.match(launch,/Publishing Agency<select id="eccPublisher"/);
  assert.match(launch,/command-publisher-options/);
  assert.match(launch,/missionType==='ACQUISITION_DISCOVERY'/);
  assert.match(launch,/publisher_id:publisherId/);
  assert.match(launch,/assignment_id:assignmentId/);
  assert.match(launch,/command-acquisition-mission/);
  assert.match(core,/command-publisher-options/);
  assert.match(core,/command-acquisition-mission/);
});

test('Publisher options include only approved verified state publishers and expose readiness',async()=>{
  const fn=await text('supabase/functions/command-publisher-options/index.ts');
  assert.match(fn,/state_code=eq\./);
  assert.match(fn,/verified=eq\.true/);
  assert.match(fn,/access_status=eq\.APPROVED_FOR_REGISTRY/);
  assert.match(fn,/assignment_status/);
  assert.match(fn,/selectable:txt\(a\?\.status\)\.toUpperCase\(\)==='READY'/);
});

test('Acquisition mission is bound to the selected publisher and READY assignment',async()=>{
  const fn=await text('supabase/functions/command-acquisition-mission/index.ts');
  assert.match(fn,/publisher_id=eq\./);
  assert.match(fn,/state_code=eq\./);
  assert.match(fn,/verified=eq\.true/);
  assert.match(fn,/access_status=eq\.APPROVED_FOR_REGISTRY/);
  assert.match(fn,/status=eq\.READY/);
  assert.match(fn,/publisher_bound:true/);
  assert.match(fn,/Operator authorized publisher-specific Acquisition Discovery/);
  assert.doesNotMatch(fn,/LATEST_READY_VERIFIED_PUBLISHER/);
});
