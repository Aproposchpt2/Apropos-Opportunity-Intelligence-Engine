import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLISHER_DISCOVERY_ENTITY_CLASSES,
  PUBLISHER_DISCOVERY_TAXONOMY_VERSION,
  buildPublisherDiscoveryPrompt,
  normalizeDiscoveryClassification
} from '../netlify/functions/_shared/publisher-discovery-taxonomy.js';

test('expanded discovery universe includes nontraditional public procurement publishers', () => {
  const corpus = PUBLISHER_DISCOVERY_ENTITY_CLASSES.join('\n');
  assert.ok(PUBLISHER_DISCOVERY_ENTITY_CLASSES.length >= 40);
  assert.match(corpus, /Prime contractors seeking subcontractors/);
  assert.match(corpus, /grant recipients purchasing goods or services/);
  assert.match(corpus, /Tribal governments/);
  assert.match(corpus, /Cooperative purchasing organizations/);
  assert.match(corpus, /Federally qualified health centers/);
});

test('prompt requires official-source verification and expanded opportunity channels', () => {
  const prompt = buildPublisherDiscoveryPrompt({ stateCode: 'NV', discoveryScope: 'STATE_AND_LOCAL' });
  assert.match(prompt, /official procurement opportunity publishers/i);
  assert.match(prompt, /SUBCONTRACTING_OPPORTUNITY/);
  assert.match(prompt, /GRANT_FUNDED_PURCHASE/);
  assert.match(prompt, /Do not claim API availability unless/i);
  assert.match(prompt, /Return ONLY valid JSON/i);
});

test('classification normalization preserves valid expanded publisher metadata', () => {
  const result = normalizeDiscoveryClassification({
    publisher_role: 'prime_subcontracting_publisher',
    opportunity_channel: 'subcontracting_opportunity',
    jurisdiction_level: 'private_publicly_funded',
    public_funding_basis: 'Federal transportation grant',
    geographic_coverage: ['Nevada', '', 'Clark County']
  });
  assert.equal(result.taxonomy_version, PUBLISHER_DISCOVERY_TAXONOMY_VERSION);
  assert.equal(result.publisher_role, 'PRIME_SUBCONTRACTING_PUBLISHER');
  assert.equal(result.opportunity_channel, 'SUBCONTRACTING_OPPORTUNITY');
  assert.equal(result.jurisdiction_level, 'PRIVATE_PUBLICLY_FUNDED');
  assert.deepEqual(result.geographic_coverage, ['Nevada', 'Clark County']);
});

test('classification normalization applies safe defaults to unsupported values', () => {
  const result = normalizeDiscoveryClassification({ publisher_role: 'unknown', opportunity_channel: 'unknown' });
  assert.equal(result.publisher_role, 'DIRECT_PUBLIC_BUYER');
  assert.equal(result.opportunity_channel, 'PUBLIC_CONTRACT');
});
