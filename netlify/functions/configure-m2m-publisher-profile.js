// Transforms verified manual-discovery evidence already sitting in
// publisher_registry + publisher_assignments into an executable M2M
// discovery profile, so Acquisition Discovery can resolve a real adapter
// for a newly admitted publisher without hand-editing connector code.
//
// Source of truth discipline (AOIE_BOOTSTRAP.md / AOIE_DECISION_LOG.md):
//   - derive ONLY from evidence already on the publisher/assignment record;
//   - never perform general web discovery — the one live fetch this
//     function makes is to dereference a data.gov catalog URL the
//     publisher's OWN evidence already names as an official_source, not to
//     search for anything new;
//   - never fabricate a field mapping — if the resolved feed's shape can't
//     be confidently mapped, return MANUAL_REVIEW_REQUIRED with the actual
//     sample keys, not a guess;
//   - never overwrite richer existing configuration — only fill gaps.

import { response, parseBody, requireDashboardAuth, db } from './_shared/native-runtime.js';

const now = () => new Date().toISOString();
const txt = value => String(value ?? '').trim();
const arr = value => Array.isArray(value) ? value : [];
const asObject = value => (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};

const STATUS = Object.freeze({
  CONFIGURED: 'CONFIGURED',
  ALREADY_CONFIGURED: 'ALREADY_CONFIGURED',
  MANUAL_REVIEW_REQUIRED: 'MANUAL_REVIEW_REQUIRED',
  UNSUPPORTED_METHOD: 'UNSUPPORTED_METHOD'
});

// Distinct from PRODUCTION_CERTIFIED/CONNECTED/ACCEPTED/VERIFIED, which are
// earned through command-verify-publisher-connection-background.js (EAG-001)
// against real acceptance evidence. This marker means only: "M2M Acquisition
// Discovery can resolve and run something for this publisher" — nothing more.
const DISCOVERY_CONFIGURED = 'DISCOVERY_CONFIGURED';

// --- field-mapping heuristics -------------------------------------------

const FIELD_SYNONYMS = {
  title: ['title', 'name', 'solicitation_title', 'bid_title', 'description'],
  source_record_id: ['id', 'rampid', 'bidid', 'bid_number', 'notice_id', 'solicitation_number'],
  status: ['stagename', 'status', 'stage', 'state'],
  posted_date: ['bidpost', 'posted_date', 'posteddate', 'open_date', 'issue_date', 'startdate'],
  due_date: ['closedate', 'due_date', 'duedate', 'deadline', 'end_date', 'enddate'],
  department: ['department', 'agency', 'agency_name', 'buyer', 'issuing_department'],
  detail_url: ['url', 'link', 'detail_url', 'source_url'],
  solicitation_number: ['solicitation_number', 'bid_number', 'notice_id', 'rampid'],
  procurement_platform: ['platform', 'procurement_platform']
};

// Some feeds nest the real link one level down (RAMP's own open-data export
// wraps it as {"url": {"url": "https://..."}}). Detect and record the
// correct dotted path rather than assuming a flat key.
function resolveFieldPath(sampleRecord, candidateKeys) {
  for (const key of candidateKeys) {
    if (!(key in sampleRecord)) continue;
    const value = sampleRecord[key];
    if (value && typeof value === 'object' && typeof value.url === 'string') return `${key}.url`;
    if (typeof value === 'string' || typeof value === 'number') return key;
  }
  return null;
}

function inferFieldMap(sampleRecord) {
  if (!sampleRecord || typeof sampleRecord !== 'object') return { fieldMap: null, missing: ['no sample record available'] };
  const fieldMap = {};
  const missing = [];
  for (const [canonical, candidates] of Object.entries(FIELD_SYNONYMS)) {
    const path = resolveFieldPath(sampleRecord, candidates);
    if (path) fieldMap[canonical] = path;
    else if (canonical === 'title' || canonical === 'due_date' || canonical === 'status') missing.push(canonical);
  }
  if (missing.length) return { fieldMap: null, missing, sampleKeys: Object.keys(sampleRecord) };
  return { fieldMap, missing: [], sampleKeys: Object.keys(sampleRecord) };
}

function inferOpenStatusValues(records, fieldMap) {
  if (!fieldMap?.status) return [];
  const seen = new Set();
  for (const record of records.slice(0, 200)) {
    const value = txt(record?.[fieldMap.status]);
    if (value) seen.add(value);
  }
  // Only treat statuses that read as unambiguously "still open" as open.
  // Anything else (Closed, Awarded, Cancelled, Withdrawn, ...) is left out
  // rather than guessed into either bucket.
  const openLike = [...seen].filter(v => /^(open|active|amended|posted)$/i.test(v));
  return openLike;
}

// --- resolving a named official_source into a concrete fetchable endpoint --

async function resolveDataGovCatalogEndpoint(catalogUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(catalogUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'APROPOS-Publisher-Engineering/1.0', Accept: 'text/html' },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!res.ok) return null;
    const html = await res.text();
    // data.gov catalog pages link out to the underlying Socrata (or similar)
    // export resource. Prefer an explicit JSON export link.
    const jsonMatch = html.match(/href="([^"]+\.json[^"]*)"/i) || html.match(/href="([^"]+query\.json[^"]*)"/i);
    if (jsonMatch) return new URL(jsonMatch[1], catalogUrl).toString();
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveOpenDataEndpoint(officialSources) {
  for (const sourceUrl of arr(officialSources)) {
    const url = txt(sourceUrl);
    if (!url) continue;
    let hostname = '';
    try { hostname = new URL(url).hostname.toLowerCase(); } catch { continue; }
    if (hostname === 'catalog.data.gov') {
      const resolved = await resolveDataGovCatalogEndpoint(url);
      if (resolved) return { endpoint: resolved, reference: url };
    }
    if (/\.json(\?|$)/i.test(url)) return { endpoint: url, reference: url };
  }
  return null;
}

// --- evidence gathering ---------------------------------------------------

function gatherEvidence(publisher, assignment) {
  const publisherConfig = asObject(publisher?.configuration);
  const searchParameters = asObject(assignment?.search_parameters);
  const connectionConfig = asObject(searchParameters.connection_config);
  // Assignment (manual-discovery-derived) values win over stale publisher
  // config when both exist, matching "preserve manual discovery evidence."
  const merged = { ...publisherConfig, ...searchParameters, ...connectionConfig };
  return {
    publisherConfig,
    searchParameters,
    merged,
    machineToMachine: publisher?.machine_to_machine_supported === true || publisherConfig.machine_to_machine_supported === true,
    browserAutomationRequired: merged.browser_automation_required === true,
    javascriptRequired: merged.javascript_required === true,
    openDataAvailable: merged.open_data_available === true,
    officialSources: arr(merged.official_sources),
    accessMethod: txt(publisher?.acquisition_method || merged.access_method),
    connectorStrategy: txt(publisher?.connector_strategy || merged.connector_strategy || merged.recommended_connector_strategy),
    endpoint: txt(assignment?.search_endpoint || publisher?.search_endpoint || publisher?.procurement_website || publisher?.official_website),
    alreadyConfigured: publisherConfig.discovery_configuration_status === DISCOVERY_CONFIGURED
      && Boolean(publisherConfig.connector_key)
      && asObject(publisherConfig.acquisition_discovery_profile).endpoint
  };
}

// --- main derivation (pure aside from the one named-source dereference) ---

export async function deriveDiscoveryProfile({ publisher, assignment }) {
  if (!publisher) return { status: STATUS.MANUAL_REVIEW_REQUIRED, reasons: ['Publisher not found.'] };

  const evidence = gatherEvidence(publisher, assignment);
  if (!evidence.machineToMachine) {
    return { status: STATUS.UNSUPPORTED_METHOD, reasons: ['Publisher is not classified machine_to_machine_supported.'] };
  }
  if (!assignment || txt(assignment.status).toUpperCase() !== 'READY') {
    return { status: STATUS.MANUAL_REVIEW_REQUIRED, reasons: ['No READY publisher_assignments row exists yet; manual discovery must establish a verified assignment first.'] };
  }
  if (evidence.alreadyConfigured) {
    return { status: STATUS.ALREADY_CONFIGURED, reasons: ['discovery_configuration_status is already DISCOVERY_CONFIGURED with a connector_key and endpoint on record.'] };
  }

  const runtimeFamily = evidence.browserAutomationRequired || evidence.javascriptRequired ? 'BROWSER_REQUIRED' : 'DIRECT_HTTP_HTML';

  // Path 1: a genuine public open-data feed is on record. Preferred whenever
  // available, per each publisher's own documented connector_strategy —
  // it's a real structured-HTTP source, not a browser-dependent one, even
  // when the primary portal itself is BROWSER_REQUIRED.
  if (evidence.openDataAvailable && evidence.officialSources.length) {
    const resolved = await resolveOpenDataEndpoint(evidence.officialSources);
    if (resolved) {
      const probe = await fetch(resolved.endpoint, {
        headers: { 'User-Agent': 'APROPOS-Publisher-Engineering/1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(20000)
      }).catch(() => null);
      const sample = probe?.ok ? await probe.json().catch(() => null) : null;
      const records = arr(sample);
      if (records.length) {
        const { fieldMap, missing, sampleKeys } = inferFieldMap(records[0]);
        if (fieldMap) {
          const openStatusValues = inferOpenStatusValues(records, fieldMap);
          return {
            status: STATUS.CONFIGURED,
            reasons: [`Resolved a public open-data JSON feed from the publisher's own official_sources evidence (${resolved.reference}) and derived a field mapping from a live sample of ${records.length} records.`],
            configurationPatch: {
              connector_key: 'PUBLIC_JSON_API',
              discovery_configuration_status: DISCOVERY_CONFIGURED,
              discovery_configuration_source: 'MANUAL_DISCOVERY_EVIDENCE_DERIVED',
              discovery_configured_at: now(),
              acquisition_discovery_profile: {
                enabled: true,
                connector_key: 'PUBLIC_JSON_API',
                runtime_family: 'PUBLIC_JSON_API',
                preserved_primary_runtime_family: runtimeFamily,
                endpoint: resolved.endpoint,
                endpoint_source_reference: resolved.reference,
                maximum_records: 200,
                field_map: fieldMap,
                open_status_values: openStatusValues,
                command_instruction: `Discover currently open procurement opportunities for ${publisher.publisher_name} using the city/agency-published open-data feed at ${resolved.endpoint}, per connector_strategy: ${evidence.connectorStrategy || 'use the published open-bid dataset for discovery.'} Live portal navigation and attachment retrieval are out of scope for this connector.`
              }
            }
          };
        }
        return {
          status: STATUS.MANUAL_REVIEW_REQUIRED,
          reasons: [`Resolved an open-data feed at ${resolved.endpoint} but could not confidently map its fields (missing: ${missing.join(', ')}).`],
          evidence: { sampleKeys }
        };
      }
    }
  }

  // Path 2: no usable open-data feed. Fall back to the agent adapter, but
  // only if the profile can carry a real command instruction — never a
  // silent guess, and never for a runtime family with no capable adapter.
  if (runtimeFamily === 'BROWSER_REQUIRED') {
    return {
      status: STATUS.MANUAL_REVIEW_REQUIRED,
      reasons: [
        'Manual discovery evidence requires browser automation (javascript_required/browser_automation_required=true) and no open-data alternative resolved.',
        'No real browser/Playwright-capable connector exists in this codebase yet — routing this publisher through a non-browser adapter would misrepresent the documented runtime, so it is left for manual review rather than forced.'
      ]
    };
  }

  const accessInstructions = txt(evidence.merged.access_instructions || evidence.merged.detail_resolution_method);
  if (!evidence.endpoint || !accessInstructions) {
    return {
      status: STATUS.MANUAL_REVIEW_REQUIRED,
      reasons: [
        !evidence.endpoint ? 'No search_endpoint/procurement_website is on record.' : null,
        !accessInstructions ? 'No access_instructions/detail_resolution_method evidence to compose a command instruction from.' : null
      ].filter(Boolean)
    };
  }

  return {
    status: STATUS.CONFIGURED,
    reasons: ['Derived an AGENT_PUBLIC_SOURCE_DISCOVERY command instruction from documented access_instructions/detail_resolution_method evidence.'],
    configurationPatch: {
      connector_key: 'AGENT_PUBLIC_SOURCE_DISCOVERY',
      discovery_configuration_status: DISCOVERY_CONFIGURED,
      discovery_configuration_source: 'MANUAL_DISCOVERY_EVIDENCE_DERIVED',
      discovery_configured_at: now(),
      acquisition_discovery_profile: {
        enabled: true,
        connector_key: 'AGENT_PUBLIC_SOURCE_DISCOVERY',
        runtime_family: runtimeFamily,
        command_instruction: `${accessInstructions} Do not log in, register, or bypass access controls. Work only from ${evidence.endpoint} and pages/documents directly linked from it.`
      }
    }
  };
}

// --- persistence: merge, never clobber ------------------------------------

function deepMergeConfiguration(existing, patch) {
  const merged = { ...asObject(existing) };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
      merged[key] = { ...merged[key], ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

async function latestReadyAssignment(publisherId) {
  return (await db(`publisher_assignments?publisher_id=eq.${encodeURIComponent(publisherId)}&status=eq.READY&select=*&order=updated_at.desc&limit=1`))?.[0] || null;
}

export async function configureOnePublisher(publisherId) {
  const publisher = (await db(`publisher_registry?id=eq.${encodeURIComponent(publisherId)}&select=*`))?.[0];
  if (!publisher) return { publisher_id: publisherId, status: STATUS.MANUAL_REVIEW_REQUIRED, reasons: ['Publisher not found in publisher_registry.'] };

  const assignment = await latestReadyAssignment(publisherId);
  const result = await deriveDiscoveryProfile({ publisher, assignment });

  if (result.status === STATUS.CONFIGURED && result.configurationPatch) {
    const mergedConfiguration = deepMergeConfiguration(publisher.configuration, result.configurationPatch);
    await db(`publisher_registry?id=eq.${encodeURIComponent(publisherId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ configuration: mergedConfiguration, updated_at: now() })
    });
  }

  return {
    publisher_id: publisherId,
    publisher_name: publisher.publisher_name,
    status: result.status,
    reasons: result.reasons || [],
    connector_key: result.configurationPatch?.connector_key || null,
    evidence: result.evidence || null
  };
}

// --- HTTP handler -----------------------------------------------------

export const handler = async event => {
  if (event?.httpMethod === 'OPTIONS') return response(200, { ok: true });
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event)) return response(401, { error: 'Unauthorized' });

  try {
    const body = parseBody(event);
    const stateCode = txt(body.state_code).toUpperCase();
    const batch = body.batch === true;

    if (!batch) {
      const publisherId = txt(body.publisher_id);
      if (!publisherId) return response(400, { error: 'publisher_id is required.' });
      const result = await configureOnePublisher(publisherId);
      return response(200, result);
    }

    if (!/^[A-Z]{2}$/.test(stateCode)) return response(400, { error: 'Valid state_code is required for batch mode.' });
    const publishers = await db(`publisher_registry?state_code=eq.${encodeURIComponent(stateCode)}&machine_to_machine_supported=eq.true&select=id,publisher_name`);
    const results = [];
    for (const row of publishers || []) {
      // Sequential, not parallel: each configuration call makes a live
      // fetch against an external endpoint; batching safely means not
      // hammering multiple public agency sites concurrently.
      results.push(await configureOnePublisher(row.id).catch(error => ({
        publisher_id: row.id,
        publisher_name: row.publisher_name,
        status: STATUS.MANUAL_REVIEW_REQUIRED,
        reasons: [error instanceof Error ? error.message : String(error)]
      })));
    }

    const summary = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
    return response(200, {
      state_code: stateCode,
      evaluated: results.length,
      summary,
      manual_review: results.filter(r => r.status === STATUS.MANUAL_REVIEW_REQUIRED),
      results
    });
  } catch (error) {
    console.error('configure-m2m-publisher-profile failed', error);
    return response(500, { error: error instanceof Error ? error.message : String(error) });
  }
};
