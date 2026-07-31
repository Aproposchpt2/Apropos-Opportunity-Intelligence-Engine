import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('../supabase/migrations/20260731173000_var_cycle2_close_legacy_operator_rpc.sql', import.meta.url), 'utf8');

test('legacy command_is_operator helper is not browser-callable', () => {
  assert.match(sql, /revoke execute on function public\.command_is_operator\(\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.command_is_operator\(\) to service_role/i);
  assert.match(sql, /has_function_privilege\('anon'/i);
  assert.match(sql, /has_function_privilege\('authenticated'/i);
});
