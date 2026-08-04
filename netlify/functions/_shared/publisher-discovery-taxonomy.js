export const PUBLISHER_DISCOVERY_TAXONOMY_VERSION = 'APIE-PSR-TAXONOMY-2026.08.03-V3';

export const PUBLISHER_DISCOVERY_ENTITY_CLASSES = Object.freeze([
  'Federal departments and agencies',
  'Federal courts and government corporations',
  'State agencies, departments, boards, commissions and constitutional offices',
  'Counties, county departments and county constitutional offices',
  'Cities and municipal departments',
  'Towns, villages, boroughs and townships',
  'Special districts',
  'Water, sewer, sanitation and irrigation districts',
  'Public utility districts and municipal utilities',
  'Transportation authorities and transit agencies',
  'Airports and airport authorities',
  'Ports and harbor authorities',
  'Housing authorities',
  'Redevelopment, economic development and industrial development authorities',
  'Convention and visitors authorities',
  'Public safety and emergency-service districts',
  'Fire protection districts',
  'Public health districts',
  'Library districts and library systems',
  'Parks and recreation districts',
  'Courts and judicial agencies',
  'Correctional institutions and juvenile facilities',
  'Public-benefit corporations and government-owned corporations',
  'Public hospitals, hospital districts, veterans homes and public care facilities',
  'Federally qualified health centers',
  'School districts',
  'Charter schools and charter-school networks',
  'Educational service agencies',
  'Community colleges and technical colleges',
  'University systems and individual campuses',
  'Cooperative purchasing organizations and purchasing consortia',
  'Regional councils of governments',
  'Metropolitan planning organizations',
  'Workforce development boards',
  'Tribal governments, tribal enterprises, tribal utilities, colleges and health systems',
  'Quasi-governmental organizations and authorities receiving public funding',
  'Prime contractors seeking subcontractors',
  'Construction managers, program managers, design-build teams and EPC contractors issuing bid packages',
  'Nonprofit institutions administering publicly funded programs',
  'Federal, state and local grant recipients purchasing goods or services with grant funds',
  'Procurement portals, public bid boards and supplemental public-notice publishers'
]);

export const PUBLISHER_ROLE_TYPES = Object.freeze([
  'DIRECT_PUBLIC_BUYER',
  'DELEGATED_PUBLIC_BUYER',
  'COOPERATIVE_PURCHASING_PUBLISHER',
  'PUBLICLY_FUNDED_PURCHASER',
  'PRIME_SUBCONTRACTING_PUBLISHER',
  'PROGRAM_MANAGER_BID_PUBLISHER',
  'SUPPLEMENTAL_PROCUREMENT_PUBLISHER'
]);

export const OPPORTUNITY_CHANNEL_TYPES = Object.freeze([
  'PUBLIC_CONTRACT',
  'PUBLIC_PURCHASE_ORDER',
  'COOPERATIVE_CONTRACT',
  'SUBCONTRACTING_OPPORTUNITY',
  'CONSTRUCTION_BID_PACKAGE',
  'GRANT_FUNDED_PURCHASE',
  'PUBLICLY_FUNDED_PROGRAM_PURCHASE'
]);

export const PLATFORM_ACCESS_CLASSES = Object.freeze(['CLASS_A', 'CLASS_B', 'CLASS_C', 'CLASS_D', 'UNKNOWN']);
export const ENGINEERING_COMPLEXITIES = Object.freeze(['LOW', 'MODERATE', 'HIGH', 'VERY_HIGH', 'UNKNOWN']);

export const DISCOVERY_SCOPE_DESCRIPTIONS = Object.freeze({
  STATEWIDE: 'State-level publishers and major statewide public procurement ecosystems.',
  STATEWIDE_ALL: 'All qualifying publisher classes operating statewide, including nontraditional publicly funded and subcontracting publishers.',
  STATE_AND_LOCAL: 'State, county, municipal, education, special district, authority, healthcare, tribal, cooperative, publicly funded and subcontracting publishers.',
  REFRESH: 'Revalidate existing publisher coverage and identify newly created, migrated or previously missed publishers.'
});

const txt = value => String(value ?? '').trim();
const bool = value => value === true || String(value || '').toLowerCase() === 'true';
const score = value => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, Math.round(numeric))) : null;
};

export function parseCountyDiscoveryScope(discoveryScope) {
  const raw = txt(discoveryScope);
  const parts = raw.split('|');
  if (parts.length < 3 || parts[0].toUpperCase() !== 'COUNTY') return null;
  const countyFips = txt(parts[1]) || null;
  const countyName = txt(parts.slice(2).join('|'));
  if (!countyName) return null;
  return { countyName, countyFips };
}

function inferAccessClass(candidate = {}) {
  const declared = txt(candidate.platform_access_class || candidate.access_class).toUpperCase();
  if (PLATFORM_ACCESS_CLASSES.includes(declared)) return declared;
  if (bool(candidate.authentication_required) || bool(candidate.login_required)) return 'CLASS_C';
  if (bool(candidate.stateful_session_required) || bool(candidate.javascript_required) || bool(candidate.browser_automation_required)) return 'CLASS_B';
  if (bool(candidate.public_api_available) || bool(candidate.rss_available) || bool(candidate.csv_available) || bool(candidate.json_available) || bool(candidate.xml_available) || bool(candidate.open_data_available)) return 'CLASS_A';
  const method = txt(candidate.acquisition_method).toUpperCase();
  if (['API', 'DOCUMENT_FEED'].includes(method)) return 'CLASS_A';
  if (method === 'PUBLIC_PORTAL') return 'CLASS_B';
  return 'UNKNOWN';
}

function inferConnectorStrategy(candidate = {}, accessClass) {
  const declared = txt(candidate.recommended_connector_strategy || candidate.connector_strategy).toUpperCase();
  if (declared) return declared;
  if (accessClass === 'CLASS_A') return 'DIRECT_NETLIFY_CONNECTOR';
  if (accessClass === 'CLASS_B') return 'STATEFUL_SESSION_OR_HEADLESS_BROWSER';
  if (accessClass === 'CLASS_C') return 'AUTHORIZED_ACCOUNT_INTEGRATION_OR_OFFICIAL_FEED';
  if (accessClass === 'CLASS_D') return 'PUBLISHER_OR_PLATFORM_AGREEMENT';
  return 'ENGINEERING_REVIEW_REQUIRED';
}

function inferEngineeringComplexity(candidate = {}, accessClass) {
  const declared = txt(candidate.engineering_complexity).toUpperCase();
  if (ENGINEERING_COMPLEXITIES.includes(declared)) return declared;
  return { CLASS_A: 'LOW', CLASS_B: 'HIGH', CLASS_C: 'HIGH', CLASS_D: 'VERY_HIGH', UNKNOWN: 'UNKNOWN' }[accessClass];
}

export function buildPublisherDiscoveryPrompt({ stateCode, discoveryScope, strategyKey = 'UNIVERSAL', strategyLabel = 'Universal publisher discovery', entityClasses = PUBLISHER_DISCOVERY_ENTITY_CLASSES }) {
  const countyScope = parseCountyDiscoveryScope(discoveryScope);
  const scopeDescription = countyScope
    ? `County-centric discovery for ${countyScope.countyName}, ${stateCode}${countyScope.countyFips ? ` (FIPS ${countyScope.countyFips})` : ''}.`
    : (DISCOVERY_SCOPE_DESCRIPTIONS[discoveryScope] || DISCOVERY_SCOPE_DESCRIPTIONS.STATE_AND_LOCAL);
  const selectedClasses = Array.isArray(entityClasses) && entityClasses.length ? entityClasses : PUBLISHER_DISCOVERY_ENTITY_CLASSES;
  const entityList = selectedClasses.map((value, index) => `${index + 1}. ${value}`).join('\n');
  const roleTypes = PUBLISHER_ROLE_TYPES.join('|');
  const channelTypes = OPPORTUNITY_CHANNEL_TYPES.join('|');
  const geographicTarget = countyScope ? `${countyScope.countyName}, ${stateCode}` : stateCode;

  return `Research official procurement opportunity publishers operating in or purchasing specifically for ${geographicTarget}.

Search wave: ${strategyKey} — ${strategyLabel}
Discovery scope: ${discoveryScope} — ${scopeDescription}

A publisher qualifies when it publicly issues, posts, administers, or distributes active solicitations, bid packages, subcontracting opportunities, cooperative contracts, or purchases supported by public funds. Do not limit discovery to conventional government agencies.

Search this wave only for these publisher classes:
${entityList}

Research rules:
- Require a documented operational, geographic, service-area, facility, campus, district, project, or purchasing nexus to ${geographicTarget}.
- Do not return a statewide or national organization merely because it can theoretically serve the county; identify the county-specific nexus in geographic_coverage.
- Search official directories, organizational listings, procurement pages, bid boards, supplier portals and authorized platform pages relevant to this wave.
- Use official organization, procurement, grant-program, prime-contractor, construction-manager, or authorized portal sources only.
- Confirm that the organization actually publishes or administers purchasing opportunities; organizational existence alone is insufficient.
- Identify the most direct usable opportunity-search endpoint, not merely a general homepage.
- Prefer pages showing current solicitations, open bids, procurement notices, bid packages or vendor opportunities.
- Identify the procurement platform and platform vendor whenever evidence permits.
- Classify machine access using CLASS_A, CLASS_B, CLASS_C, CLASS_D, or UNKNOWN. Public browser access alone is not proof of machine-to-machine support.
- CLASS_A requires an API, machine-readable feed/export, open-data endpoint, or stable deterministic HTML that does not require browser execution.
- CLASS_B requires public stateful sessions, JavaScript, dynamic routing, temporary tokens, or browser-like navigation.
- CLASS_C requires registration, login, an agency/vendor account, or authorized integration.
- CLASS_D lacks a practical public machine interface and requires an agreement, paid access, or manual-assisted process.
- Do not claim API availability or machine-to-machine support unless official evidence supports it.
- Mark uncertain facts as unknown rather than inferring them.
- Return each distinct buying or publishing organization once.
- Maximize verified publisher yield for this specific county and search wave.

Return ONLY valid JSON using this schema:
{"candidates":[{"publisher_name":"","organization_type":"","publisher_role":"${roleTypes}","opportunity_channel":"${channelTypes}","jurisdiction_level":"FEDERAL|STATE|COUNTY|MUNICIPAL|REGIONAL|DISTRICT|TRIBAL|INSTITUTIONAL|PRIVATE_PUBLICLY_FUNDED","public_funding_basis":"","county_name":"${countyScope?.countyName || ''}","county_fips":"${countyScope?.countyFips || ''}","official_website":"","procurement_website":"","acquisition_method":"API|PUBLIC_SEARCH|PUBLIC_PORTAL|DOCUMENT_FEED|UNASSESSED","search_endpoint":"","vendor_registration_url":"","procurement_platform":"","technology_vendor":"","registration_required":false,"authentication_required":false,"login_required":false,"public_api_available":false,"api_documentation_url":"","rss_available":false,"csv_available":false,"json_available":false,"xml_available":false,"open_data_available":false,"machine_to_machine_supported":false,"stateful_session_required":false,"javascript_required":false,"browser_automation_required":false,"document_access_method":"","pagination_method":"","detail_resolution_method":"","attachment_retrieval_method":"","anti_automation_indicators":[""],"platform_access_class":"CLASS_A|CLASS_B|CLASS_C|CLASS_D|UNKNOWN","recommended_connector_strategy":"","engineering_complexity":"LOW|MODERATE|HIGH|VERY_HIGH|UNKNOWN","reuse_score":0,"connector_roi_score":0,"geographic_coverage":[""],"official_sources":[""],"official_source_verified":true}]}`;
}

export function normalizeDiscoveryClassification(candidate = {}) {
  const publisherRole = txt(candidate.publisher_role).toUpperCase();
  const opportunityChannel = txt(candidate.opportunity_channel).toUpperCase();
  const accessClass = inferAccessClass(candidate);
  const connectorStrategy = inferConnectorStrategy(candidate, accessClass);
  return {
    taxonomy_version: PUBLISHER_DISCOVERY_TAXONOMY_VERSION,
    publisher_role: PUBLISHER_ROLE_TYPES.includes(publisherRole) ? publisherRole : 'DIRECT_PUBLIC_BUYER',
    opportunity_channel: OPPORTUNITY_CHANNEL_TYPES.includes(opportunityChannel) ? opportunityChannel : 'PUBLIC_CONTRACT',
    jurisdiction_level: txt(candidate.jurisdiction_level).toUpperCase() || null,
    public_funding_basis: txt(candidate.public_funding_basis) || null,
    county_name: txt(candidate.county_name) || null,
    county_fips: txt(candidate.county_fips) || null,
    procurement_platform: txt(candidate.procurement_platform) || null,
    technology_vendor: txt(candidate.technology_vendor) || null,
    platform_access_class: accessClass,
    access_class: accessClass,
    machine_to_machine_supported: bool(candidate.machine_to_machine_supported),
    public_api_available: bool(candidate.public_api_available),
    api_documentation_url: txt(candidate.api_documentation_url) || null,
    rss_available: bool(candidate.rss_available),
    csv_available: bool(candidate.csv_available),
    json_available: bool(candidate.json_available),
    xml_available: bool(candidate.xml_available),
    open_data_available: bool(candidate.open_data_available),
    authentication_required: bool(candidate.authentication_required),
    login_required: bool(candidate.login_required),
    stateful_session_required: bool(candidate.stateful_session_required),
    javascript_required: bool(candidate.javascript_required),
    browser_automation_required: bool(candidate.browser_automation_required),
    document_access_method: txt(candidate.document_access_method) || null,
    pagination_method: txt(candidate.pagination_method) || null,
    detail_resolution_method: txt(candidate.detail_resolution_method) || null,
    attachment_retrieval_method: txt(candidate.attachment_retrieval_method) || null,
    anti_automation_indicators: Array.isArray(candidate.anti_automation_indicators)
      ? candidate.anti_automation_indicators.map(txt).filter(Boolean)
      : [],
    recommended_connector_strategy: connectorStrategy,
    connector_strategy: connectorStrategy,
    engineering_complexity: inferEngineeringComplexity(candidate, accessClass),
    reuse_score: score(candidate.reuse_score),
    connector_roi_score: score(candidate.connector_roi_score),
    geographic_coverage: Array.isArray(candidate.geographic_coverage)
      ? candidate.geographic_coverage.map(txt).filter(Boolean)
      : [],
    discovery_strategies: Array.isArray(candidate.discovery_strategies)
      ? candidate.discovery_strategies.map(value => txt(value).toUpperCase()).filter(Boolean)
      : []
  };
}
