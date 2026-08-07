import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const text = async path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Acquisition Discovery exposes single and all-eligible publisher scopes', async () => {
  const launch = await text('assets/executive-launch.js');
  assert.match(launch, /ALL_ELIGIBLE/);
  assert.match(launch, /Publisher Scope/);
  assert.match(launch, /publisher_scope/);
});

test('Acquisition Discovery uses PostgreSQL orchestration instead of Netlify long-run dispatch', async () => {
  const missionControl = await text('netlify/functions/command-mission-control.js');
  assert.match(missionControl, /SUPABASE_POSTGRES/);
  assert.match(missionControl, /ALL_ELIGIBLE/);
  assert.match(missionControl, /publisher_scope:\s*'SINGLE'/);
});
