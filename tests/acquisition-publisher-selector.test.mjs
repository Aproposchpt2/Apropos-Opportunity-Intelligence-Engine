import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const text=async p=>readFile(new URL(`../${p}`,import.meta.url),'utf8');

test('Acquisition Discovery exposes a state-dependent Publishing Agency selector',async()=>{
  const launch=await text('assets/executive-launch.js');
  const core=await text('assets/executive-core.js');
  assert.match(launch,/ACQUISITION_DISCOVERY:\{agent:'Acquisition Operations'.*publisher:true/);
  assert.match(launch,/Publishing Agency<select id="eccPublisher"/);
  assert.match(launch,/command-publisher-options/);
  assert.match(launch,/cfg\.publisher_id=publisher\.value/);
  assert.match(launch,/command-acquisition-mission/);
  assert.match(core,/command-publisher-options/);
  assert.match(core,/command-acquisition-mission/);
});

test('Publisher options expose state publisher access intelligence without operator onboarding',async()=>{
  const fn=await text('supabase/functions/command-publisher-options/index.ts');
  assert.match(fn,/state_code=eq\./);
  assert.match(fn,/acquisition_method/);
  assert.match(fn,/search_endpoint/);
  assert.match(fn,/access_status/);
  assert.match(fn,/selectable:Boolean/);
  assert.doesNotMatch(fn,/assignment_status/);
  assert.doesNotMatch(fn,/APPROVED_FOR_REGISTRY/);
});

test('Acquisition mission auto-resolves assignment and engine for selected publisher',async()=>{
  const fn=await text('supabase/functions/command-acquisition-mission/index.ts');
  assert.match(fn,/publisher_id=eq\./);
  assert.match(fn,/state_code=eq\./);
  assert.match(fn,/APIE_AUTOMATED_TASK_CONFIGURATION/);
  assert.match(fn,/assignment_generated_automatically:true/);
  assert.match(fn,/engineFor\(method\)/);
  assert.match(fn,/command-aadp-run/);
  assert.doesNotMatch(fn,/LATEST_READY_VERIFIED_PUBLISHER/);
  assert.doesNotMatch(fn,/APPROVED_FOR_REGISTRY/);
});
