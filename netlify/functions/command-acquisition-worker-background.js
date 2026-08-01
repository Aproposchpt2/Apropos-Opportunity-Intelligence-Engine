import { createHash } from 'node:crypto';
import { response, parseBody, requireDashboardAuth, db } from './_shared/native-runtime.js';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const now = () => new Date().toISOString();

function recordsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [payload];
  for (const key of ['results', 'items', 'records', 'data', 'opportunities', 'notices']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [payload];
}

export const handler = async (event) => {
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event)) return response(401, { error: 'Unauthorized' });

  const body = parseBody(event);
  const commandRunId = String(body.command_run_id || '');
  const stateCode = String(body.state_code || '').toUpperCase();
  const publisherScope = String(body.publisher_scope || 'ALL').toUpperCase();
  const publisherId = body.publisher_id ? String(body.publisher_id) : null;

  if (!commandRunId || !/^[A-Z]{2}$/.test(stateCode)) {
    return response(400, { error: 'command_run_id and state_code are required' });
  }
  if (!['ALL', 'SINGLE'].includes(publisherScope)) {
    return response(400, { error: 'publisher_scope must be ALL or SINGLE' });
  }
  if (publisherScope === 'SINGLE' && !publisherId) {
    return response(400, { error: 'publisher_id is required when publisher_scope is SINGLE' });
  }

  try {
    await db(`command_runs?id=eq.${commandRunId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'running', aadp_state: 'RUNNING', current_stage: 'RESOLVING_PUBLISHERS', progress_value: 10, last_activity_at: now() })
    });

    const publisherFilter = publisherScope === 'SINGLE'
      ? `&id=eq.${encodeURIComponent(publisherId)}`
      : '';
    const publishers = await db(`publisher_registry?state_code=eq.${stateCode}&verified=eq.true${publisherFilter}&select=id,publisher_name,state_code,search_endpoint,procurement_website,official_website`);
    const publisherIds = new Set((publishers || []).map(p => String(p.id)));
    const assignments = await db('publisher_assignments?status=eq.READY&select=*&order=updated_at.desc');
    const selected = (assignments || []).filter(a => publisherIds.has(String(a.publisher_id)));

    if (!publishers?.length) {
      const reason = publisherScope === 'SINGLE'
        ? `The selected publisher is not a verified ${stateCode} publisher or does not exist.`
        : `No verified publishers are available for ${stateCode}.`;
      await db(`command_runs?id=eq.${commandRunId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'failed', aadp_state: 'FAILED', current_stage: 'NO_VERIFIED_PUBLISHERS', action_required: true, progress_value: 100, completed_at: now(), last_activity_at: now(), result_summary: reason, execution_evidence: { runtime: 'NETLIFY_NATIVE', state_code: stateCode, publisher_scope: publisherScope, publisher_id: publisherId, blocker_code: 'NO_VERIFIED_PUBLISHERS' } })
      });
      return response(200, { ok: false, reason: 'NO_VERIFIED_PUBLISHERS' });
    }

    if (!selected.length) {
      const reason = publisherScope === 'SINGLE'
        ? `No READY acquisition assignment exists for the selected publisher in ${stateCode}.`
        : `No READY verified publisher assignments are available for ${stateCode}.`;
      await db(`command_runs?id=eq.${commandRunId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'failed', aadp_state: 'FAILED', current_stage: 'NO_READY_ASSIGNMENTS', action_required: true, progress_value: 100, completed_at: now(), last_activity_at: now(), result_summary: reason, execution_evidence: { runtime: 'NETLIFY_NATIVE', state_code: stateCode, publisher_scope: publisherScope, publisher_id: publisherId, blocker_code: 'NO_READY_ASSIGNMENTS', verified_publishers_found: publishers.length } })
      });
      return response(200, { ok: false, reason: 'NO_READY_ASSIGNMENTS' });
    }

    let discovered = 0, acquired = 0, failures = 0;
    for (let index = 0; index < selected.length; index++) {
      const assignment = selected[index];
      const publisher = (publishers || []).find(p => String(p.id) === String(assignment.publisher_id)) || {};
      const endpoint = assignment.search_endpoint || publisher.search_endpoint || publisher.procurement_website || publisher.official_website;
      const created = await db('acquisition_runs', {
        method: 'POST',
        body: JSON.stringify({ command_run_id: commandRunId, assignment_id: assignment.id, status: 'RUNNING', started_at: now(), evidence: { runtime: 'NETLIFY_NATIVE', endpoint, publisher_name: assignment.publisher_name || publisher.publisher_name, publisher_scope: publisherScope } })
      });
      const acquisitionRun = created?.[0];
      try {
        if (!endpoint) throw new Error('Publisher has no acquisition endpoint');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 25000);
        let upstream;
        try {
          upstream = await fetch(endpoint, { headers: { Accept: 'application/json,text/html;q=0.9,*/*;q=0.8', 'User-Agent': 'APROPOS-APIE/1.0' }, signal: controller.signal });
        } finally {
          clearTimeout(timeout);
        }
        if (!upstream.ok) throw new Error(`Publisher endpoint returned HTTP ${upstream.status}`);
        const contentType = upstream.headers.get('content-type') || '';
        const text = await upstream.text();
        let payload;
        if (contentType.includes('json')) {
          try { payload = JSON.parse(text); } catch { payload = { raw_text: text }; }
        } else {
          payload = { html: text, content_type: contentType };
        }
        const records = recordsFromPayload(payload).filter(record => record !== null && record !== undefined);
        discovered += records.length;
        const rawRows = records.slice(0, 500).map((record, recordIndex) => {
          const serialized = typeof record === 'string' ? record : JSON.stringify(record);
          const sourceId = record?.id || record?.noticeId || record?.solicitation_number || record?.solicitationNumber || `${assignment.id}-${recordIndex}`;
          return {
            acquisition_run_id: acquisitionRun.id,
            assignment_id: assignment.id,
            publisher_id: assignment.publisher_id,
            source_record_id: String(sourceId),
            source_url: endpoint,
            raw_payload: typeof record === 'object' && record !== null ? record : { value: record },
            source_fingerprint: hash(`${endpoint}:${sourceId}`),
            content_fingerprint: hash(serialized),
            processing_status: 'RAW'
          };
        });
        if (rawRows.length) await db('acquisition_raw_records', { method: 'POST', body: JSON.stringify(rawRows), headers: { Prefer: 'resolution=ignore-duplicates,return=representation' } });
        acquired += rawRows.length;
        await db(`acquisition_runs?id=eq.${acquisitionRun.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'COMPLETED', records_discovered: records.length, records_acquired: rawRows.length, pages_processed: 1, pagination_complete: true, completed_at: now() }) });
      } catch (error) {
        failures++;
        await db(`acquisition_runs?id=eq.${acquisitionRun.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'FAILED', retrieval_failures: 1, completed_at: now(), evidence: { runtime: 'NETLIFY_NATIVE', error: error instanceof Error ? error.message : String(error), publisher_scope: publisherScope } }) });
      }

      const progress = Math.min(95, 15 + Math.round(((index + 1) / selected.length) * 80));
      await db(`command_runs?id=eq.${commandRunId}`, { method: 'PATCH', body: JSON.stringify({ current_stage: 'ACQUIRING_PUBLISHERS', progress_value: progress, records_acquired: acquired, failure_count: failures, last_activity_at: now() }) });
    }

    const finalStatus = failures === selected.length ? 'failed' : failures > 0 ? 'completed_with_failures' : 'completed';
    const aadpState = failures === selected.length ? 'FAILED' : failures > 0 ? 'PARTIALLY_COMPLETE' : 'COMPLETED';
    await db(`command_runs?id=eq.${commandRunId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: finalStatus, aadp_state: aadpState, current_stage: null, progress_value: 100, records_acquired: acquired, failure_count: failures, completed_at: now(), last_activity_at: now(), action_required: failures > 0, result_summary: `Processed ${selected.length} publisher assignments; discovered ${discovered}; acquired ${acquired}; failures ${failures}.`, execution_evidence: { runtime: 'NETLIFY_NATIVE', state_code: stateCode, publisher_scope: publisherScope, publisher_id: publisherId, publishers_processed: selected.length, records_discovered: discovered, records_acquired: acquired, failures } })
    });
    return response(200, { ok: true, command_run_id: commandRunId, publisher_scope: publisherScope, publisher_id: publisherId, publishers_processed: selected.length, records_discovered: discovered, records_acquired: acquired, failures });
  } catch (error) {
    console.error('command-acquisition-worker-background failed', error);
    try {
      await db(`command_runs?id=eq.${commandRunId}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed', aadp_state: 'FAILED', current_stage: 'WORKER_FAILED', action_required: true, completed_at: now(), last_activity_at: now(), result_summary: error instanceof Error ? error.message : String(error) }) });
    } catch {}
    return response(500, { error: error instanceof Error ? error.message : String(error) });
  }
};
