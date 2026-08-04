import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveConnector, listConnectorKeys } from '../netlify/functions/_shared/acquisition-connectors/index.js';

const connectorPath = new URL('../netlify/functions/_shared/acquisition-connectors/agent-public-source-discovery.js', import.meta.url);
const optionsPath = new URL('../netlify/functions/command-publisher-options.js', import.meta.url);
const dashboardPath = new URL('../assets/executive-launch.js', import.meta.url);

test('minimum-access public-source connector is registered explicitly', () => {
  assert.ok(listConnectorKeys().includes('AGENT_PUBLIC_SOURCE_DISCOVERY'));
  const connector = resolveConnector({
    publisher: { publisher_name: 'Prepared Public Source' },
    assignment: { search_parameters: { connector_key: 'AGENT_PUBLIC_SOURCE_DISCOVERY' } }
  });
  assert.equal(connector.key, 'AGENT_PUBLIC_SOURCE_DISCOVERY');
  assert.equal(typeof connector.verify, 'function');
  assert.equal(typeof connector.acquire, 'function');
});

test('targeted agent connector enforces cost and access controls', async () => {
  const source = await readFile(connectorPath, 'utf8');
  assert.match(source, /max_tool_calls:\s*2/);
  assert.match(source, /search_context_size:\s*'low'/);
  assert.match(source, /Math\.min\(requested,\s*20\)/);
  assert.match(source, /Do not log in, register, submit forms, bypass access controls/);
  assert.match(source, /acquisition_command_instruction/);
  assert.match(source, /official_source_verified/);
});

test('publisher selector exposes prepared targets but preserves EAG-001 gate', async () => {
  const optionsSource = await readFile(optionsPath, 'utf8');
  const dashboardSource = await readFile(dashboardPath, 'utf8');
  assert.match(optionsSource, /minimumAccessPrepared/);
  assert.match(optionsSource, /EAG_001_REQUIRED/);
  assert.match(optionsSource, /run EAG-001 once before Acquisition Discovery/i);
  assert.match(dashboardSource, /PREPARED: VERIFY FIRST/);
  assert.match(dashboardSource, /verify one target at a time with EAG-001/i);
});
