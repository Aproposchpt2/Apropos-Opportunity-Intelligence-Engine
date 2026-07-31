import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const text = async path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('root index is the internal Executive Command Center', async () => {
  const html = await text('index.html');
  for (const label of [
    'Executive Command Center','State Operations Context','Authorize & Execute','Active Mission Monitors',
    'Publisher Discovery','Publisher Registry','Acquisition Operations','Procurement Inventory','NAT-CORP Delivery',
    'Recurring Automation','Action Required','Lifecycle Control','System Health','Audit / History','Deliverables / Results','Operational Notifications'
  ]) assert.match(html, new RegExp(label, 'i'));
  assert.match(html, /Internal APROPOS operations/i);
  assert.match(html, /id="gatePassword"/);
  assert.match(html, /noindex,nofollow/i);
});

test('Executive dashboard invokes governed command functions', async () => {
  const core = await text('assets/executive-core.js');
  const launch = await text('assets/executive-launch.js');
  const dashboard = await text('assets/executive-command-center.js');
  assert.match(core, /command-executive-status/);
  assert.match(launch, /command-mission-control/);
  assert.match(dashboard, /command-executive-status/);
  assert.match(core, /x-dashboard-password/);
});

test('migration creates seven RLS command-center tables', async () => {
  const sql = await text('supabase/migrations/20260723230000_command_center.sql');
  for (const table of ['command_runs','command_jobs','command_events','command_failures','command_metrics','daily_executive_briefs','system_status']) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
  }
});

test('orchestrator owns sequential five-agent progression', async () => {
  const shared = await text('supabase/functions/_shared/command.ts');
  const orchestrator = await text('supabase/functions/command-begin-daily-operations/index.ts');
  assert.equal((shared.match(/functionName: 'agent-/g) || []).length, 5);
  assert.match(orchestrator, /for \(const agent of AGENT_SEQUENCE\)/);
  assert.match(orchestrator, /max_attempts/);
  assert.match(orchestrator, /idempotencyKey/);
});

test('browser assets contain no service role secret', async () => {
  const files = [
    await text('index.html'),
    await text('assets/executive-core.js'),
    await text('assets/executive-command-center.js'),
    await text('assets/executive-launch.js'),
    await text('assets/mission-workspace.js')
  ].join('\n');
  assert.doesNotMatch(files, /service_role|SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY/i);
});
