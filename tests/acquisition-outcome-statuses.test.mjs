import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const text=async p=>readFile(new URL(`../${p}`,import.meta.url),'utf8');

test('single publisher worker separates execution state from business outcomes',async()=>{
  const worker=await text('netlify/functions/command-single-publisher-acquisition-background.js');
  assert.match(worker,/aadp_state:'COMPLETED'/);
  assert.match(worker,/reconciliation_status:reconciliationStatus/);
  assert.match(worker,/qualification_status:qualificationStatus/);
  assert.match(worker,/validation_status:validationStatus/);
  assert.match(worker,/status:countMatches\?'COMPLETED':'PARTIALLY_COMPLETE'/);
  assert.doesNotMatch(worker,/status = countMatches === false \? 'PARTIAL'/);
});

test('acquisition mission records reconciliation diagnostics and acceptance evidence',async()=>{
  const worker=await text('netlify/functions/command-single-publisher-acquisition-background.js');
  assert.match(worker,/missing_from_previous_snapshot/);
  assert.match(worker,/connector_acceptance_registry/);
  assert.match(worker,/qualification_summary:routing/);
  assert.match(worker,/reconciliation_diagnostics:diagnostics/);
});
