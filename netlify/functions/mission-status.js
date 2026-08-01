import { response, parseBody, requireDashboardAuth, db } from './_shared/native-runtime.js';

const enc = value => encodeURIComponent(String(value || ''));
const safe = async (name, request, failures) => {
  try { return await db(request); }
  catch (error) {
    failures.push({ source: name, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
};

export const handler = async event => {
  if (event?.httpMethod === 'OPTIONS') return response(200, { ok: true });
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event)) return response(401, { error: 'Unauthorized' });

  const body = parseBody(event);
  const commandRunId = String(body.command_run_id || body.run_id || '').trim();
  if (!commandRunId) return response(400, { error: 'command_run_id required' });

  try {
    const run = (await db(`command_runs?id=eq.${enc(commandRunId)}&select=*`))?.[0];
    if (!run) return response(404, { error: 'Mission not found' });

    const readFailures = [];
    const [commandStages, unifiedStages, tasks, events, failures, reports, audit, acquisitionRuns] = await Promise.all([
      safe('command_stage_projection', `command_stage_projection?command_run_id=eq.${enc(commandRunId)}&select=*&order=sequence_number.asc`, readFailures),
      safe('command_unified_stage_projection', `command_unified_stage_projection?command_run_id=eq.${enc(commandRunId)}&select=*&order=updated_at.asc`, readFailures),
      safe('command_tasks', `command_tasks?run_id=eq.${enc(commandRunId)}&select=*&order=created_at.asc`, readFailures),
      safe('command_events', `command_events?run_id=eq.${enc(commandRunId)}&select=*&order=created_at.asc`, readFailures),
      safe('command_failures', `command_failures?run_id=eq.${enc(commandRunId)}&select=*&order=created_at.desc`, readFailures),
      safe('executive_run_reports', `executive_run_reports?command_run_id=eq.${enc(commandRunId)}&select=*`, readFailures),
      safe('command_audit_log', `command_audit_log?command_run_id=eq.${enc(commandRunId)}&select=*&order=occurred_at.desc`, readFailures),
      safe('acquisition_runs', `acquisition_runs?command_run_id=eq.${enc(commandRunId)}&select=*&order=created_at.asc`, readFailures)
    ]);

    let publisherDiscovery = null;
    let publisherCandidates = [];
    if (String(run.mission_type_key || '').toUpperCase() === 'PUBLISHER_DISCOVERY') {
      publisherDiscovery = (await safe('publisher_discovery_runs', `publisher_discovery_runs?command_run_id=eq.${enc(commandRunId)}&select=*&order=created_at.desc&limit=1`, readFailures))?.[0] || null;
      if (publisherDiscovery?.id) {
        publisherCandidates = await safe('publisher_discovery_candidates', `publisher_discovery_candidates?discovery_run_id=eq.${enc(publisherDiscovery.id)}&select=*&order=publisher_name.asc`, readFailures);
      }
    }

    const acquisitionRunIds = (acquisitionRuns || []).map(item => item.id).filter(Boolean);
    let rawRecords = [];
    let dispositions = [];
    let rejections = [];
    for (const acquisitionRunId of acquisitionRunIds) {
      const [raw, dispositionRows, rejectionRows] = await Promise.all([
        safe('acquisition_raw_records', `acquisition_raw_records?acquisition_run_id=eq.${enc(acquisitionRunId)}&select=*&order=retrieval_timestamp.asc`, readFailures),
        safe('acquisition_record_dispositions', `acquisition_record_dispositions?acquisition_run_id=eq.${enc(acquisitionRunId)}&select=*`, readFailures),
        safe('acquisition_rejections', `acquisition_rejections?acquisition_run_id=eq.${enc(acquisitionRunId)}&select=*`, readFailures)
      ]);
      rawRecords = rawRecords.concat(raw || []);
      dispositions = dispositions.concat(dispositionRows || []);
      rejections = rejections.concat(rejectionRows || []);
    }

    const executionStages = commandStages?.length ? commandStages : unifiedStages;
    const derivedEvents = [
      ...events,
      ...(acquisitionRuns || []).map(item => ({
        event_type: 'ACQUISITION_RUN',
        created_at: item.started_at || item.created_at,
        status: item.status,
        publisher_id: item.publisher_id,
        message: item.error_message || item.result_summary || `Acquisition run ${item.status || 'recorded'}`,
        evidence: item
      }))
    ].sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));

    const acquisitionFailures = (acquisitionRuns || [])
      .filter(item => String(item.status || '').toUpperCase().includes('FAIL') || item.error_message)
      .map(item => ({
        source: 'ACQUISITION_RUN',
        publisher_id: item.publisher_id,
        acquisition_run_id: item.id,
        error: item.error_message || item.result_summary || 'Acquisition failed',
        created_at: item.completed_at || item.updated_at || item.created_at
      }));

    return response(200, {
      run,
      stages: executionStages || [],
      tasks: tasks || [],
      events: derivedEvents,
      failures: [...(failures || []), ...acquisitionFailures],
      reports: reports || [],
      audit: audit || [],
      publisher_discovery: publisherDiscovery,
      publisher_candidates: publisherCandidates,
      acquisition: {
        runs: acquisitionRuns || [],
        raw_records: rawRecords,
        dispositions,
        rejections,
        totals: {
          runs: acquisitionRuns.length,
          raw_records: rawRecords.length,
          qualified: dispositions.filter(item => String(item.disposition || '').toUpperCase() === 'QUALIFIED').length,
          rejected: rejections.length,
          failures: acquisitionFailures.length
        }
      },
      health: {
        status: readFailures.length ? 'DEGRADED' : 'OPERATIONAL',
        partial_read_failures: readFailures
      }
    });
  } catch (error) {
    console.error('mission-status failed', error);
    return response(500, { error: error instanceof Error ? error.message : String(error) });
  }
};
