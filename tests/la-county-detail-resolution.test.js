import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const connectorPath=new URL('../netlify/functions/_shared/acquisition-connectors/la-county-ecaps.js',import.meta.url);
const extractorPath=new URL('../netlify/functions/_shared/detail-extraction-engine.js',import.meta.url);

test('LA County connector constructs BidDetail URL from solicitation number',async()=>{
  const source=await readFile(connectorPath,'utf8');
  assert.match(source,/BidLookUp\/BidDetail/);
  assert.match(source,/searchParams\.set\('BidNumber', solicitationNumber\)/);
  assert.doesNotMatch(source,/\|\| pageUrl/);
});

test('detail extractor requires confirmed solicitation detail and labelled contact fields',async()=>{
  const source=await readFile(extractorPath,'utf8');
  assert.match(source,/Solicitation\\s\+Detail/);
  assert.match(source,/Contact Email/);
  assert.match(source,/Contact Phone/);
  assert.match(source,/validNanpPhone/);
  assert.doesNotMatch(source,/text\.match\(\/\(\?:\\\+\?1/);
});
