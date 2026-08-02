import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLISHER_DISCOVERY_STRATEGIES,
  buildPublisherExpansionPlan,
  mergePublisherCandidates,
  calculateCoverageSummary
} from '../netlify/functions/_shared/publisher-expansion-engine.js';

test('expansion plan creates focused search waves across the complete publisher universe', () => {
  const plan = buildPublisherExpansionPlan({ stateCode: 'NV', discoveryScope: 'STATE_AND_LOCAL' });
  assert.equal(plan.length, PUBLISHER_DISCOVERY_STRATEGIES.length);
  assert.ok(plan.length >= 5);
  assert.ok(plan.every(wave => wave.entityClasses.length > 0));
  assert.match(plan.find(wave => wave.key === 'PUBLICLY_FUNDED_AND_SUBCONTRACTING').prompt, /Prime contractors seeking subcontractors/);
  assert.match(plan.find(wave => wave.key === 'DISTRICTS_UTILITIES_AUTHORITIES').prompt, /Water, sewer, sanitation and irrigation districts/);
});

test('candidate merger deduplicates repeated publishers and preserves evidence', () => {
  const merged = mergePublisherCandidates([
    { strategyKey: 'CORE_GOVERNMENT', candidates: [{ publisher_name: 'City of Example', search_endpoint: 'https://example.gov/bids', official_sources: ['https://example.gov'], official_source_verified: true }] },
    { strategyKey: 'DISTRICTS_UTILITIES_AUTHORITIES', candidates: [{ publisher_name: 'The City of Example', search_endpoint: 'https://example.gov/bids', official_sources: ['https://example.gov/procurement'], official_source_verified: false }] }
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].official_sources.sort(), ['https://example.gov', 'https://example.gov/procurement'].sort());
  assert.equal(merged[0].official_source_verified, true);
  assert.deepEqual(merged[0].discovery_strategies.sort(), ['CORE_GOVERNMENT', 'DISTRICTS_UTILITIES_AUTHORITIES'].sort());
});

test('coverage summary reports completed and failed waves without fabricating completeness', () => {
  const coverage = calculateCoverageSummary({
    candidates: [{ organization_type: 'City' }, { organization_type: 'Water District' }],
    existingPublishers: [{ organization_type: 'State Agency' }],
    strategyResults: [
      { strategyKey: 'CORE_GOVERNMENT', status: 'COMPLETED', candidatesFound: 1 },
      { strategyKey: 'EDUCATION_AND_HEALTH', status: 'FAILED', candidatesFound: 0, error: 'timeout' }
    ]
  });
  assert.equal(coverage.strategy_completed, 1);
  assert.equal(coverage.strategy_failed, 1);
  assert.equal(coverage.distinct_organization_types_observed, 3);
  assert.equal(coverage.strategy_coverage[1].error, 'timeout');
});
