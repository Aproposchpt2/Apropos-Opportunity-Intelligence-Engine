import { createHash } from 'node:crypto';
import { response, parseBody, requireDashboardAuth, db } from './_shared/native-runtime.js';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const now = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const arr = value => Array.isArray(value) ? value : [];
const txt = value => String(value ?? '').trim();

function recordsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['results', 'items', 'records', 'data', 'opportunities', 'notices', 'solicitations', 'projects']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function latestAssignmentPerPublisher(assignments) {
  const selected = new Map();
  for (const assignment of assignments || []) {
    const key = String(assignment.publisher_id || '');
    if (!key || selected.has(key)) continue;
    selected.set(key, assignment);
  }
  return [...selected.values()];
}

function failureClass(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error?.name === 'AbortError' || /aborted|timeout/i.test(message)) return 'TIMEOUT';
  const match = message.match(/HTTP\s+(\d{3})/i);
  if (match) {
    const status = Number(match[1]);
    if (status === 401) return 'AUTH_REQUIRED';
    if (status === 403) return 'HTTP_FORBIDDEN';
    if (status === 404) return 'HTTP_NOT_FOUND';
    if (status === 429) return 'HTTP_RATE_LIMITED';
    if (status >= 500) return 'SOURCE_UNAVAILABLE';
    return `HTTP_${status}`;
  }
  if (/no individual solicitations/i.test(message)) return 'NO_SOLICITATIONS_FOUND';
  if (/fetch failed|network|connection|dns|socket/i.test(message)) return 'CONNECTION_FAILURE';
  if (/no acquisition endpoint/i.test(message)) return 'ENDPOINT_MISSING';
  return 'UNKNOWN';
}

function retryable(error) {
  return ['TIMEOUT', 'HTTP_RATE_LIMITED', 'SOURCE_UNAVAILABLE', 'CONNECTION_FAILURE'].includes(failureClass(error));
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function buildAccessProfile(assignment, publisher) {
  const searchParameters = parseJsonObject(assignment.search_parameters);
  const publisherConfiguration = parseJsonObject(publisher.configuration);
  const connection = {
    ...publisherConfiguration,
    ...parseJsonObject(searchParameters.connection_config)
  };
  const method = txt(assignment.acquisition_method || connection.access_method || publisher.acquisition_method).toUpperCase();
  const endpoint = txt(
    assignment.search_endpoint ||
    connection.primary_endpoint ||
    publisher.search_endpoint ||
    publisher.procurement_website ||
    publisher.official_website
  );
  return {
    method,
    endpoint,
    procurement_platform: txt(connection.procurement_platform) || null,
    technology_vendor: txt(connection.technology_vendor) || null,
    vendor_registration_url: txt(connection.vendor_registration_url || publisher.vendor_registration_url) || null,
    registration_required: connection.registration_required === true,
    authentication_required: connection.authentication_required === true,
    access_instructions: txt(connection.access_instructions) || null,
    official_sources: arr(connection.official_sources),
    acquisition_command: parseJsonObject(searchParameters.acquisition_command),
    pagination_instructions: parseJsonObject(assignment.pagination_instructions),
    attachment_instructions: parseJsonObject(assignment.attachment_instructions),
    amendment_instructions: parseJsonObject(assignment.amendment_instructions)
  };
}

async function fetchPublisher(profile) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const accept = profile.method === 'API'
        ? 'application/json,*/*;q=0.8'
        : profile.method === 'DOCUMENT_FEED'
          ? 'application/pdf,text/html,application/json,*/*;q=0.8'
          : 'text/html,application/json;q=0.9,*/*;q=0.8';
      const upstream = await fetch(profile.endpoint, {
        headers: {
          Accept: accept,
          'User-Agent': 'APROPOS-APIE-AcquisitionDiscovery/2.0',
          'Cache-Control': 'no-cache'
        },
        redirect: 'follow',
        signal: controller.signal
      });
      if (!upstream.ok) throw new Error(`Publisher endpoint returned HTTP ${upstream.status}`);
      return { upstream, attempts: attempt, retried: attempt > 1 };
    } catch (error) {
      lastError = error;
      if (attempt === 2 || !retryable(error)) break;
      await sleep(1200);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw Object.assign(lastError instanceof Error ? lastError : new Error(String(lastError)), { acquisitionAttempts: 2 });
}

function stripTags(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveUrl(href, base) {
  try { return new URL(href, base).toString(); } catch { return null; }
}

function extractSolicitationLinks(html, baseUrl) {
  const records = [];
  const seen = new Set();
  const linkPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const opportunityPattern = /\b(rfp|rfq|ifb|itb|bid|solicitation|procurement|proposal|quote|tender|project|opportunit|contract|addendum)\b/i;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const href = txt(match[1]);
    const label = stripTags(match[2]);
    const url = resolveUrl(href, baseUrl);
    if (!url || !/^https?:/i.test(url)) continue;
    if (!opportunityPattern.test(`${label} ${url}`)) continue;
    const key = url.replace(/#.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({
      record_type: 'INDIVIDUAL_SOLICITATION_CANDIDATE',
      title: label || 'Solicitation opportunity',
      source_url: key,
      official_source_url: key,
      discovered_from: baseUrl
    });
    if (records.length >= 500) break;
  }
  return records;
}

function extractRecords({ contentType, text, profile, finalUrl }) {
  if (contentType.includes('json')) {
    let payload;
    try { payload = JSON.parse(text); } catch { payload = null; }
    const records = recordsFromPayload(payload);
    return { records, pageType: records.length ? 'API_OR_JSON_LISTING' : 'EMPTY_JSON_RESPONSE' };
  }

  if (contentType.includes('pdf') || /\.pdf(?:$|\?)/i.test(finalUrl)) {
    return {
      pageType: 'SOLICITATION_DOCUMENT',
      records: [{
        record_type: 'SOLICITATION_DOCUMENT',
        title: finalUrl.split('/').pop() || 'Procurement document',
        source_url: finalUrl,
        official_source_url: finalUrl,
        document_url: finalUrl
      }]
    };
  }

  const links = extractSolicitationLinks(text, finalUrl);
  if (links.length) return { records: links, pageType: 'OPPORTUNITY_LISTING_PAGE' };

  const visibleText = stripTags(text).slice(0, 5000);
  const looksLikeIndividual = /\b(solicitation number|bid number|proposal due|response deadline|scope of work|statement of work|invitation for bid|request for proposal|request for qualifications)\b/i.test(visibleText);
  if (looksLikeIndividual) {
    return {
      pageType: 'INDIVIDUAL_SOLICITATION_PAGE',
      records: [{
        record_type: 'INDIVIDUAL_SOLICITATION_PAGE',
        title: visibleText.slice(0, 240),
        description: visibleText,
        source_url: finalUrl,
        official_source_url: finalUrl
      }]
    };
  }

  return { records: [], pageType: 'PUBLISHER_OR_PORTAL_LANDING_PAGE' };
}

async function insertRawRows(rawRows) {
  if (!rawRows.length) return [];
  try {
    return await db('acquisition_raw_records?on_conflict=publisher_id,source_record_id,source_fingerprint', {
      method: 'POST',
      body: JSON.stringify(rawRows),
      headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }
    }) || [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/duplicate key value|unique constraint/i.test(message)) return [];
    throw error;
  }
}

export const handler = async event => {
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event)) return response(401, { error: 'Unauthorized' });

  const body = parseBody(event);
  const commandRunId = txt(body.command_run_id);
  const stateCode = txt(body.state_code).toUpperCase();
  const publisherScope = txt(body.publisher_scope || 'ALL').toUpperCase();
  const publisherId = body.publisher_id ? txt(body.publisher_id) : null;

  if (!commandRunId || !/^[A-Z]{2}$/.test(stateCode)) return response(400, { error: 'command_run_id and state_code are required' });
  if (!['ALL', 'SINGLE'].includes(publisherScope)) return response(400, { error: 'publisher_scope must be ALL or SINGLE' });
  if (publisherScope === 'SINGLE' && !publisherId) return response(400, { error: 'publisher_id is required when publisher_scope is SINGLE' });

  try {
    await db(`command_runs?id=eq.${commandRunId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'running', aadp_state: 'RUNNING', current_stage: 'RESOLVING_PUBLISHER_CONNECTION_PROFILES',
        progress_value: 10, last_activity_at: now(),
        result_summary: 'Acquisition Discovery is loading verified publisher connection configurations and access methods.'
      })
    });

    const publisherFilter = publisherScope === 'SINGLE' ? `&id=eq.${encodeURIComponent(publisherId)}` : '';
    const publishers = await db(`publisher_registry?state_code=eq.${stateCode}&verified=eq.true${publisherFilter}&select=*`);
    const publisherIds = new Set((publishers || []).map(p => String(p.id)));
    const assignments = await db('publisher_assignments?status=eq.READY&select=*&order=updated_at.desc');
    const matching = (assignments || []).filter(a => publisherIds.has(String(a.publisher_id)));
    const selected = latestAssignmentPerPublisher(matching);

    if (!publishers?.length || !selected.length) {
      const reason = !publishers?.length
        ? `No verified publishers are available for ${stateCode}. Run Publisher Discovery first.`
        : `No READY publisher connection assignments are available for ${stateCode}. Run Publisher Discovery to create the handoff configuration.`;
      await db(`command_runs?id=eq.${commandRunId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'failed', aadp_state: 'FAILED', current_stage: 'PUBLISHER_HANDOFF_UNAVAILABLE',
          action_required: true, progress_value: 100, completed_at: now(), last_activity_at: now(), result_summary: reason
        })
      });
      return response(200, { ok: false, reason: 'PUBLISHER_HANDOFF_UNAVAILABLE' });
    }

    let discovered = 0, acquired = 0, failures = 0, warnings = 0, retries = 0, retryRecoveries = 0;
    const failureDetails = [];
    const methodUsage = {};

    for (let index = 0; index < selected.length; index++) {
      const assignment = selected[index];
      const publisher = (publishers || []).find(p => String(p.id) === String(assignment.publisher_id)) || {};
      const publisherName = assignment.publisher_name || publisher.publisher_name || 'Unknown publisher';
      const profile = buildAccessProfile(assignment, publisher);
      methodUsage[profile.method || 'UNSPECIFIED'] = (methodUsage[profile.method || 'UNSPECIFIED'] || 0) + 1;
      const baseEvidence = {
        runtime: 'NETLIFY_NATIVE',
        agent: 'ACQUISITION_DISCOVERY',
        publisher_id: assignment.publisher_id,
        publisher_name: publisherName,
        assignment_id: assignment.id,
        publisher_scope: publisherScope,
        connection_profile: profile,
        connection_profile_source: 'PUBLISHER_DISCOVERY_REPORT'
      };
      const created = await db('acquisition_runs', {
        method: 'POST',
        body: JSON.stringify({ command_run_id: commandRunId, assignment_id: assignment.id, status: 'RUNNING', started_at: now(), evidence: baseEvidence })
      });
      const acquisitionRun = created?.[0];

      try {
        if (!profile.endpoint) throw new Error('Publisher has no acquisition endpoint');
        const { upstream, attempts, retried } = await fetchPublisher(profile);
        if (retried) { retries++; retryRecoveries++; }
        const contentType = upstream.headers.get('content-type') || '';
        const finalUrl = upstream.url || profile.endpoint;
        const text = await upstream.text();
        const extraction = extractRecords({ contentType, text, profile, finalUrl });
        const records = extraction.records.filter(Boolean);
        if (!records.length) throw new Error(`No individual solicitations found; source classified as ${extraction.pageType}.`);

        discovered += records.length;
        const rawRows = records.slice(0, 500).map((record, recordIndex) => {
          const serialized = JSON.stringify(record);
          const sourceId = record.id || record.noticeId || record.solicitation_number || record.solicitationNumber || record.source_url || `${assignment.id}-${recordIndex}`;
          const sourceFingerprint = hash(`${assignment.publisher_id}:${sourceId}:${record.source_url || finalUrl}`);
          return {
            acquisition_run_id: acquisitionRun.id,
            assignment_id: assignment.id,
            publisher_id: assignment.publisher_id,
            source_record_id: String(sourceId),
            source_url: record.source_url || finalUrl,
            raw_payload: {
              ...record,
              __acquisition_method: profile.method,
              __procurement_platform: profile.procurement_platform,
              __publisher_connection_profile: profile,
              __source_page_type: extraction.pageType
            },
            source_fingerprint: sourceFingerprint,
            content_fingerprint: hash(serialized),
            processing_status: 'RAW'
          };
        });
        const inserted = await insertRawRows(rawRows);
        acquired += inserted.length;
        if (inserted.length < rawRows.length) warnings += rawRows.length - inserted.length;

        await db(`acquisition_runs?id=eq.${acquisitionRun.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'COMPLETED',
            records_discovered: records.length,
            records_acquired: inserted.length,
            pages_processed: 1,
            pagination_complete: true,
            completed_at: now(),
            evidence: {
              ...baseEvidence,
              content_type: contentType,
              final_url: finalUrl,
              source_page_type: extraction.pageType,
              attempts,
              retry_recovered: retried,
              duplicate_or_existing_records: rawRows.length - inserted.length
            }
          })
        });
      } catch (error) {
        failures++;
        const message = error instanceof Error ? error.message : String(error);
        const classification = failureClass(error);
        const attempts = Number(error?.acquisitionAttempts || 1);
        if (attempts > 1) retries++;
        failureDetails.push({
          publisher_id: assignment.publisher_id,
          publisher_name: publisherName,
          assignment_id: assignment.id,
          endpoint: profile.endpoint,
          acquisition_method: profile.method,
          procurement_platform: profile.procurement_platform,
          error: message,
          failure_class: classification,
          attempts
        });
        await db(`acquisition_runs?id=eq.${acquisitionRun.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'FAILED', retrieval_failures: 1, completed_at: now(),
            evidence: { ...baseEvidence, error: message, failure_class: classification, attempts }
          })
        });
      }

      const progress = Math.min(95, 15 + Math.round(((index + 1) / selected.length) * 80));
      await db(`command_runs?id=eq.${commandRunId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          current_stage: 'DISCOVERING_INDIVIDUAL_SOLICITATIONS', progress_value: progress,
          records_discovered: discovered, records_acquired: acquired, warning_count: warnings, failure_count: failures,
          last_activity_at: now()
        })
      });
    }

    const succeeded = selected.length - failures;
    const allFailed = failures === selected.length;
    const partial = failures > 0 && !allFailed;
    const finalStatus = allFailed ? 'failed' : 'completed';
    const aadpState = allFailed ? 'FAILED' : partial ? 'PARTIALLY_COMPLETE' : 'COMPLETED';
    const summary = allFailed
      ? `Acquisition Discovery found no usable individual solicitations across ${selected.length} publisher connection profiles.`
      : `Acquisition Discovery processed ${selected.length} publisher connection profiles, found ${discovered} individual solicitation candidates, and stored ${acquired} new raw contract records.`;

    const evidence = {
      runtime: 'NETLIFY_NATIVE',
      agent: 'ACQUISITION_DISCOVERY',
      state_code: stateCode,
      publisher_scope: publisherScope,
      publisher_id: publisherId,
      publisher_handoff_source: 'PUBLISHER_DISCOVERY_REPORT',
      ready_assignments_before_deduplication: matching.length,
      publishers_processed: selected.length,
      publishers_succeeded: succeeded,
      publisher_success_rate: selected.length ? Math.round((succeeded / selected.length) * 100) : 0,
      individual_solicitations_discovered: discovered,
      raw_contract_records_inserted: acquired,
      duplicate_or_existing_records: warnings,
      access_methods_used: methodUsage,
      failures,
      retries,
      retry_recoveries: retryRecoveries,
      failure_details: failureDetails,
      completion_classification: allFailed ? 'FAILED' : partial ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED'
    };

    await db(`command_runs?id=eq.${commandRunId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: finalStatus,
        aadp_state: aadpState,
        current_stage: 'COMPLETED',
        progress_value: 100,
        records_discovered: discovered,
        records_acquired: acquired,
        records_accepted: acquired,
        records_rejected: 0,
        warning_count: warnings + (partial ? failures : 0),
        failure_count: allFailed ? failures : 0,
        completed_at: now(),
        last_activity_at: now(),
        action_required: failures > 0,
        result_summary: summary,
        execution_evidence: evidence
      })
    });

    return response(200, {
      ok: !allFailed,
      completion_classification: evidence.completion_classification,
      command_run_id: commandRunId,
      publishers_processed: selected.length,
      publishers_succeeded: succeeded,
      individual_solicitations_discovered: discovered,
      raw_contract_records_inserted: acquired,
      duplicate_or_existing_records: warnings,
      access_methods_used: methodUsage,
      failures,
      failure_details: failureDetails
    });
  } catch (error) {
    console.error('command-acquisition-worker-background failed', error);
    try {
      await db(`command_runs?id=eq.${commandRunId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'failed', aadp_state: 'FAILED', current_stage: 'WORKER_FAILED', action_required: true,
          completed_at: now(), last_activity_at: now(), result_summary: error instanceof Error ? error.message : String(error)
        })
      });
    } catch {}
    return response(500, { error: error instanceof Error ? error.message : String(error) });
  }
};
