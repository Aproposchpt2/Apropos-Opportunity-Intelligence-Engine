import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const core = await readFile(new URL('../assets/executive-core.js', import.meta.url), 'utf8');
const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const netlify = await readFile(new URL('../netlify.toml', import.meta.url), 'utf8');

test('Executive operational control bypasses the failing Netlify proxy layer', () => {
  for (const fn of [
    'command-mission-control',
    'command-executive-status',
    'command-mission-status',
    'command-aadp-publisher-candidate-review',
    'command-stop',
    'command-resume'
  ]) {
    assert.match(core, new RegExp(`['"]${fn}['"]`));
  }
  assert.match(core, /\$\{cfg\.supabaseUrl\}\/functions\/v1\/\$\{name\}/);
  assert.match(core, /apikey:cfg\.anonKey/);
  assert.match(core, /Authorization:`Bearer \$\{cfg\.anonKey/);
});

test('Only non-operational auth/provider helpers remain on Netlify functions', () => {
  assert.match(core, /auth:'auth'/);
  assert.match(core, /'provider-health':'provider-health'/);
  assert.doesNotMatch(core, /'command-executive-status':'command-status'/);
  assert.doesNotMatch(core, /'command-mission-control':'command'/);
});

test('Browser-safe runtime config and CSP support direct Supabase Edge calls', () => {
  assert.match(index, /assets\/runtime-config\.js/);
  assert.match(netlify, /connect-src 'self' https:\/\/judislfknmhofcgzyozc\.supabase\.co/);
});

test('Executive transport fails bounded rather than hanging indefinitely', () => {
  assert.match(core, /AbortSignal\.timeout\(15000\)/);
  assert.match(core, /transport unavailable/);
});
