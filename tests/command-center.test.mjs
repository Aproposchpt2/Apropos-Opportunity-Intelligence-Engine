import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const text=async path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('root index is the procurement intelligence operations center',async()=>{
  const html=await text('index.html');
  for(const label of ['Procurement Intelligence Operations Center','MISSION READINESS','MISSION PRE-FLIGHT','MISSION CONFIGURATION','AI PROVIDER CONFIGURATION','PUBLISHER CONFIGURATION','MISSION ESTIMATE','MISSION LAUNCH','LIVE MISSION TIMELINE','COMPLETED MISSIONS','EXECUTIVE ALERTS','BEGIN DAILY OPERATIONS','AGENT STATUS']) assert.match(html,new RegExp(label,'i'));
});

test('pre-flight exposes required controls and five-step validation',async()=>{
  const html=await text('index.html');
  for(const id of ['missionName','missionType','missionScope','missionOperator','providerSelect','testProviderButton','publisherState','organizationType','publisherSelect','publisherQueue','missionConfidence','readinessStatus','beginButton']) assert.match(html,new RegExp(`id="${id}"`));
  for(const provider of ['OpenAI','Anthropic','Manual']) assert.match(html,new RegExp(provider));
  assert.match(html,/id="beginButton"[^>]*disabled/);
});

test('mission orchestration enforces validation, maximum batch, estimates, and official record',async()=>{
  const js=await text('assets/command-center.js');
  assert.match(js,/maxPublishers:5/);
  assert.match(js,/state\.selected\.includes\(id\)/);
  assert.match(js,/state\.selected\.length>=5/);
  assert.match(js,/provider:state\.provider/);
  assert.match(js,/publishers:state\.selected/);
  assert.match(js,/mission_readiness:r\.score/);
  assert.match(js,/validation:r\.checks/);
  assert.match(js,/testProvider/);
  assert.doesNotMatch(js,/if\s*\(.*anthropic.*\).*write/i);
});

test('operations center invokes required command functions',async()=>{
  const js=await text('assets/command-center.js');
  for(const name of ['command-begin-daily-operations','command-status','command-resume','command-stop']) assert.match(js,new RegExp(name));
});

test('migration creates seven RLS tables',async()=>{
  const sql=await text('supabase/migrations/20260723230000_command_center.sql');
  for(const table of ['command_runs','command_jobs','command_events','command_failures','command_metrics','daily_executive_briefs','system_status']){assert.match(sql,new RegExp(`create table if not exists public\\.${table}`));assert.match(sql,new RegExp(`alter table public\\.${table} enable row level security`));}
});

test('orchestrator owns sequential five-agent progression',async()=>{
  const shared=await text('supabase/functions/_shared/command.ts');
  const orchestrator=await text('supabase/functions/command-begin-daily-operations/index.ts');
  assert.equal((shared.match(/functionName: 'agent-/g)||[]).length,5);
  assert.match(orchestrator,/for \(const agent of AGENT_SEQUENCE\)/);
  assert.match(orchestrator,/max_attempts/);
  assert.match(orchestrator,/idempotencyKey/);
});

test('browser assets contain no server secrets',async()=>{
  const files=[await text('index.html'),await text('assets/command-center.js'),await text('assets/command-center.css')].join('\n');
  assert.doesNotMatch(files,/service_role|SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY/i);
});