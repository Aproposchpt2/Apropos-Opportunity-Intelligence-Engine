import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPublisherDiscoveryPrompt,
  normalizeDiscoveryClassification,
  parseCountyDiscoveryScope
} from '../netlify/functions/_shared/publisher-discovery-taxonomy.js';
import {
  buildPublisherExpansionPlan,
  PUBLISHER_DISCOVERY_CANDIDATE_CAP_PER_WAVE,
  PUBLISHER_DISCOVERY_MODE
} from '../netlify/functions/_shared/publisher-expansion-engine.js';

const scope = 'COUNTY|06037|LOS ANGELES COUNTY';

test('county discovery scope is parsed deterministically', () => {
  assert.deepEqual(parseCountyDiscoveryScope(scope), {
    countyName: 'LOS ANGELES COUNTY',
    countyFips: '06037'
  });
  assert.equal(parseCountyDiscoveryScope('STATEWIDE'), null);
});

test('publisher discovery prompt requires county nexus and platform intelligence', () => {
  const prompt = buildPublisherDiscoveryPrompt({
    stateCode: 'CA',
    discoveryScope: scope,
    strategyKey: 'CORE_WAVE_01',
    strategyLabel: 'Local government and direct public buyers',
    entityClasses: ['Counties, county departments and county constitutional offices']
  });
  assert.match(prompt, /LOS ANGELES COUNTY, CA/);
  assert.match(prompt, /documented operational, geographic, service-area/);
  assert.match(prompt, /platform_access_class/);
  assert.match(prompt, /machine_to_machine_supported/);
  assert.match(prompt, /connector_roi_score/);
});

test('county expansion uses six cost-controlled, county-anchored waves', () => {
  const plan = buildPublisherExpansionPlan({ stateCode: 'CA', discoveryScope: scope });
  assert.equal(PUBLISHER_DISCOVERY_MODE, 'CORE_SIX_WAVE_COST_CONTROL');
  assert.equal(PUBLISHER_DISCOVERY_CANDIDATE_CAP_PER_WAVE, 12);
  assert.equal(plan.length, 6);
  for (const unit of plan) {
    assert.match(unit.prompt, /LOS ANGELES COUNTY, CA/);
    assert.match(unit.prompt, /do not broaden into unrestricted statewide discovery/i);
    assert.match(unit.prompt, /Return no more than 12 verified candidates/i);
    assert.ok(unit.entityClasses.length >= 3);
  }
});

test('classification normalizes Class A connector intelligence', () => {
  const normalized = normalizeDiscoveryClassification({
    publisher_role: 'DIRECT_PUBLIC_BUYER',
    opportunity_channel: 'PUBLIC_CONTRACT',
    county_name: 'Los Angeles County',
    county_fips: '06037',
    procurement_platform: 'Los Angeles County ECAPS',
    technology_vendor: 'County of Los Angeles',
    platform_access_class: 'CLASS_A',
    machine_to_machine_supported: true,
    recommended_connector_strategy: 'DIRECT_NETLIFY_CONNECTOR',
    engineering_complexity: 'LOW',
    reuse_score: 90,
    connector_roi_score: 95
  });
  assert.equal(normalized.access_class, 'CLASS_A');
  assert.equal(normalized.machine_to_machine_supported, true);
  assert.equal(normalized.connector_strategy, 'DIRECT_NETLIFY_CONNECTOR');
  assert.equal(normalized.reuse_score, 90);
  assert.equal(normalized.connector_roi_score, 95);
});
