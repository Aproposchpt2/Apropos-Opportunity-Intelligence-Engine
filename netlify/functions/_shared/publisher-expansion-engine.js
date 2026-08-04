import { PUBLISHER_DISCOVERY_ENTITY_CLASSES, buildPublisherDiscoveryPrompt, parseCountyDiscoveryScope } from './publisher-discovery-taxonomy.js';

export const PUBLISHER_DISCOVERY_UNITS = Object.freeze(
  PUBLISHER_DISCOVERY_ENTITY_CLASSES.map((entityClass, index) => Object.freeze({
    key: `ENTITY_CLASS_${String(index + 1).padStart(2, '0')}`,
    label: entityClass,
    entityClass,
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
    entityClasses: [unit.entityClass],
    prompt: `${buildPublisherDiscoveryPrompt({
      stateCode,
      discoveryScope,
      strategyKey: unit.key,
      strategyLabel: unit.label,
      entityClasses: [unit.entityClass]
    })}

MANDATORY UNIT EXECUTION RULES:
- This task is assigned to exactly one publisher class: ${unit.entityClass}.
- Search only for publishers with a verifiable nexus to ${targetLabel}; do not broaden the task into unrestricted statewide discovery.
- Use multiple distinct search formulations and official directories appropriate to this entity class and county.
- Do not stop after locating prominent organizations. Continue seeking smaller, local, regional, independent, and specialized publishers serving the county.
- Every returned candidate must have official-source evidence and the most direct usable procurement endpoint available.
- Every candidate must include county_name, county_fips when known, procurement platform, access class, machine-to-machine status, connector strategy, engineering complexity, reuse score, and connector ROI score.
- A successful search with zero qualifying publishers must return {"candidates":[]} rather than inventing candidates.
- Completion of this unit, whether successful, zero-result, partial, provider-failed, validation-failed, or persistence-failed, must not prevent the next entity-class task from executing.
- The unit result must be independently auditable and must identify this entity class exactly.`
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
    unit_total: PUBLISHER_DISCOVERY_UNITS.length,
    unit_terminal: unitCoverage.length,
    unit_successful: unitCoverage.filter(item => ['COMPLETED', 'COMPLETED_NO_RESULTS', 'COMPLETED_WITH_WARNINGS'].includes(item.status)).length,
    unit_failed: unitCoverage.filter(item => ['PROVIDER_FAILED', 'VALIDATION_FAILED', 'PERSISTENCE_FAILED'].includes(item.status)).length,
    candidate_count: candidates.length,
    existing_publisher_count: existingPublishers.length,
    distinct_organization_types_observed: coveredTypes.size,
    entity_class_coverage: unitCoverage,
    // Compatibility fields for existing report views.
    strategy_total: PUBLISHER_DISCOVERY_UNITS.length,
    strategy_completed: unitCoverage.filter(item => ['COMPLETED', 'COMPLETED_NO_RESULTS', 'COMPLETED_WITH_WARNINGS'].includes(item.status)).length,
    strategy_failed: unitCoverage.filter(item => ['PROVIDER_FAILED', 'VALIDATION_FAILED', 'PERSISTENCE_FAILED'].includes(item.status)).length,
    strategy_coverage: unitCoverage
  };
}
