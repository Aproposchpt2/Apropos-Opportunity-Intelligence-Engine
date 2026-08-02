import { PUBLISHER_DISCOVERY_ENTITY_CLASSES, buildPublisherDiscoveryPrompt } from './publisher-discovery-taxonomy.js';

export const PUBLISHER_DISCOVERY_STRATEGIES = Object.freeze([
  {
    key: 'CORE_GOVERNMENT',
    label: 'Core government buyers',
    entityPatterns: [/State agencies/i, /Counties/i, /Cities and municipal/i, /Towns, villages/i, /Courts and judicial/i, /Correctional institutions/i]
  },
  {
    key: 'EDUCATION_AND_HEALTH',
    label: 'Education and public health buyers',
    entityPatterns: [/School districts/i, /Charter schools/i, /Educational service/i, /Community colleges/i, /University systems/i, /Public hospitals/i, /Federally qualified/i, /Public health districts/i]
  },
  {
    key: 'DISTRICTS_UTILITIES_AUTHORITIES',
    label: 'Districts, utilities and authorities',
    entityPatterns: [/Special districts/i, /Water, sewer/i, /Public utility/i, /Transportation authorities/i, /Airports/i, /Ports/i, /Housing authorities/i, /Redevelopment/i, /Convention and visitors/i, /Public safety/i, /Fire protection/i, /Library districts/i, /Parks and recreation/i]
  },
  {
    key: 'REGIONAL_TRIBAL_COOPERATIVE',
    label: 'Regional, tribal and cooperative publishers',
    entityPatterns: [/Cooperative purchasing/i, /Regional councils/i, /Metropolitan planning/i, /Workforce development/i, /Tribal governments/i, /Quasi-governmental/i]
  },
  {
    key: 'PUBLICLY_FUNDED_AND_SUBCONTRACTING',
    label: 'Publicly funded and subcontracting publishers',
    entityPatterns: [/Prime contractors/i, /Construction managers/i, /Nonprofit institutions/i, /grant recipients/i, /Procurement portals/i, /Public-benefit corporations/i]
  }
]);

function entitiesForStrategy(strategy) {
  return PUBLISHER_DISCOVERY_ENTITY_CLASSES.filter(entity => strategy.entityPatterns.some(pattern => pattern.test(entity)));
}

export function buildPublisherExpansionPlan({ stateCode, discoveryScope }) {
  return PUBLISHER_DISCOVERY_STRATEGIES.map(strategy => ({
    key: strategy.key,
    label: strategy.label,
    entityClasses: entitiesForStrategy(strategy),
    prompt: buildPublisherDiscoveryPrompt({
      stateCode,
      discoveryScope,
      strategyKey: strategy.key,
      strategyLabel: strategy.label,
      entityClasses: entitiesForStrategy(strategy)
    })
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
        merged.set(key, { ...candidate, discovery_strategies: [batch.strategyKey].filter(Boolean) });
        continue;
      }
      const priorSources = Array.isArray(prior.official_sources) ? prior.official_sources : [];
      const nextSources = Array.isArray(candidate.official_sources) ? candidate.official_sources : [];
      merged.set(key, {
        ...prior,
        ...candidate,
        official_sources: [...new Set([...priorSources, ...nextSources].filter(Boolean))],
        official_source_verified: prior.official_source_verified === true || candidate.official_source_verified === true,
        discovery_strategies: [...new Set([...(prior.discovery_strategies || []), batch.strategyKey].filter(Boolean))]
      });
    }
  }
  return [...merged.values()];
}

export function calculateCoverageSummary({ candidates = [], existingPublishers = [], strategyResults = [] }) {
  const discoveredTypes = new Set(candidates.map(candidate => canonical(candidate.organization_type)).filter(Boolean));
  const existingTypes = new Set(existingPublishers.map(publisher => canonical(publisher.organization_type)).filter(Boolean));
  const coveredTypes = new Set([...discoveredTypes, ...existingTypes]);
  const strategyCoverage = strategyResults.map(result => ({
    strategy_key: result.strategyKey,
    status: result.status,
    candidates_found: Number(result.candidatesFound || 0),
    error: result.error || null
  }));
  return {
    strategy_total: PUBLISHER_DISCOVERY_STRATEGIES.length,
    strategy_completed: strategyCoverage.filter(item => item.status === 'COMPLETED').length,
    strategy_failed: strategyCoverage.filter(item => item.status === 'FAILED').length,
    candidate_count: candidates.length,
    existing_publisher_count: existingPublishers.length,
    distinct_organization_types_observed: coveredTypes.size,
    strategy_coverage: strategyCoverage
  };
}
