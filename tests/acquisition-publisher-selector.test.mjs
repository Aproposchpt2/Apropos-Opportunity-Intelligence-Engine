import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const text=async p=>readFile(new URL(`../${p}`,import.meta.url),'utf8');

test('Acquisition Discovery requires one state-dependent publisher and displays its connector',async()=>{
  const launch=await text('assets/executive-launch.js');
  const core=await text('assets/executive-core.js');
  assert.match(launch,/ACQUISITION_DISCOVERY:\{agent:'Acquisition Operations'.*publisher:true/);
  assert.match(launch,/Publisher<select id="eccPublisher" required/);
  assert.match(launch,/Select one publisher/);
  assert.match(launch,/eccConnectorDisplay/);
  assert.match(launch,/publisher_scope='SINGLE'/);
  assert.match(launch,/cfg\.publisher_id=publisher\.value/);
  assert.match(launch,/Select one READY publisher before executing Acquisition Discovery/);
  assert.doesNotMatch(launch,/publisher_scope='ALL'/);
  assert.doesNotMatch(launch,/>ALL<\/option>/);
  assert.match(core,/command-publisher-options/);
});

test('Netlify publisher options expose only verified profiles and connector readiness',async()=>{
  const fn=await text('netlify/functions/command-publisher-options.js');
  assert.match(fn,/verified=eq\.true/);
  assert.match(fn,/configuration/);
  assert.match(fn,/connector_key/);
  assert.match(fn,/SINGLE_PUBLISHER_REQUIRED/);
  assert.match(fn,/selectable: ready && Boolean\(connectorKey\)/);
  assert.match(fn,/CONNECTOR PROFILE REQUIRED/);
});

test('Mission Control requires publisher_id for single-publisher acquisition',async()=>{
  const fn=await text('netlify/functions/command-mission-control.js');
  assert.match(fn,/publisher_id is required\. Acquisition Discovery executes one publishing agency at a time/);
  assert.match(fn,/publisher_scope: 'SINGLE'/);
  assert.match(fn,/command-single-publisher-acquisition-background/);
});
