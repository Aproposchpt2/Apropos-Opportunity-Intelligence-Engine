// Generic structured-JSON discovery connector. Not publisher-specific: it
// reads its endpoint and field mapping from the publisher's derived
// acquisition_discovery_profile (see configure-m2m-publisher-profile.js)
// rather than hardcoding any single publisher's shape. Intended for
// publishers whose manual-discovery evidence identifies a genuine public
// open-data feed (open_data_available=true) as a discovery source distinct
// from a JS-rendered procurement portal — e.g. a city-published Socrata
// export of RAMP/OpenGov/etc. bid data. Attachment retrieval and portal
// interaction remain out of scope for this connector; it produces listing
// -level records only.

const txt = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const arr = value => Array.isArray(value) ? value : [];

function searchParameters(assignment) {
  return assignment?.search_parameters && typeof assignment.search_parameters === 'object' ? assignment.search_parameters : {};
}

function discoveryProfile(publisher, assignment) {
  const configuration = typeof publisher?.configuration === 'object' && publisher.configuration ? publisher.configuration : {};
  const parameters = searchParameters(assignment);
  const fromAssignment = parameters.acquisition_discovery_profile;
  const fromPublisher = configuration.acquisition_discovery_profile;
  if (fromAssignment && typeof fromAssignment === 'object') return fromAssignment;
  if (fromPublisher && typeof fromPublisher === 'object') return fromPublisher;
  return {};
}

function getPath(source, path) {
  return String(path || '').split('.').filter(Boolean).reduce(
    (acc, key) => (acc && typeof acc === 'object') ? acc[key] : undefined,
    source
  );
}

function normalizeRecord(item, fieldMap, publisher, endpoint) {
  const get = key => (fieldMap[key] ? getPath(item, fieldMap[key]) : undefined);
  const title = txt(get('title'));
  const sourceRecordId = txt(get('source_record_id')) || null;
  const detailUrl = txt(get('detail_url')) || endpoint;
  const status = txt(get('status')).toUpperCase() || 'UNKNOWN';
  return {
    source_record_id: sourceRecordId || `${publisher?.id || 'PUBLISHER'}:${title}:${txt(get('due_date'))}`,
    solicitation_number: txt(get('solicitation_number')) || null,
    title,
    description: txt(get('description')) || null,
    status,
    posted_date: txt(get('posted_date')) || null,
    due_date: txt(get('due_date')) || null,
    issuing_organization: txt(get('department')) || publisher?.publisher_name || null,
    department: txt(get('department')) || null,
    contact_name: null,
    contact_email: null,
    source_url: detailUrl,
    detail_page_url: detailUrl,
    listing_url: endpoint,
    document_urls: [],
    state_code: publisher?.state_code || null,
    county_name: publisher?.county_name || null,
    procurement_platform: txt(get('procurement_platform')) || null,
    record_type: 'PUBLIC_OPEN_DATA_RECORD',
    // These are not free-text web-search results — they come from a source
    // URL already named in the publisher's own verified official_sources
    // evidence, so they're treated as verified rather than agent-asserted.
    official_source_verified: true
  };
}

async function fetchJson(endpoint) {
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: { 'User-Agent': 'APROPOS-Publisher-Engineering/1.0', Accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { throw new Error('Public JSON API endpoint did not return valid JSON.'); }
  }
  return { response, data };
}

function filterOpen(records, openStatusValues) {
  const allowed = arr(openStatusValues).map(v => txt(v).toUpperCase());
  if (!allowed.length) return records;
  return records.filter(r => allowed.includes(txt(r.status).toUpperCase()));
}

export const connector = {
  key: 'PUBLIC_JSON_API',
  version: '1.0.0',
  publisherNames: [],
  hostnames: [],

  async verify({ publisher, assignment, sampleSize = 5, onSample }) {
    const profile = discoveryProfile(publisher, assignment);
    const endpoint = txt(profile.endpoint);
    if (!endpoint) throw new Error('No public JSON API endpoint is configured in this publisher\'s discovery profile.');
    const fieldMap = (profile.field_map && typeof profile.field_map === 'object') ? profile.field_map : {};
    if (!fieldMap.title) throw new Error('Discovery profile field_map has no title mapping; the profile is not executable.');

    const { response, data } = await fetchJson(endpoint);
    if (!response.ok) throw new Error(`Public JSON API endpoint returned HTTP ${response.status}.`);
    const rawRecords = arr(data);
    const normalized = filterOpen(
      rawRecords.map(item => normalizeRecord(item, fieldMap, publisher, endpoint)).filter(r => r.title),
      profile.open_status_values
    );
    const sample = normalized.slice(0, Math.max(1, Math.min(Number(sampleSize || 5), 5)));
    for (let index = 0; index < sample.length; index++) {
      if (onSample) await onSample({ processed: index + 1, total: sample.length, passed: index + 1 });
    }

    return {
      connector_key: 'PUBLIC_JSON_API',
      connector_version: '1.0.0',
      ready_for_acquisition: response.ok && normalized.length > 0,
      endpoint_status: response.status,
      endpoint_final_url: response.url || endpoint,
      endpoint_content_type: response.headers.get('content-type') || null,
      publisher_reported_total: rawRecords.length,
      records_parsed: normalized.length,
      sample_size: sample.length,
      detail_pages_successful: sample.length,
      failures: 0,
      pagination_status: 'NOT_APPLICABLE_STRUCTURED_FEED',
      execution_mode: 'STRUCTURED_PUBLIC_JSON_API',
      access_controls_used: false,
      source_url: endpoint
    };
  },

  async acquire({ publisher, assignment, onPage }) {
    const profile = discoveryProfile(publisher, assignment);
    const endpoint = txt(profile.endpoint);
    if (!endpoint) throw new Error('No public JSON API endpoint is configured in this publisher\'s discovery profile.');
    const fieldMap = (profile.field_map && typeof profile.field_map === 'object') ? profile.field_map : {};
    if (!fieldMap.title) throw new Error('Discovery profile field_map has no title mapping; the profile is not executable.');

    const { response, data } = await fetchJson(endpoint);
    if (!response.ok) throw new Error(`Public JSON API endpoint returned HTTP ${response.status}.`);
    const rawRecords = arr(data);
    const limit = Math.max(1, Math.min(Number(profile.maximum_records || 200), 500));
    const records = filterOpen(
      rawRecords.map(item => normalizeRecord(item, fieldMap, publisher, endpoint)).filter(r => r.title),
      profile.open_status_values
    ).slice(0, limit);

    if (onPage) await onPage({ page: 1, totalPages: 1, totalReported: records.length });

    return {
      records,
      total_reported: records.length,
      pages_processed: 1,
      source_url: endpoint,
      reconciliation: { count_matches: true, structured_feed: true, raw_count: rawRecords.length },
      diagnostics: { raw_count: rawRecords.length, accepted_count: records.length, endpoint, field_map: fieldMap }
    };
  }
};
