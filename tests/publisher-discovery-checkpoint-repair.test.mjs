import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workerPath = new URL('../netlify/functions/command-publisher-expansion-worker-background.js', import.meta.url);
const missionControlPath = new URL('../netlify/functions/command-mission-control.js', import.meta.url);

test('publisher discovery runs one entity class per background invocation', async () => {
  const source = await readFile(workerPath, 'utf8');
  assert.match(source, /ONE_ENTITY_CLASS_PER_BACKGROUND_INVOCATION/);
  assert.match(source, /unit_index/);
  assert.match(source, /dispatchNext/);
  assert.doesNotMatch(source, /for \(let index = 0; index < plan\.length; index\+\+\)/);
});

test('publisher discovery chain supports authenticated continuation and resume', async () => {
  const source = await readFile(workerPath, 'utf8');
  assert.match(source, /PUBLISHER_CHAIN_TOKEN/);
  assert.match(source, /x-publisher-chain-token/);
  assert.match(source, /firstUnfinishedIndex/);
});

test('mission control blocks duplicate active county discovery runs', async () => {
  const source = await readFile(missionControlPath, 'utf8');
  assert.match(source, /COUNTY_DISCOVERY_ALREADY_ACTIVE/);
  assert.match(source, /findActiveCountyDiscovery/);
});
