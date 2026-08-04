import { buildPublisherDiscoveryPrompt, parseCountyDiscoveryScope } from './publisher-discovery-taxonomy.js';

export const PUBLISHER_DISCOVERY_MODE = 'CORE_SIX_WAVE_COST_CONTROL';
export const PUBLISHER_DISCOVERY_CANDIDATE_CAP_PER_WAVE = 12;

export const PUBLISHER_DISCOVERY_WAVES = Object.freeze([
  Object.freeze({
    key: 'CORE_WAVE_01',
    label: 'Local government and direct public buyers',
    entityClasses: Object.freeze([
      'Counties, county departments and county constitutional offices',
      'Cities and municipal departments',
      'Special districts'
    ])
  }),
  Object.freeze({
    key: 'CORE_WAVE_02',
    label: 'Infrastructure, utilities and transportation',
    entityClasses: Object.freeze([
      'Water, sewer, sanitation and irrigation districts',
      'Public utility districts and municipal utilities',
      'Transportation authorities and transit agencies',
      'Airports and airport authorities',
      'Ports and harbor authorities',
      'Housing authorities'
    ])
  }),
  Object.freeze({
    key: 'CORE_WAVE_03',
    label: 'Education institutions',
    entityClasses: Object.freeze([
      'School districts',
      'Community colleges and technical colleges',
      'University systems and individual campuses'
    ])
  }),
  Object.freeze({
    key: 'CORE_WAVE_04',
    label: 'Health, justice and public institutions',
    entityClasses: Object.freeze([
      'Public health districts',
      'Courts and judicial agencies',
      'Correctional institutions and juvenile facilities',
      'Public hospitals, hospital districts, veterans homes and public care facilities'
    ])
  }),
  Object.freeze({
    key: 'CORE_WAVE_05',
    label: 'Regional and cooperative procurement',
    entityClasses: Object.freeze([
      'Public-benefit corporations and government-owned corporations',
      'Cooperative purchasing organizations and purchasing consortia',
      'Regional councils of governments',
      'Workforce development boards'
    ])
  }),
  Object.freeze({
    key: 'CORE_WAVE_06',
    label: 'Public projects and procurement portals',
    entityClasses: Object.freeze([
      'Prime contractors seeking subcontractors',
      'Construction managers, program managers, design-build teams and EPC contractors issuing bid packages',
      'Procurement portals, public bid boards and supplemental public-notice publishers'
    ])
  })
]);

export const PUBLISHER_DISCOVERY_UNITS = Object.freeze(
  PUBLISHER_DISCOVERY_WAVES.map((wave, index) => Object.freeze({
    ...wave,
    entityClass: wave.label,
    sequence: index + 1
  }))
);

// Backward-compatible export for existing reporting consumers.
export const PUBLISHER_DISCOVERY_STRATEGIES = PUBLISHER_DISCOVERY_UNITS;

export function buildPublisherExpansionPlan({ stateCode, discoveryScope }) {
  const countyScope = parseCountyDiscoveryScope(discoveryScope);
  const targetLabel = countyScope ? `${countyScope.countyName}, ${stateCode}` : stateCode;
  return PUBLISHER_DISCOVERY_UNITS.map(unit => ({
    ...unit,
    prompt: `${buildPublisherDiscoveryPrompt({
      stateCode,
      discoveryScope,
      strategyKey: unit.key,
      strategyLabel: unit.label,
      entityClasses: [...unit.entityClasses]
    })}

COST-CONTROLLED WAVE EXECUTION RULES:
- This is one consolidated discovery wave, not an exhaustive entity-by-entity census.
- Search only for publishers with a verifiable nexus to ${targetLabel}; do not broaden into unrestricted statewide discovery.
- Return no more than ${PUBLISHER_DISCOVERY_CANDIDATE_CAP_PER_WAVE} verified candidates for this wave.
- Prioritize direct buyers with current procurement pages, active bid portals, machine-readable feeds, or reusable procurement platforms.
- Consolidate departments under the parent publisher unless a department maintains an independent procurement endpoint.
- Do not continue long-tail research after the candidate cap is reached.
- Do not return organizations already represented by the same parent procurement portal unless the endpoint or buying authority is materially distinct.
- Every returned candidate must include official-source evidence and the most direct usable procurement endpoint.
- Mark uncertain facts as unknown; do not invent or infer API capability.
- A successful search with zero qualifying publishers must return {"candidates":[]}.
- The wave result must remain independently auditable and identify the applicable organization type for each candidate.`
  }));
}

function canonical(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function mergePublisherCandidates(candidateBatches = []) {
  const merged = new Map();
  for (const batch of candidateBatches) {
    for (const candidate of Array.isArray(batch?.candidates) ? batch.candidates : []) {
      const nameKey = canonical(candidate?.publisher_name);
      if (!nameKey) continue;
      const endpointKey = canonical(candidate?.search_endpoint || candidate?.procurement_website || candidate?.official_website);
      const key = endpointKey ? `${nameKey}|${endpointKey}` : nameKey;
      const prior = merged.get(key);
      if (!prior) {
        merged.set(key, {
          ...candidate,
          discovery_strategies: [batch.strategyKey].filter(Boolean),
          discovery_entity_classes: [batch.entityClass].filter(Boolean)
        });
        continue;
      }
      const priorSources = Array.isArray(prior.official_sources) ? prior.official_sources : [];
      const nextSources = Array.isArray(candidate.official_sources) ? candidate.official_sources : [];
      merged.set(key, {
        ...prior,
        ...candidate,
        official_sources: [...new Set([...priorSources, ...nextSources].filter(Boolean))],
        official_source_verified: prior.official_source_verified === true || candidate.official_source_verified === true,
        discovery_strategies: [...new Set([...(prior.discovery_strategies || []), batch.strategyKey].filter(Boolean))],
        discovery_entity_classes: [...new Set([...(prior.discovery_entity_classes || []), batch.entityClass].filter(Boolean))]
      });
    }
  }
  return [...merged.values()];
}

export function calculateCoverageSummary({ candidates = [], existingPublishers = [], strategyResults = [] }) {
  const discoveredTypes = new Set(candidates.map(candidate => canonical(candidate.organization_type)).filter(Boolean));
  const existingTypes = new Set(existingPublishers.map(publisher => canonical(publisher.organization_type)).filter(Boolean));
  const coveredTypes = new Set([...discoveredTypes, ...existingTypes]);
  const unitCoverage = strategyResults.map(result => ({
    unit_key: result.strategyKey,
    sequence: result.sequence || null,
    entity_class: result.entityClass || null,
    status: result.status,
    candidates_found: Number(result.candidatesFound || 0),
    candidates_verified: Number(result.candidatesVerified || 0),
    assignments_ready: Number(result.assignmentsReady || 0),
    attempts: Number(result.attempts || 0),
    error: result.error || null,
    child_run_id: result.childRunId || null
  }));
  return {
    discovery_mode: PUBLISHER_DISCOVERY_MODE,
    candidate_cap_per_wave: PUBLISHER_DISCOVERY_CANDIDATE_CAP_PER_WAVE,
    unit_total: PUBLISHER_DISCOVERY_UNITS.length,
    unit_terminal: unitCoverage.length,
    unit_successful: unitCoverage.filter(item => ['COMPLETED', 'COMPLETED_NO_RESULTS', 'COMPLETED_WITH_WARNINGS'].includes(item.status)).length,
    unit_failed: unitCoverage.filter(item => ['PROVIDER_FAILED', 'VALIDATION_FAILED', 'PERSISTENCE_FAILED'].includes(item.status)).length,
    candidate_count: candidates.length,
    existing_publisher_count: existingPublishers.length,
    distinct_organization_types_observed: coveredTypes.size,
    entity_class_coverage: unitCoverage,
    strategy_total: PUBLISHER_DISCOVERY_UNITS.length,
    strategy_completed: unitCoverage.filter(item => ['COMPLETED', 'COMPLETED_NO_RESULTS', 'COMPLETED_WITH_WARNINGS'].includes(item.status)).length,
    strategy_failed: unitCoverage.filter(item => ['PROVIDER_FAILED', 'VALIDATION_FAILED', 'PERSISTENCE_FAILED'].includes(item.status)).length,
    strategy_coverage: unitCoverage
  };
}
