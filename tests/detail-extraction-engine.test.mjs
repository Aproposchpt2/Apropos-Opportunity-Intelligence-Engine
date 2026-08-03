import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const text=p=>readFile(new URL(`../${p}`,import.meta.url),'utf8');

test('single publisher acquisition executes detail extraction before final qualification',async()=>{
  const worker=await text('netlify/functions/command-single-publisher-acquisition-background.js');
  assert.match(worker,/extractAcquisitionRun/);
  assert.match(worker,/INITIAL_QUALIFICATION_SCREEN/);
  assert.match(worker,/DETAIL_EXTRACTION/);
  assert.match(worker,/POSTGRES_QUALIFICATION_ROUTING/);
  assert.ok(worker.indexOf("current_stage:'DETAIL_EXTRACTION'")<worker.indexOf("current_stage:'POSTGRES_QUALIFICATION_ROUTING'"));
});

test('detail extraction enriches requirements contacts and documents',async()=>{
  const engine=await text('netlify/functions/_shared/detail-extraction-engine.js');
  assert.match(engine,/requirements_text/);
  assert.match(engine,/contact_email/);
  assert.match(engine,/contact_phone/);
  assert.match(engine,/submission_url/);
  assert.match(engine,/document_manifest/);
  assert.match(engine,/processing_status:'RAW'/);
});

test('standalone extraction worker supports controlled retries',async()=>{
  const fn=await text('netlify/functions/command-detail-extraction-background.js');
  assert.match(fn,/acquisition_run_id is required/);
  assert.match(fn,/extractAcquisitionRun/);
  assert.match(fn,/aadp_route_pending_raw_records/);
});
