import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const text = async (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

test('caleprocure batch script uses valid partial completion states', async () => {
  const script = await text('scripts/acquire-caleprocure-package-batch.mjs');
  assert.match(script, /status:failed\.length\?\(completed\.length\?'PARTIALLY_COMPLETE':'FAILED'\):'COMPLETED'/);
  assert.match(script, /status:failed\.length\?\(completed\.length\?'completed_with_failures':'failed'\):'completed'/);
  assert.match(script, /aadp_state:failed\.length\?\(completed\.length\?'PARTIALLY_COMPLETE':'FAILED'\):'COMPLETED'/);
  assert.doesNotMatch(script, /aadp_state:failed\.length\?\(completed\.length\?'PARTIAL':'FAILED'\):'COMPLETED'/);
});
