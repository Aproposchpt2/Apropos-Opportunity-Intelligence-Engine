import { response, parseBody, requireDashboardAuth, db } from './_shared/native-runtime.js';

const enc = value => encodeURIComponent(String(value || ''));
const safe = async (name, request, failures) => {
  try { return await db(request); }
  catch (error) {
    failures.push({ source: name, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
};

function derivedStages(run, publisherDiscovery, acquisitionRuns) {
  const stages = [];
  let sequence = 1;
  const add = (stage_key, stage_name, status, detail, at) => stages.push({
    sequence_number: sequence++, stage_key, stage_name, status, detail,
    updated_at: at || run.updated_at || run.last_activity_at || run.created_at
  });
  if (publisherDiscovery || String(run.mission_type_key || '').toUpperCase() === 'PUBLISHER_DISCOVERY') {
    add('PUBLISHER_DISCOVERY', 'Publisher Discovery', 'COMPLETED', `${run.records_discovered || 0} publisher candidates discovered.`, publisherDiscovery?.started_at || run.started_at);
    add('PUBLISHER_VALIDATION', 'Publisher Validation', 'COMPLETED', `${run.records_accepted || 0} publisher candidates accepted.`, publisherDiscovery?.updated_at);
    add('ASSIGNMENT_CREATION', 'Assignment Creation', 'COMPLETED', 'Qualified publishers were admitted and READY assignments were prepared.', publisherDiscovery?.completed_at || publisherDiscovery?.updated_at);
  }
  if ((acquisitionRuns || []).length) {
    const successes = acquisitionRuns.filter(item => String(item.status || '').toUpperCase() === 'COMPLETED').length;
    const failures = acquisitionRuns.filter(item => String(item.status || '').toUpperCase().includes('FAIL')).length;
    add('ACQUISITION_DISCOVERY', 'Acquisition Discovery', failures && successes ? 'COMPLETED_WITH_WARNINGS' : failures ? 'FAILED' : 'COMPLETED', `${successes} publisher acquisitions completed; ${failures} failed.`, acquisitionRuns.at(-1)?.completed_at || acquisitionRuns.at(-1)?.created_at);
  }
  add('MISSION_COMPLETE', 'Mission Complete', String(run.status || '').toLowerCase() === 'failed' ? 'FAILED' : (run.warning_count || 0) > 0 ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED', run.result_summary || 'Mission execution finished.', run.completed_at || run.updated_at);
  return stages;
}

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
      if (publisherDiscovery?.id) publisherCandidates = await safe('publisher_discovery_candidates', `publisher_discovery_candidates?discovery_run_id=eq.${enc(publisherDiscovery.id)}&select=*&order=publisher_name.asc`, readFailures);
    }

    const assignmentIds = [...new Set((acquisitionRuns || []).map(item => item.assignment_id).filter(Boolean))];
    let assignments = [];
    for (const assignmentId of assignmentIds) {
      const rows = await safe('publisher_assignments', `publisher_assignments?id=eq.${enc(assignmentId)}&select=*`, readFailures);
      assignments = assignments.concat(rows || []);
    }
    const assignmentsById = new Map(assignments.map(item => [String(item.id), item]));

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

    const enrichedRuns = (acquisitionRuns || []).map(item => {
      const assignment = assignmentsById.get(String(item.assignment_id)) || {};
      const evidence = item.evidence || {};
      return {
        ...item,
        publisher_id: evidence.publisher_id || assignment.publisher_id || null,
        publisher_name: evidence.publisher_name || assignment.publisher_name || 'Unknown publisher',
        acquisition_method: evidence.acquisition_method || assignment.acquisition_method || null,
        endpoint: evidence.endpoint || assignment.search_endpoint || null,
        error_message: evidence.error || item.error_message || null
      };
    });

    const executionStages = commandStages?.length ? commandStages : unifiedStages?.length ? unifiedStages : derivedStages(run, publisherDiscovery, enrichedRuns);
    const derivedEvents = [
      ...events,
      ...enrichedRuns.map(item => ({
        event_type: 'ACQUISITION_RUN',
        created_at: item.started_at || item.created_at,
        status: item.status,
        publisher_id: item.publisher_id,
        publisher_name: item.publisher_name,
        message: item.error_message || `${item.publisher_name}: acquisition run ${item.status || 'recorded'}`,
        evidence: item
      }))
    ].sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));

    const acquisitionFailures = enrichedRuns
      .filter(item => String(item.status || '').toUpperCase().includes('FAIL') || item.error_message)
      .map(item => ({
        source: 'ACQUISITION_RUN',
        publisher_id: item.publisher_id,
        publisher_name: item.publisher_name,
        assignment_id: item.assignment_id,
        acquisition_run_id: item.id,
        acquisition_method: item.acquisition_method,
        endpoint: item.endpoint,
        error: item.error_message || 'Acquisition failed',
        created_at: item.completed_at || item.created_at
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
        runs: enrichedRuns,
        raw_records: rawRecords,
        dispositions,
        rejections,
        totals: {
          runs: enrichedRuns.length,
          raw_records: rawRecords.length,
          qualified: dispositions.filter(item => String(item.disposition || '').toUpperCase() === 'QUALIFIED').length,
          rejected: rejections.length,
          failures: acquisitionFailures.length
        }
      },
      health: { status: readFailures.length ? 'DEGRADED' : 'OPERATIONAL', partial_read_failures: readFailures }
    });
  } catch (error) {
    console.error('mission-status failed', error);
    return response(500, { error: error instanceof Error ? error.message : String(error) });
  }
};
