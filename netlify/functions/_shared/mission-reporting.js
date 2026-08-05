import { createHash } from 'node:crypto';

export const NOT_REPORTED = 'NOT REPORTED';
export const TERMINAL_OUTCOMES = new Set([
  'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'COMPLETED_WITH_FAILURES',
  'FAILED', 'STOPPED', 'BLOCKED', 'PARTIALLY_COMPLETE', 'INTERRUPTED'
]);

const COMMON_SECTIONS = [
  'EXECUTIVE DETERMINATION', 'MISSION IDENTITY', 'AUTHORIZED SCOPE',
  'PUBLISHER AND CONNECTOR', 'RUN STATUS', 'EXECUTION TIMELINE',
  'STAGE-BY-STAGE EVIDENCE', 'TASK-SPECIFIC METRICS',
  'RECORDS OR DOCUMENTS AFFECTED', 'WARNINGS', 'FAILURES',
  'RECONCILIATION', 'REGISTRY OR DATABASE IMPACT', 'ARTIFACTS AND HASHES',
  'OPERATOR ACTIONS', 'FINAL ACCEPTANCE DECISION',
  'RESTART OR FOLLOW-UP INSTRUCTIONS', 'EVIDENCE APPENDIX'
];

const reportDefinition = (title, purpose, finalDeterminations) => ({
  title, purpose, required_sections: COMMON_SECTIONS, final_determinations: finalDeterminations
});

export const MISSION_REPORTS = Object.freeze({
  VERIFY_PUBLISHER_CONNECTION: reportDefinition(
    'EAG-001 Publisher Connection Verification Report',
    'Prove the current run-specific publisher connection verification without substituting historical certification.',
    ['CERTIFIED', 'TESTING', 'FAILED', 'STOPPED BEFORE VERIFICATION', 'STALLED BEFORE WORKER CLAIM', 'REVIEW REQUIRED']
  ),
  PUBLISHER_DISCOVERY: reportDefinition(
    'Publisher Discovery and Admission Report',
    'Document official-source discovery, duplicate review, admission, and READY assignment impact.',
    ['DISCOVERY COMPLETED', 'COMPLETED WITH EXCEPTIONS', 'NO QUALIFIED PUBLISHERS', 'STOPPED', 'FAILED', 'REVIEW REQUIRED']
  ),
  ACQUISITION_DISCOVERY: reportDefinition(
    'Publisher Opportunity Acquisition and Reconciliation Report',
    'Document current-run acquisition, qualification, and reconciliation.',
    ['RECONCILED', 'RECONCILED WITH TOLERATED VARIANCE', 'PARTIALLY RECONCILED', 'FAILED', 'STOPPED', 'REVIEW REQUIRED']
  ),
  CONTRACT_PACKAGE_ACQUISITION: reportDefinition(
    'Complete Contract Package Acquisition Report',
    'Document package enumeration, download, hashing, extraction, readiness, and exceptions.',
    ['PACKAGE CAMPAIGN COMPLETE', 'COMPLETED WITH WARNINGS', 'PARTIALLY COMPLETE', 'FAILED', 'STOPPED', 'REVIEW REQUIRED']
  ),
  BUSINESS_DEVELOPMENT_DISCOVERY: reportDefinition(
    'Business Development Discovery Report',
    'Document organizations, sources, qualification, contacts, registry records, exceptions, and priorities.',
    ['COMPLETED', 'COMPLETED WITH EXCEPTIONS', 'STOPPED', 'FAILED', 'REVIEW REQUIRED']
  ),
  OPPORTUNITY_PARTNER_DISCOVERY: reportDefinition(
    'Opportunity Partner Discovery Report',
    'Document programs, businesses served, pilot/referral/buyer candidates, decision makers, and registry impact.',
    ['COMPLETED', 'COMPLETED WITH EXCEPTIONS', 'STOPPED', 'FAILED', 'REVIEW REQUIRED']
  ),
  INSTITUTIONAL_BUYER_DISCOVERY: reportDefinition(
    'Institutional Buyer Discovery Report',
    'Document authority, funding, purchase/pilot/licensing/sponsorship fit, decision makers, and priority tiers.',
    ['COMPLETED', 'COMPLETED WITH EXCEPTIONS', 'STOPPED', 'FAILED', 'REVIEW REQUIRED']
  ),
  STATE_MISSION: reportDefinition(
    'State Mission Execution Report',
    'Document state-scoped execution evidence, outputs, exceptions, reconciliation, and registry impact.',
    ['COMPLETED', 'COMPLETED WITH WARNINGS', 'PARTIALLY COMPLETE', 'STOPPED', 'FAILED', 'REVIEW REQUIRED']
  ),
  AADP_PROCESSING: reportDefinition(
    'AADP Processing Execution Report',
    'Document processing tasks, attempts, outcomes, checkpoints, warnings, failures, and downstream impact.',
    ['COMPLETED', 'COMPLETED WITH WARNINGS', 'PARTIALLY COMPLETE', 'STOPPED', 'FAILED', 'REVIEW REQUIRED']
  ),
  AOIE_ANALYSIS: reportDefinition(
    'AOIE Analysis Execution Report',
    'Document analysis inputs, task evidence, ranked outputs, warnings, failures, and acceptance.',
    ['COMPLETED', 'COMPLETED WITH WARNINGS', 'PARTIALLY COMPLETE', 'STOPPED', 'FAILED', 'REVIEW REQUIRED']
  ),
  PROCUREMENT_INVENTORY: reportDefinition(
    'Procurement Inventory Execution Report',
    'Document inventory scope, record impact, reconciliation, exceptions, and database impact.',
    ['COMPLETED', 'COMPLETED WITH WARNINGS', 'PARTIALLY COMPLETE', 'STOPPED', 'FAILED', 'REVIEW REQUIRED']
  ),
  CONTRACT_LIFECYCLE: reportDefinition(
    'Contract Lifecycle Execution Report',
    'Document lifecycle evaluations, status changes, verification requirements, exceptions, and downstream impact.',
    ['COMPLETED', 'COMPLETED WITH WARNINGS', 'PARTIALLY COMPLETE', 'STOPPED', 'FAILED', 'REVIEW REQUIRED']
  )
});

export const reported = value => value !== undefined && value !== null && value !== '';
export const normalizeMissionType = value => String(value || '').trim().toUpperCase();
export const resolveReportDefinition = value => MISSION_REPORTS[normalizeMissionType(value)] || null;

export function get(source, path) {
  return String(path || '').split('.').reduce((value, key) => value == null ? undefined : value[key], source);
}
export function first(source, paths, fallback) {
  for (const path of paths || []) {
    const value = get(source, path);
    if (reported(value)) return value;
  }
  return fallback;
}

export function normalizeRunOutcome(value) {
  const raw = String(value || '').trim().toUpperCase().replaceAll('-', '_').replaceAll(' ', '_');
  const aliases = {
    QUEUED: 'DRAFT', PENDING: 'DRAFT', CREATED: 'DRAFT', RUNNING: 'DRAFT',
    PROCESSING: 'DRAFT', RETRYING: 'DRAFT', STOPPING: 'DRAFT',
    CANCELLED: 'STOPPED', CANCELED: 'STOPPED', COMPLETE: 'COMPLETED',
    COMPLETED_WITH_WARNING: 'COMPLETED_WITH_WARNINGS',
    COMPLETED_WITH_FAILURE: 'COMPLETED_WITH_FAILURES',
    PARTIAL: 'PARTIALLY_COMPLETE', PARTIALLY_COMPLETED: 'PARTIALLY_COMPLETE'
  };
  const normalized = aliases[raw] || raw || 'DRAFT';
  return TERMINAL_OUTCOMES.has(normalized) ? normalized : 'DRAFT';
}
export const isTerminalOutcome = value => TERMINAL_OUTCOMES.has(normalizeRunOutcome(value));

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((out, key) => {
    out[key] = canonicalize(value[key]);
    return out;
  }, {});
  return value;
}
export const reportHash = report => createHash('sha256').update(JSON.stringify(canonicalize(report))).digest('hex');

export function workerClaimed(context) {
  const explicit = first(context, ['run.execution_evidence.worker_claimed', 'run.monitor_evidence.worker_claimed']);
  if (reported(explicit)) return explicit === true || String(explicit).toLowerCase() === 'true';
  return (context.attempts || []).some(row => reported(row.started_at)) ||
    (context.tasks || []).some(row => reported(row.started_at));
}

const exactStatus = value => String(value || NOT_REPORTED).trim().toUpperCase().replaceAll(' ', '_');
const count = rows => Array.isArray(rows) ? rows.length : 0;
const sum = (rows, key) => (rows || []).reduce((total, row) => total + (Number(row?.[key]) || 0), 0);
const metric = (label, source, value, evidenceSource, note = '') => ({
  label,
  source: reported(value) ? source : 'NOT REPORTED',
  value: reported(value) ? value : NOT_REPORTED,
  evidence_source: reported(value) ? evidenceSource : NOT_REPORTED,
  ...(note ? { note } : {})
});
const values = (rows, key) => [...new Set((rows || []).map(row => row?.[key]).filter(reported))];

function taskEvidence(context) {
  const evidence = { ...(context.run?.execution_evidence || {}) };
  for (const row of context.tasks || []) Object.assign(evidence, row.execution_evidence || {}, row.measurable_result || {}, row.output_payload || {});
  for (const row of context.attempts || []) Object.assign(evidence, row.evidence || {});
  return evidence;
}
const connector = (context, current) => {
  const row = (current ? context.currentConnectorEvidence : context.baselineConnectorEvidence)?.[0];
  return row ? { ...row, ...(row.acceptance_evidence || {}) } : {};
};

function verifyMetrics(context) {
  const current = { ...taskEvidence(context), ...connector(context, true) };
  const baseline = { ...(context.publisher?.configuration || {}), ...connector(context, false) };
  const cm = (label, paths, source = 'current-run execution evidence') =>
    metric(label, 'CURRENT RUN', first({ current }, paths.map(path => `current.${path}`)), source);
  const bm = (label, paths, source = 'publisher/connector baseline') =>
    metric(label, 'EXISTING BASELINE', first({ baseline }, paths.map(path => `baseline.${path}`)), source);
  const currentVersion = first({ current }, ['current.connector_version']);
  const baselineVersion = first({ baseline }, ['baseline.connector_version']);
  return [
    bm('Approved Publisher Profile', ['publisher_profile_approved', 'approval_status', 'verified']),
    bm('Profile Approval State', ['approval_status', 'publisher_profile_approved']),
    bm('Profile Completion State', ['profile_complete']),
    metric('READY Assignment', 'EXISTING BASELINE', context.assignment?.status || context.publisher?.access_status, context.assignment ? 'publisher_assignments' : 'publisher_registry'),
    bm('Connector Key', ['connector_key']),
    metric('Connector Version', reported(currentVersion) ? 'CURRENT RUN' : 'EXISTING BASELINE', currentVersion || baselineVersion, reported(currentVersion) ? 'current connector evidence' : 'baseline connector evidence'),
    bm('Connector Strategy', ['connector_strategy', 'recommended_connector_strategy']),
    cm('Endpoint Tested', ['endpoint_tested', 'endpoint', 'source_url']),
    cm('Search HTTP Result', ['search_http_result', 'http_status', 'connection']),
    cm('Search Response Time', ['search_response_ms', 'elapsed_ms']),
    cm('Publisher-Reported Count', ['publisher_reported_total', 'publisher_reported_count']),
    cm('Structured Records Parsed', ['structured_records_parsed', 'records_parsed', 'structured_records']),
    cm('Pagination Result', ['pagination_result', 'pagination_status']),
    cm('Sample Size', ['sample_size']),
    cm('Detail Pages Attempted', ['detail_pages_attempted', 'sample_size']),
    cm('Detail Pages Passed', ['detail_pages_passed', 'detail_pages_successful']),
    cm('Solicitation Numbers Found', ['solicitation_numbers_found']),
    cm('Attachments Detected', ['attachments_detected']),
    cm('Contacts Detected', ['contacts_detected', 'contacts_successful']),
    cm('Requirements Detected', ['requirements_detected', 'requirements_successful']),
    cm('Failed Samples', ['failed_samples', 'failures']),
    metric('Connector Acceptance Record', 'CURRENT RUN', context.currentConnectorEvidence?.[0]?.id, 'connector_acceptance_registry current run'),
    cm('EAG-001 Result', ['eag_001_result', 'result', 'connection']),
    metric('Acceptance Status', 'CURRENT RUN', context.currentConnectorEvidence?.[0]?.acceptance_status, 'connector_acceptance_registry current run'),
    cm('Certification Decision', ['certification_decision', 'certification_status']),
    metric('Reconciliation Status', 'CURRENT RUN', context.run?.reconciliation_status, 'command_runs'),
    metric('Validation Status', 'CURRENT RUN', context.run?.validation_status, 'command_runs')
  ];
}

function discoveryMetrics(context) {
  const candidates = context.candidates || [];
  const duplicates = candidates.filter(row => reported(row.duplicate_publisher_id) || String(row.duplicate_status || '').includes('DUPLICATE'));
  return [
    metric('Geographic Scope', 'CURRENT RUN', context.discovery?.discovery_scope || context.mission?.mission_config?.geographic_scope, 'publisher_discovery_runs / command_missions'),
    metric('State', 'CURRENT RUN', context.run?.state_code || context.discovery?.state_code, 'command_runs'),
    metric('County', 'CURRENT RUN', context.discovery?.county_name || context.run?.execution_evidence?.county_name, 'publisher_discovery_runs / command_runs'),
    metric('County FIPS', 'CURRENT RUN', context.discovery?.county_fips || context.run?.execution_evidence?.county_fips, 'publisher_discovery_runs / command_runs'),
    metric('Discovery Scope', 'CURRENT RUN', context.discovery?.discovery_scope, 'publisher_discovery_runs'),
    metric('Entity Classes Processed', 'CURRENT RUN', context.discovery?.organization_types, 'publisher_discovery_runs'),
    metric('Official Sources Researched', 'CURRENT RUN', context.discovery?.official_sources_identified, 'publisher_discovery_runs'),
    metric('Candidates Discovered', 'DERIVED ANALYSIS', candidates.length, 'candidate row count'),
    metric('Official Sources Verified', 'DERIVED ANALYSIS', candidates.filter(row => row.official_source_verified === true).length, 'candidate verification flags'),
    metric('Duplicate Registry Matches', 'DERIVED ANALYSIS', duplicates.length, 'candidate duplicate fields'),
    metric('Incomplete Candidates', 'DERIVED ANALYSIS', candidates.filter(row => !row.official_source_verified || !row.official_website || !row.acquisition_method).length, 'required-field analysis'),
    metric('Access Methods Identified', 'DERIVED ANALYSIS', values(candidates, 'acquisition_method'), 'publisher_discovery_candidates'),
    metric('Platforms Identified', 'DERIVED ANALYSIS', values(candidates, 'procurement_platform'), 'publisher_discovery_candidates'),
    metric('Machine-to-Machine Classifications', 'DERIVED ANALYSIS', values(candidates, 'machine_to_machine_supported'), 'publisher_discovery_candidates'),
    metric('Connector Strategies', 'DERIVED ANALYSIS', values(candidates, 'connector_strategy'), 'publisher_discovery_candidates'),
    metric('Engineering Complexity', 'DERIVED ANALYSIS', values(candidates, 'engineering_complexity'), 'publisher_discovery_candidates'),
    metric('Profiles Admitted', 'DERIVED ANALYSIS', candidates.filter(row => reported(row.admitted_publisher_id)).length, 'candidate admission fields'),
    metric('READY Assignments Created', 'DERIVED ANALYSIS', (context.discoveryAssignments || []).filter(row => String(row.status).toUpperCase() === 'READY').length, 'publisher_assignments'),
    metric('Candidates Sent to Exception Review', 'DERIVED ANALYSIS', candidates.filter(row => ['RESEARCH_REQUIRED', 'REJECTED'].includes(String(row.review_status).toUpperCase())).length, 'candidate review status'),
    metric('Registry Impact', 'CURRENT RUN', context.run?.registry_impact, 'command_runs'),
    metric('Duplicate Consolidation Actions', 'DERIVED ANALYSIS', duplicates.map(row => ({ candidate_id: row.id, duplicate_publisher_id: row.duplicate_publisher_id, status: row.duplicate_status })), 'candidate duplicate fields')
  ];
}

function acquisitionMetrics(context) {
  const runs = context.acquisitionRuns || [];
  const raw = context.rawRecords || [];
  const dispositions = context.dispositions || [];
  const rejections = context.rejections || [];
  const publisherCounts = runs.map(row => first(row, ['evidence.publisher_reported_total', 'evidence.publisher_reported_count'])).filter(reported);
  const publisherTotal = publisherCounts.length ? publisherCounts.reduce((a, b) => a + Number(b || 0), 0) : undefined;
  const difference = reported(publisherTotal) ? raw.length - publisherTotal : undefined;
  return [
    metric('Approved Publisher', 'EXISTING BASELINE', context.publisher?.publisher_name, 'publisher_registry'),
    metric('Certified Connector', 'EXISTING BASELINE', context.baselineConnectorEvidence?.[0]?.acceptance_status, 'connector_acceptance_registry'),
    metric('READY Assignment', 'CURRENT RUN', context.assignment?.status, 'publisher_assignments'),
    metric('Endpoint', 'CURRENT RUN', context.assignment?.search_endpoint, 'publisher_assignments'),
    metric('Acquisition Scope', 'CURRENT RUN', context.mission?.mission_config?.acquisition_scope || context.run?.execution_evidence?.acquisition_scope, 'mission/run evidence'),
    metric('Pages Processed', 'DERIVED ANALYSIS', sum(runs, 'pages_processed'), 'acquisition_runs'),
    metric('Batches Processed', 'DERIVED ANALYSIS', runs.length, 'acquisition_runs count'),
    metric('Publisher-Reported Count', 'CURRENT RUN', publisherTotal, 'acquisition_runs evidence'),
    metric('Raw Records Acquired', 'DERIVED ANALYSIS', raw.length, 'acquisition_raw_records count'),
    metric('Canonical Records Inserted', 'DERIVED ANALYSIS', dispositions.filter(row => String(row.disposition).toUpperCase() === 'QUALIFIED').length, 'acquisition_record_dispositions'),
    metric('Existing Records Updated', 'DERIVED ANALYSIS', dispositions.filter(row => String(row.disposition).toUpperCase().includes('UPDATE')).length, 'acquisition_record_dispositions'),
    metric('Duplicates', 'DERIVED ANALYSIS', dispositions.filter(row => String(row.disposition).toUpperCase().includes('DUPLICATE')).length, 'acquisition_record_dispositions'),
    metric('Records Rejected', 'DERIVED ANALYSIS', rejections.length, 'acquisition_rejections'),
    metric('Extraction-Required Records', 'DERIVED ANALYSIS', raw.filter(row => String(row.processing_status).includes('EXTRACTION') || String(row.detail_retrieval_status).toUpperCase() === 'PENDING').length, 'acquisition_raw_records'),
    metric('Contact-Required Records', 'DERIVED ANALYSIS', raw.filter(row => !row.raw_payload?.contact_email && !row.raw_payload?.contact_phone && !row.raw_payload?.contact_name).length, 'raw payload analysis'),
    metric('Missing Records', 'DERIVED ANALYSIS', reported(difference) && difference < 0 ? Math.abs(difference) : 0, 'publisher count versus raw count'),
    metric('Unexpected Records', 'DERIVED ANALYSIS', reported(difference) && difference > 0 ? difference : 0, 'raw count versus publisher count'),
    metric('Reconciliation Difference', 'DERIVED ANALYSIS', difference, 'raw count minus publisher count'),
    metric('Qualification Ruleset', 'CURRENT RUN', context.assignment?.qualification_ruleset_version, 'publisher_assignments'),
    metric('Acquisition Yield', 'DERIVED ANALYSIS', publisherTotal ? Number(((raw.length / publisherTotal) * 100).toFixed(2)) : undefined, 'raw records / publisher count'),
    metric('Connector Failures', 'DERIVED ANALYSIS', sum(runs, 'retrieval_failures'), 'acquisition_runs'),
    metric('Last Successful Checkpoint', 'CURRENT RUN', first(context, ['run.execution_evidence.last_checkpoint', 'run.resume_source_stage', 'run.current_stage']), 'command_runs')
  ];
}

function packageMetrics(context) {
  const raw = context.rawRecords || [];
  const docs = context.packageDocs || [];
  const completed = docs.filter(row => ['DOWNLOADED', 'RETRIEVED', 'COMPLETE', 'COMPLETED'].includes(String(row.retrieval_status).toUpperCase()));
  const hashed = docs.filter(row => reported(row.sha256));
  const byType = word => docs.filter(row => String(row.document_type || '').toUpperCase().includes(word)).length;
  return [
    metric('Contracts Targeted', 'DERIVED ANALYSIS', raw.length, 'acquisition_raw_records'),
    metric('Previously Complete Contracts Skipped', 'DERIVED ANALYSIS', raw.filter(row => String(row.package_status).toUpperCase() === 'PACKAGE_COMPLETE' && !row.package_completed_at).length, 'acquisition_raw_records'),
    metric('Packages Started', 'DERIVED ANALYSIS', raw.filter(row => String(row.package_status).toUpperCase() !== 'PACKAGE_NOT_STARTED').length, 'acquisition_raw_records'),
    metric('Packages Completed', 'DERIVED ANALYSIS', raw.filter(row => String(row.package_status).toUpperCase() === 'PACKAGE_COMPLETE').length, 'acquisition_raw_records'),
    metric('Package Manifests Enumerated', 'DERIVED ANALYSIS', raw.filter(row => Number(row.document_manifest_count || 0) > 0).length, 'acquisition_raw_records'),
    metric('Documents Listed', 'DERIVED ANALYSIS', docs.length, 'contract_package_documents'),
    metric('Documents Downloaded', 'DERIVED ANALYSIS', completed.length, 'contract_package_documents'),
    metric('Documents Hash-Verified', 'DERIVED ANALYSIS', hashed.length, 'contract_package_documents'),
    metric('Total Bytes Preserved', 'DERIVED ANALYSIS', sum(docs, 'byte_size'), 'contract_package_documents'),
    metric('File Types', 'DERIVED ANALYSIS', values(docs, 'file_extension'), 'contract_package_documents'),
    metric('Addenda Detected', 'DERIVED ANALYSIS', docs.filter(row => row.is_addendum === true).length, 'contract_package_documents'),
    metric('Amendments Detected', 'DERIVED ANALYSIS', docs.filter(row => row.is_amendment === true).length, 'contract_package_documents'),
    metric('Bidder Q&A Detected', 'DERIVED ANALYSIS', byType('Q&A'), 'contract_package_documents'),
    metric('Revised Documents Detected', 'DERIVED ANALYSIS', docs.filter(row => reported(row.version_label) && String(row.version_label).toUpperCase() !== 'ORIGINAL').length, 'contract_package_documents'),
    metric('Pricing Files Detected', 'DERIVED ANALYSIS', byType('PRIC'), 'contract_package_documents'),
    metric('Forms Detected', 'DERIVED ANALYSIS', byType('FORM'), 'contract_package_documents'),
    metric('Specifications Detected', 'DERIVED ANALYSIS', byType('SPEC'), 'contract_package_documents'),
    metric('Drawings Detected', 'DERIVED ANALYSIS', byType('DRAW'), 'contract_package_documents'),
    metric('Files Extracted', 'DERIVED ANALYSIS', docs.filter(row => ['EXTRACTED', 'COMPLETED'].includes(String(row.extraction_status).toUpperCase())).length, 'contract_package_documents'),
    metric('Non-Textual Files', 'DERIVED ANALYSIS', docs.filter(row => !String(row.mime_type || '').startsWith('text/')).length, 'contract_package_documents'),
    metric('Extraction Failures', 'DERIVED ANALYSIS', docs.filter(row => String(row.extraction_status).includes('FAIL')).length, 'contract_package_documents'),
    metric('Download Failures', 'DERIVED ANALYSIS', docs.filter(row => String(row.retrieval_status).includes('FAIL')).length, 'contract_package_documents'),
    metric('Retry Count', 'DERIVED ANALYSIS', sum(docs, 'retrieval_attempt_count'), 'contract_package_documents'),
    metric('Last Checkpoint', 'CURRENT RUN', first(context, ['run.execution_evidence.last_checkpoint', 'run.resume_source_stage', 'run.current_stage']), 'command_runs'),
    ...['PACKAGE_COMPLETE', 'BLOCKED_PACKAGE_INCOMPLETE', 'BLOCKED_REQUIREMENTS_INCOMPLETE', 'MATCH_READY', 'REVIEW_REQUIRED'].map(status =>
      metric(`${status} Count`, 'DERIVED ANALYSIS', raw.filter(row => String(row.package_status).toUpperCase() === status || String(row.match_readiness_status).toUpperCase() === status).length, 'acquisition_raw_records')
    ),
    metric('Evidence Archive Location', 'CURRENT RUN', values(docs, 'storage_bucket'), 'contract_package_documents'),
    metric('Storage Paths', 'CURRENT RUN', docs.map(row => row.storage_path).filter(reported), 'contract_package_documents'),
    metric('File Hashes', 'CURRENT RUN', hashed.map(row => ({ id: row.id, sha256: row.sha256 })), 'contract_package_documents')
  ];
}

function researchMetrics(context, type) {
  const evidence = taskEvidence(context);
  const fields = {
    BUSINESS_DEVELOPMENT_DISCOVERY: ['organizations_discovered', 'official_sources_verified', 'organizations_qualified', 'organizations_rejected', 'decision_makers', 'contact_records', 'registry_records', 'exceptions', 'priority_recommendations'],
    OPPORTUNITY_PARTNER_DISCOVERY: ['organizations_discovered', 'programs_verified', 'businesses_served', 'pilot_candidates', 'referral_candidates', 'institutional_buyers', 'decision_makers', 'registry_records', 'exceptions'],
    INSTITUTIONAL_BUYER_DISCOVERY: ['buyers_discovered', 'authority_verified', 'funding_evidence', 'purchase_fit', 'pilot_fit', 'licensing_fit', 'sponsorship_fit', 'decision_makers', 'priority_tiers', 'registry_impact', 'exceptions']
  }[type] || ['records_discovered', 'records_acquired', 'records_accepted', 'records_rejected', 'warning_count', 'failure_count', 'reconciliation_status', 'validation_status'];
  return fields.map(key => metric(key.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase()), 'CURRENT RUN', evidence[key] ?? context.run?.[key], 'command/task execution evidence'));
}

export function missionMetrics(context) {
  const type = normalizeMissionType(context.run?.mission_type_key || context.mission?.mission_type_key);
  if (type === 'VERIFY_PUBLISHER_CONNECTION') return verifyMetrics(context);
  if (type === 'PUBLISHER_DISCOVERY') return discoveryMetrics(context);
  if (type === 'ACQUISITION_DISCOVERY') return acquisitionMetrics(context);
  if (type === 'CONTRACT_PACKAGE_ACQUISITION') return packageMetrics(context);
  return researchMetrics(context, type);
}

const timelineEntry = (timestamp, event, status, source, detail = {}) =>
  reported(timestamp) ? { timestamp, event, status: status || NOT_REPORTED, evidence_source: source, ...detail } : null;

export function buildTimeline(context, generatedAt) {
  const rows = [
    timelineEntry(context.run?.created_at, 'Run created', exactStatus(context.run?.status), 'command_runs'),
    timelineEntry(context.run?.started_at, 'Run started / worker claimed', workerClaimed(context) ? 'CLAIMED' : NOT_REPORTED, 'command_runs / task evidence'),
    timelineEntry(context.run?.stop_requested_at, 'Operator stop request', 'STOP REQUESTED', 'command_runs'),
    timelineEntry(context.run?.completed_at, 'Run completed', exactStatus(context.run?.status), 'command_runs')
  ];
  for (const row of context.stages || []) {
    rows.push(timelineEntry(row.started_at || row.created_at || row.updated_at, `Stage: ${row.stage_name || row.display_name || row.stage_key || NOT_REPORTED}`, exactStatus(row.status || row.display_state), row.__source || 'stage projection'));
    rows.push(timelineEntry(row.completed_at, `Stage completed: ${row.stage_name || row.display_name || row.stage_key || NOT_REPORTED}`, exactStatus(row.status || row.display_state), row.__source || 'stage projection'));
  }
  for (const row of context.tasks || []) {
    rows.push(timelineEntry(row.created_at, `Task created: ${row.task_type}`, exactStatus(row.state), 'command_tasks'));
    rows.push(timelineEntry(row.started_at, `Task started: ${row.task_type}`, exactStatus(row.state), 'command_tasks'));
    rows.push(timelineEntry(row.completed_at, `Task completed: ${row.task_type}`, exactStatus(row.state), 'command_tasks'));
  }
  for (const row of context.attempts || []) {
    rows.push(timelineEntry(row.started_at, `Task attempt ${row.attempt_number} started`, exactStatus(row.state), 'command_task_attempts'));
    rows.push(timelineEntry(row.completed_at, `Task attempt ${row.attempt_number} completed`, exactStatus(row.state), 'command_task_attempts'));
  }
  for (const row of context.events || []) rows.push(timelineEntry(row.created_at, row.event_type || 'Execution event', exactStatus(row.severity || row.status), 'command_events', { message: row.message || NOT_REPORTED }));
  for (const row of context.failures || []) rows.push(timelineEntry(row.created_at, `Failure: ${row.failure_type}`, 'FAILED', 'command_failures', { message: row.error_message || NOT_REPORTED }));
  rows.push(timelineEntry(generatedAt, 'Report generated', 'RECORDED', 'mission reporting system'));
  return rows.filter(Boolean).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

export function buildStageEvidence(context) {
  const rows = context.stages?.length ? context.stages : (context.tasks || []).map(row => ({ ...row, stage_name: row.task_type, status: row.state, __source: 'command_tasks' }));
  if (!rows.length) return [{
    stage_name: NOT_REPORTED, stage_status: NOT_REPORTED, start_time: NOT_REPORTED,
    completion_time: NOT_REPORTED, responsible_agent: NOT_REPORTED,
    supporting_evidence: NOT_REPORTED, metrics_produced: NOT_REPORTED,
    warnings: NOT_REPORTED, errors: NOT_REPORTED, checkpoint: NOT_REPORTED,
    evidence_source: NOT_REPORTED
  }];
  return rows.map(row => ({
    stage_name: row.stage_name || row.display_name || row.stage_key || row.task_type || NOT_REPORTED,
    stage_status: exactStatus(row.status || row.display_state || row.state),
    start_time: row.started_at || NOT_REPORTED,
    completion_time: row.completed_at || NOT_REPORTED,
    responsible_agent: row.responsible_agent || row.assigned_agent || context.run?.assigned_agent || NOT_REPORTED,
    supporting_evidence: row.evidence || row.execution_evidence || row.detail || NOT_REPORTED,
    metrics_produced: row.metrics || row.measurable_result || NOT_REPORTED,
    warnings: reported(row.warning_count) ? row.warning_count : NOT_REPORTED,
    errors: row.errors || row.error_message || (reported(row.failure_count) ? row.failure_count : NOT_REPORTED),
    checkpoint: row.checkpoint || row.resume_stage || NOT_REPORTED,
    evidence_source: row.__source || 'stage projection'
  }));
}

function determination(context, outcome) {
  const type = normalizeMissionType(context.run?.mission_type_key);
  if (type === 'VERIFY_PUBLISHER_CONNECTION') {
    if (outcome === 'STOPPED') return 'STOPPED BEFORE VERIFICATION';
    if (outcome === 'DRAFT' && !workerClaimed(context)) return 'STALLED BEFORE WORKER CLAIM';
    if (['FAILED', 'BLOCKED'].includes(outcome)) return 'FAILED';
    return first({ current: taskEvidence(context) }, ['current.certification_decision', 'current.certification_status', 'current.eag_001_result'], 'REVIEW REQUIRED');
  }
  if (type === 'PUBLISHER_DISCOVERY') {
    if (outcome === 'STOPPED') return 'STOPPED';
    if (['FAILED', 'BLOCKED'].includes(outcome)) return 'FAILED';
    if (outcome === 'COMPLETED' && !(context.candidates || []).length) return 'NO QUALIFIED PUBLISHERS';
    if (outcome === 'COMPLETED') return 'DISCOVERY COMPLETED';
    if (outcome !== 'DRAFT') return 'COMPLETED WITH EXCEPTIONS';
    return 'REVIEW REQUIRED';
  }
  if (type === 'ACQUISITION_DISCOVERY') {
    if (outcome === 'STOPPED') return 'STOPPED';
    if (['FAILED', 'BLOCKED'].includes(outcome)) return 'FAILED';
    const value = String(context.run?.reconciliation_status || '').toUpperCase();
    if (value === 'RECONCILED') return 'RECONCILED';
    if (value.includes('TOLERATED')) return 'RECONCILED WITH TOLERATED VARIANCE';
    if (value.includes('PARTIAL')) return 'PARTIALLY RECONCILED';
    return 'REVIEW REQUIRED';
  }
  if (type === 'CONTRACT_PACKAGE_ACQUISITION') {
    if (outcome === 'COMPLETED') return 'PACKAGE CAMPAIGN COMPLETE';
    if (outcome === 'COMPLETED_WITH_WARNINGS') return 'COMPLETED WITH WARNINGS';
    if (['COMPLETED_WITH_FAILURES', 'PARTIALLY_COMPLETE'].includes(outcome)) return 'PARTIALLY COMPLETE';
  }
  if (outcome === 'COMPLETED') return 'COMPLETED';
  if (outcome === 'COMPLETED_WITH_WARNINGS') return 'COMPLETED WITH WARNINGS';
  if (['COMPLETED_WITH_FAILURES', 'PARTIALLY_COMPLETE'].includes(outcome)) return 'PARTIALLY COMPLETE';
  if (outcome === 'STOPPED') return 'STOPPED';
  if (['FAILED', 'BLOCKED', 'INTERRUPTED'].includes(outcome)) return 'FAILED';
  return 'REVIEW REQUIRED';
}

const evidenceLabel = label => ({ label, class: label === 'EXISTING BASELINE' ? 'baseline' : label === 'CURRENT RUN' ? 'current' : label === 'DERIVED ANALYSIS' ? 'derived' : 'not-reported' });

function publisherSection(context) {
  const baseline = context.baselineConnectorEvidence?.[0];
  const current = context.currentConnectorEvidence?.[0];
  return {
    publisher_id: context.publisher?.id || context.assignment?.publisher_id || context.run?.execution_evidence?.publisher_id || NOT_REPORTED,
    publisher_name: context.publisher?.publisher_name || context.assignment?.publisher_name || NOT_REPORTED,
    assignment: context.assignment || NOT_REPORTED,
    existing_baseline: baseline ? { evidence_label: evidenceLabel('EXISTING BASELINE'), publisher: context.publisher, connector: baseline } : { evidence_label: evidenceLabel('NOT REPORTED'), value: NOT_REPORTED },
    current_run: current ? { evidence_label: evidenceLabel('CURRENT RUN'), connector: current } : {
      evidence_label: evidenceLabel('NOT REPORTED'), value: NOT_REPORTED,
      note: 'Historical connector certification is not current-run execution evidence.'
    }
  };
}

function affected(context) {
  const rows = [
    ...(context.candidates || []).map(row => ({ type: 'PUBLISHER_CANDIDATE', id: row.id, status: row.review_status || NOT_REPORTED, name: row.publisher_name || NOT_REPORTED })),
    ...(context.rawRecords || []).map(row => ({ type: 'ACQUISITION_RAW_RECORD', id: row.id, source_record_id: row.source_record_id || NOT_REPORTED, status: row.processing_status || NOT_REPORTED })),
    ...(context.packageDocs || []).map(row => ({ type: 'CONTRACT_PACKAGE_DOCUMENT', id: row.id, filename: row.original_filename || NOT_REPORTED, status: row.retrieval_status || NOT_REPORTED, sha256: row.sha256 || NOT_REPORTED })),
    ...(context.opportunities || []).map(row => ({ type: 'STATE_CONTRACT_OPPORTUNITY', id: row.id, solicitation_number: row.solicitation_number || NOT_REPORTED, status: row.status || NOT_REPORTED }))
  ];
  return { total: rows.length, returned: Math.min(rows.length, 500), truncated: rows.length > 500, records: rows.slice(0, 500) };
}

function warningRows(context) {
  const rows = (context.events || []).filter(row => String(row.severity || '').toLowerCase().includes('warn')).map(row => ({
    type: row.event_type || 'WARNING', message: row.message || NOT_REPORTED,
    timestamp: row.created_at || NOT_REPORTED, evidence_source: 'command_events'
  }));
  const missing = Number(context.run?.warning_count || 0) - rows.length;
  if (missing > 0) rows.push({ type: 'WARNING DETAILS', message: `${missing} warning detail record(s) NOT REPORTED.`, timestamp: NOT_REPORTED, evidence_source: 'command_runs.warning_count' });
  return rows;
}
function failureRows(context) {
  const rows = (context.failures || []).map(row => ({
    type: row.failure_type || 'FAILURE', code: row.error_code || NOT_REPORTED,
    message: row.error_message || NOT_REPORTED, recoverable: reported(row.recoverable) ? row.recoverable : NOT_REPORTED,
    attempt_number: row.attempt_number || NOT_REPORTED, timestamp: row.created_at || NOT_REPORTED,
    evidence_source: 'command_failures'
  }));
  const missing = Number(context.run?.failure_count || 0) - rows.length;
  if (missing > 0) rows.push({ type: 'FAILURE DETAILS', code: NOT_REPORTED, message: `${missing} failure detail record(s) NOT REPORTED.`, timestamp: NOT_REPORTED, evidence_source: 'command_runs.failure_count' });
  return rows;
}

function operatorActions(context) {
  const rows = [];
  if (reported(context.run?.stop_requested_at)) rows.push({ action: 'STOP REQUESTED', timestamp: context.run.stop_requested_at, evidence_source: 'command_runs' });
  for (const row of context.audit || []) rows.push({
    action: row.action || row.event_type || row.operation || NOT_REPORTED,
    timestamp: row.occurred_at || row.created_at || NOT_REPORTED,
    actor: row.actor || row.performed_by || NOT_REPORTED, evidence_source: 'command_audit_log'
  });
  return rows.length ? rows : [{ action: NOT_REPORTED, timestamp: NOT_REPORTED, evidence_source: NOT_REPORTED }];
}

function followUp(context, outcome) {
  const checkpoint = first(context, ['run.resume_source_stage', 'run.execution_evidence.last_checkpoint', 'run.execution_evidence.prior_stage', 'run.current_stage'], NOT_REPORTED);
  if (outcome === 'STOPPED') return {
    instruction: workerClaimed(context)
      ? 'Review the last proven checkpoint before authorizing a new execution.'
      : 'Verify worker dispatch outside this reporting assignment, then authorize a new execution. Do not treat this stopped report as completed verification.',
    checkpoint
  };
  if (['FAILED', 'BLOCKED', 'INTERRUPTED'].includes(outcome)) return { instruction: 'Resolve the recorded blocker or failure and create a new execution or authorized amendment.', checkpoint };
  if (outcome === 'DRAFT') return { instruction: 'No final acceptance decision is authorized while the run is non-terminal.', checkpoint };
  return { instruction: 'Preserve this final report. Corrections require a new AMENDED version.', checkpoint };
}

export function buildMissionReport(context, options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const missionType = normalizeMissionType(context.run?.mission_type_key || context.mission?.mission_type_key);
  const definition = resolveReportDefinition(missionType);
  if (!definition) {
    const error = new Error('UNSUPPORTED REPORT TYPE');
    error.code = 'UNSUPPORTED_REPORT_TYPE';
    error.missionType = missionType || NOT_REPORTED;
    throw error;
  }
  const outcome = normalizeRunOutcome(context.run?.status || context.run?.aadp_state);
  const reportState = options.reportState || (outcome === 'DRAFT' ? 'DRAFT' : 'FINAL');
  const finalDecision = determination(context, outcome);
  const version = Number(options.reportVersion || 1);
  const reportId = options.reportId || `MR-${String(context.run?.id || 'UNKNOWN').slice(0, 8).toUpperCase()}-V${version}`;
  const warnings = warningRows(context);
  const failures = failureRows(context);
  const production = options.production || {};

  return {
    report_metadata: {
      report_id: reportId, report_version: version, report_state: reportState,
      report_title: definition.title, report_purpose: definition.purpose,
      generated_at: generatedAt,
      finalized_at: options.finalizedAt || (reportState === 'FINAL' ? generatedAt : NOT_REPORTED),
      amended_at: reportState === 'AMENDED' ? generatedAt : NOT_REPORTED,
      amendment_reason: options.amendmentReason || NOT_REPORTED,
      supersedes_report_id: options.supersedesReportId || NOT_REPORTED,
      original_evidence_hash: options.originalEvidenceHash || NOT_REPORTED,
      production_git_commit: production.commit || NOT_REPORTED,
      production_netlify_deploy: production.deployId || NOT_REPORTED,
      production_url: production.url || NOT_REPORTED,
      report_generator_version: 'APIE-MISSION-REPORTING-1.0'
    },
    executive_determination: {
      outcome, determination: finalDecision, worker_claimed: workerClaimed(context),
      summary: outcome === 'STOPPED' && !workerClaimed(context)
        ? 'The run stopped before worker claim. No current-run execution result is credited.'
        : outcome === 'DRAFT'
          ? 'This DRAFT reflects evidence available at capture time and is not final.'
          : 'The determination uses current-run evidence; baseline evidence is contextual only.'
    },
    mission_identity: {
      command_run_id: context.run?.id || NOT_REPORTED, mission_type_key: missionType,
      mission_name: context.run?.mission_name || context.mission?.mission_name || NOT_REPORTED,
      state: context.run?.state_code || context.mission?.state_code || NOT_REPORTED,
      county: context.discovery?.county_name || context.publisher?.county_name || context.run?.execution_evidence?.county_name || context.mission?.mission_config?.county_name || NOT_REPORTED,
      county_fips: context.discovery?.county_fips || context.publisher?.county_fips || context.run?.execution_evidence?.county_fips || context.mission?.mission_config?.county_fips || NOT_REPORTED,
      assigned_agent: context.run?.assigned_agent || context.mission?.assigned_agent || NOT_REPORTED,
      started_at: context.run?.started_at || NOT_REPORTED, completed_at: context.run?.completed_at || NOT_REPORTED,
      final_status: outcome
    },
    authorized_scope: {
      authorization_state: context.mission?.authorization_state || NOT_REPORTED,
      authorized_at: context.mission?.authorized_at || NOT_REPORTED,
      mission_config: context.mission?.mission_config || context.run?.execution_evidence || NOT_REPORTED,
      blocking_reasons: context.mission?.blocking_reasons || NOT_REPORTED
    },
    publisher_and_connector: publisherSection(context),
    run_status: {
      authoritative_status: exactStatus(context.run?.status || context.run?.aadp_state),
      report_outcome: outcome, report_state: reportState,
      current_stage: context.run?.current_stage || NOT_REPORTED,
      worker_claimed: workerClaimed(context),
      last_activity_at: context.run?.last_activity_at || context.run?.updated_at || NOT_REPORTED,
      stop_requested_at: context.run?.stop_requested_at || NOT_REPORTED,
      result_summary: context.run?.result_summary || NOT_REPORTED,
      warnings: reported(context.run?.warning_count) ? context.run.warning_count : NOT_REPORTED,
      failures: reported(context.run?.failure_count) ? context.run.failure_count : NOT_REPORTED
    },
    execution_timeline: buildTimeline(context, generatedAt),
    stage_by_stage_evidence: buildStageEvidence(context),
    task_specific_metrics: missionMetrics(context),
    records_or_documents_affected: affected(context),
    warnings: warnings.length ? warnings : [{ message: 'No warning records were reported.', evidence_source: 'command_events / command_runs' }],
    failures: failures.length ? failures : [{ message: 'No failure records were reported.', evidence_source: 'command_failures / command_runs' }],
    reconciliation: {
      status: context.run?.reconciliation_status || NOT_REPORTED,
      reconciliation: context.run?.reconciliation || NOT_REPORTED,
      diagnostics: context.run?.reconciliation_diagnostics || NOT_REPORTED,
      evidence_source: 'command_runs'
    },
    registry_or_database_impact: {
      registry_impact: context.run?.registry_impact || NOT_REPORTED,
      discovery_admissions: (context.candidates || []).filter(row => reported(row.admitted_publisher_id)).map(row => ({ candidate_id: row.id, admitted_publisher_id: row.admitted_publisher_id })),
      affected_table_counts: {
        command_tasks: count(context.tasks), command_task_attempts: count(context.attempts),
        publisher_discovery_candidates: count(context.candidates), acquisition_runs: count(context.acquisitionRuns),
        acquisition_raw_records: count(context.rawRecords), contract_package_documents: count(context.packageDocs),
        state_contract_opportunities: count(context.opportunities)
      }
    },
    artifacts_and_hashes: {
      documents: (context.packageDocs || []).map(row => ({
        id: row.id, filename: row.original_filename || NOT_REPORTED,
        storage_bucket: row.storage_bucket || NOT_REPORTED, storage_path: row.storage_path || NOT_REPORTED,
        byte_size: reported(row.byte_size) ? row.byte_size : NOT_REPORTED, sha256: row.sha256 || NOT_REPORTED
      })),
      production
    },
    operator_actions: operatorActions(context),
    final_acceptance_decision: {
      determination: finalDecision, allowed_determinations: definition.final_determinations,
      accepted: ['COMPLETED', 'CERTIFIED', 'DISCOVERY COMPLETED', 'RECONCILED', 'PACKAGE CAMPAIGN COMPLETE'].includes(finalDecision),
      evidence_basis: 'CURRENT RUN evidence controls acceptance. EXISTING BASELINE is contextual only.'
    },
    restart_or_follow_up_instructions: followUp(context, outcome),
    evidence_appendix: {
      evidence_labels: [evidenceLabel('EXISTING BASELINE'), evidenceLabel('CURRENT RUN'), evidenceLabel('DERIVED ANALYSIS'), evidenceLabel('NOT REPORTED')],
      sources_read: context.sourceStatus || [], source_read_failures: context.readFailures || [],
      command_metrics: context.metrics || [], command_events: context.events || [],
      command_failures: context.failures || [], command_task_attempts: context.attempts || [],
      existing_executive_run_reports: context.existingReports || []
    }
  };
}
