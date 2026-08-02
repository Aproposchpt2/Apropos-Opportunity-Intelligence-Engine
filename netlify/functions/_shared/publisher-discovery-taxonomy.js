export const PUBLISHER_DISCOVERY_TAXONOMY_VERSION = 'APIE-PSR-TAXONOMY-2026.08.02-V1';

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

export const DISCOVERY_SCOPE_DESCRIPTIONS = Object.freeze({
  STATEWIDE: 'State-level publishers and major statewide public procurement ecosystems.',
  STATEWIDE_ALL: 'All qualifying publisher classes operating statewide, including nontraditional publicly funded and subcontracting publishers.',
  STATE_AND_LOCAL: 'State, county, municipal, education, special district, authority, healthcare, tribal, cooperative, publicly funded and subcontracting publishers.',
  REFRESH: 'Revalidate existing publisher coverage and identify newly created, migrated or previously missed publishers.'
});

export function buildPublisherDiscoveryPrompt({ stateCode, discoveryScope }) {
  const scopeDescription = DISCOVERY_SCOPE_DESCRIPTIONS[discoveryScope] || DISCOVERY_SCOPE_DESCRIPTIONS.STATE_AND_LOCAL;
  const entityClasses = PUBLISHER_DISCOVERY_ENTITY_CLASSES.map((value, index) => `${index + 1}. ${value}`).join('\n');
  const roleTypes = PUBLISHER_ROLE_TYPES.join('|');
  const channelTypes = OPPORTUNITY_CHANNEL_TYPES.join('|');

  return `Research official procurement opportunity publishers operating in or purchasing for ${stateCode}.

Discovery scope: ${discoveryScope} — ${scopeDescription}

A publisher qualifies when it publicly issues, posts, administers, or distributes solicitations, bid packages, subcontracting opportunities, cooperative contracts, or purchases supported by public funds. Do not limit discovery to conventional government agencies.

Required discovery universe:
${entityClasses}

Research rules:
- Use official organization, procurement, grant-program, prime-contractor, construction-manager, or authorized portal sources only.
- Confirm that the organization actually publishes or administers purchasing opportunities; organizational existence alone is insufficient.
- Identify the most direct usable opportunity-search endpoint.
- Distinguish direct public buyers from cooperative publishers, publicly funded purchasers, prime contractors, program managers, and supplemental publishers.
- Do not claim API availability unless an official machine-readable endpoint is verified.
- Mark uncertain facts as unknown rather than inferring them.
- Return each distinct buying or publishing organization once.

Return ONLY valid JSON using this schema:
{"candidates":[{"publisher_name":"","organization_type":"","publisher_role":"${roleTypes}","opportunity_channel":"${channelTypes}","jurisdiction_level":"FEDERAL|STATE|COUNTY|MUNICIPAL|REGIONAL|DISTRICT|TRIBAL|INSTITUTIONAL|PRIVATE_PUBLICLY_FUNDED","public_funding_basis":"","official_website":"","procurement_website":"","acquisition_method":"API|PUBLIC_SEARCH|PUBLIC_PORTAL|DOCUMENT_FEED|UNASSESSED","search_endpoint":"","vendor_registration_url":"","procurement_platform":"","technology_vendor":"","registration_required":false,"geographic_coverage":[""],"official_sources":[""],"official_source_verified":true}]}`;
}

export function normalizeDiscoveryClassification(candidate = {}) {
  const publisherRole = String(candidate.publisher_role || '').trim().toUpperCase();
  const opportunityChannel = String(candidate.opportunity_channel || '').trim().toUpperCase();
  return {
    taxonomy_version: PUBLISHER_DISCOVERY_TAXONOMY_VERSION,
    publisher_role: PUBLISHER_ROLE_TYPES.includes(publisherRole) ? publisherRole : 'DIRECT_PUBLIC_BUYER',
    opportunity_channel: OPPORTUNITY_CHANNEL_TYPES.includes(opportunityChannel) ? opportunityChannel : 'PUBLIC_CONTRACT',
    jurisdiction_level: String(candidate.jurisdiction_level || '').trim().toUpperCase() || null,
    public_funding_basis: String(candidate.public_funding_basis || '').trim() || null,
    geographic_coverage: Array.isArray(candidate.geographic_coverage)
      ? candidate.geographic_coverage.map(value => String(value || '').trim()).filter(Boolean)
      : []
  };
}
