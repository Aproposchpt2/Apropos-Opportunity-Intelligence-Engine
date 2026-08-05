const reportParams = new URLSearchParams(location.search);
const commandRunId = reportParams.get('id');
const requestedVersion = reportParams.get('version');
let loadedReport = null;
let loadedStorage = null;

const byId = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const label = value => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, char => char.toUpperCase());
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const isNotReported = value => value === 'NOT REPORTED' || value === undefined || value === null || value === '';

function dateValue(value) {
  if (isNotReported(value)) return 'NOT REPORTED';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
}

function primitive(value) {
  if (isNotReported(value)) return '<span class="not-reported">NOT REPORTED</span>';
  if (typeof value === 'boolean') return value ? 'YES' : 'NO';
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString() : esc(value);
  return esc(value);
}

function renderValue(value, depth = 0) {
  if (isNotReported(value)) return '<span class="not-reported">NOT REPORTED</span>';
  if (Array.isArray(value)) {
    if (!value.length) return '<span class="not-reported">NONE REPORTED</span>';
    if (value.every(item => !isObject(item) && !Array.isArray(item))) {
      return `<ul class="value-list">${value.map(item => `<li>${primitive(item)}</li>`).join('')}</ul>`;
    }
    if (depth > 1 || value.length > 30) {
      const displayed = value.slice(0, 30);
      return `<pre class="json-value">${esc(JSON.stringify(displayed, null, 2))}${value.length > 30 ? `\n… ${value.length - 30} more record(s)` : ''}</pre>`;
    }
    return renderTable(value);
  }
  if (isObject(value)) {
    if (depth > 2) return `<pre class="json-value">${esc(JSON.stringify(value, null, 2))}</pre>`;
    return renderObjectGrid(value, depth + 1);
  }
  return primitive(value);
}

function renderObjectGrid(object, depth = 0) {
  return `<div class="object-grid">${Object.entries(object || {}).map(([key, value]) => `
    <div class="field">
      <span>${esc(label(key))}</span>
      <div>${renderValue(value, depth)}</div>
    </div>`).join('')}</div>`;
}

function renderTable(rows) {
  const objects = (rows || []).filter(isObject);
  if (!objects.length) return renderValue(rows);
  const columns = [...new Set(objects.flatMap(row => Object.keys(row)))].slice(0, 12);
  return `<div class="table-wrap"><table class="report-table">
    <thead><tr>${columns.map(column => `<th>${esc(label(column))}</th>`).join('')}</tr></thead>
    <tbody>${objects.map(row => `<tr>${columns.map(column => `<td>${renderValue(row[column], 2)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

function card(kicker, title, content, extra = '', className = '') {
  return `<section class="report-card ${esc(className)}">
    <div class="section-heading">
      <div><p class="report-kicker">${esc(kicker)}</p><h2>${esc(title)}</h2></div>
      ${extra}
    </div>
    ${content}
  </section>`;
}

function evidenceClass(source) {
  const normalized = String(source || '').toUpperCase();
  if (normalized.includes('BASELINE')) return 'baseline';
  if (normalized.includes('CURRENT')) return 'current';
  if (normalized.includes('DERIVED')) return 'derived';
  return 'not-reported';
}

function renderMetrics(metrics) {
  return `<div class="table-wrap"><table class="report-table">
    <thead><tr><th>Metric</th><th>Evidence Classification</th><th>Value</th><th>Evidence Source</th><th>Note</th></tr></thead>
    <tbody>${(metrics || []).map(item => `<tr>
      <td><strong>${esc(item.label)}</strong></td>
      <td><span class="evidence-badge ${evidenceClass(item.source)}">${esc(item.source || 'NOT REPORTED')}</span></td>
      <td>${renderValue(item.value, 1)}</td>
      <td>${primitive(item.evidence_source)}</td>
      <td>${primitive(item.note || 'NOT REPORTED')}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function renderPublisher(section) {
  const baseline = section?.existing_baseline || {};
  const current = section?.current_run || {};
  return `
    <div class="summary-grid">
      <div class="field"><span>Publisher ID</span><strong>${primitive(section?.publisher_id)}</strong></div>
      <div class="field"><span>Publisher Name</span><strong>${primitive(section?.publisher_name)}</strong></div>
    </div>
    <div class="evidence-block baseline">
      <span class="evidence-badge baseline">EXISTING BASELINE</span>
      ${renderValue(baseline, 1)}
    </div>
    <div class="evidence-block current">
      <span class="evidence-badge current">CURRENT RUN</span>
      ${renderValue(current, 1)}
    </div>
    <div class="evidence-block derived">
      <span class="evidence-badge derived">ASSIGNMENT CONTEXT</span>
      ${renderValue(section?.assignment, 1)}
    </div>`;
}

function renderEvidenceAppendix(appendix) {
  const reference = appendix?.primary_report_reference ||
    'Full raw evidence remains available in the machine-readable JSON export.';
  return `<p class="appendix-reference">${esc(reference)}</p>
    <details class="evidence-appendix-details">
      <summary>Expand raw evidence appendix</summary>
      <div class="evidence-appendix-content">${renderObjectGrid(appendix)}</div>
    </details>`;
}

function statusClass(value) {
  return `status-${String(value || 'draft').toLowerCase().replaceAll('_', '-')}`;
}

function reportMarkup(report) {
  const metadata = report.report_metadata || {};
  const identity = report.mission_identity || {};
  const determination = report.executive_determination || {};
  const acceptance = report.final_acceptance_decision || {};
  const operationalOutcome = report.run_status?.derived_operational_outcome || identity.final_status || 'DRAFT';
  return [
    card('1 · EXECUTIVE DETERMINATION', 'Executive Determination',
      `${renderObjectGrid(determination)}
       <div class="evidence-block current"><span class="evidence-badge current">FINAL OR INTERIM DECISION</span>${renderObjectGrid(acceptance)}</div>`,
      `<span class="status-badge ${statusClass(operationalOutcome)}">${esc(operationalOutcome)}</span>`),
    card('2 · MISSION IDENTITY', 'Mission Identity', renderObjectGrid(identity)),
    card('3 · AUTHORIZED SCOPE', 'Authorized Scope', renderObjectGrid(report.authorized_scope)),
    card('4 · PUBLISHER AND CONNECTOR', 'Publisher and Connector Evidence', renderPublisher(report.publisher_and_connector)),
    card('5 · RUN STATUS', 'Run Status', renderObjectGrid(report.run_status)),
    card('6 · EXECUTION TIMELINE', 'Chronological Timeline', renderTable(report.execution_timeline)),
    card('7 · STAGE-BY-STAGE EVIDENCE', 'Stage Evidence', renderTable(report.stage_by_stage_evidence)),
    card('8 · TASK-SPECIFIC METRICS', 'Mission-Specific Metrics', renderMetrics(report.task_specific_metrics)),
    card('9 · RECORDS OR DOCUMENTS AFFECTED', 'Affected Records and Documents', renderObjectGrid(report.records_or_documents_affected)),
    card('10 · WARNINGS', 'Warnings', renderTable(report.warnings)),
    card('11 · FAILURES', 'Failures', renderTable(report.failures)),
    card('12 · RECONCILIATION', 'Reconciliation', renderObjectGrid(report.reconciliation)),
    card('13 · REGISTRY OR DATABASE IMPACT', 'Registry and Database Impact', renderObjectGrid(report.registry_or_database_impact)),
    card('14 · ARTIFACTS AND HASHES', 'Artifacts and Hashes', renderObjectGrid(report.artifacts_and_hashes)),
    card('15 · OPERATOR ACTIONS', 'Operator Actions', renderTable(report.operator_actions)),
    card('16 · FINAL ACCEPTANCE DECISION', 'Final Acceptance Decision', renderObjectGrid(acceptance)),
    card('17 · RESTART OR FOLLOW-UP INSTRUCTIONS', 'Restart or Follow-Up Instructions', renderObjectGrid(report.restart_or_follow_up_instructions)),
    card('18 · EVIDENCE APPENDIX', 'Evidence Appendix', renderEvidenceAppendix(report.evidence_appendix), '', 'evidence-appendix-card'),
    card('REPORT CONTROL', 'Report Metadata', renderObjectGrid(metadata))
  ].join('');
}

async function fetchReport() {
  const payload = { command_run_id: commandRunId };
  if (requestedVersion) payload.report_version = Number(requestedVersion);
  const response = await fetch('/.netlify/functions/mission-report', {
    method: 'POST',
    headers: dashboardHeaders(),
    body: JSON.stringify(payload),
    cache: 'no-store',
    signal: AbortSignal.timeout(60000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Report request failed (${response.status})`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function enableControls() {
  ['printReport', 'downloadJson', 'copyReportId'].forEach(id => { byId(id).disabled = false; });
}

function showError(error) {
  byId('reportBody').hidden = true;
  byId('reportError').hidden = false;
  byId('reportTitle').textContent = error?.data?.code === 'UNSUPPORTED_REPORT_TYPE'
    ? 'Unsupported Report Type'
    : error?.status === 404 ? 'Report Not Found' : 'Report Unavailable';
  byId('reportSubtitle').textContent = 'The mission report could not be rendered.';
  byId('reportErrorTitle').textContent = byId('reportTitle').textContent;
  byId('reportErrorMessage').textContent = error.message || String(error);
  byId('reportState').textContent = 'ERROR';
  byId('reportState').className = 'status-badge status-failed';
}

function showReport(data) {
  loadedReport = data.report;
  loadedStorage = data.storage || {};
  const metadata = loadedReport.report_metadata || {};
  const identity = loadedReport.mission_identity || {};
  byId('reportTitle').textContent = metadata.report_title || 'Mission Execution Report';
  byId('reportSubtitle').textContent = `${identity.mission_name || 'Mission'} · Run ${identity.command_run_id || 'NOT REPORTED'}`;
  byId('reportState').textContent = metadata.report_state || 'DRAFT';
  byId('reportState').className = `status-badge ${statusClass(metadata.report_state)}`;
  byId('reportGenerated').textContent = `Generated ${dateValue(metadata.generated_at)}`;
  byId('reportHash').textContent = metadata.report_hash || loadedStorage.report_hash || 'NOT REPORTED';
  byId('reportBody').innerHTML = reportMarkup(loadedReport);
  byId('reportBody').hidden = false;
  byId('reportError').hidden = true;
  enableControls();
}

async function loadReport() {
  if (!commandRunId) {
    showError(Object.assign(new Error('A command_run_id is required in the id query parameter.'), { status: 400 }));
    return;
  }
  try {
    showReport(await fetchReport());
  } catch (error) {
    console.error('Mission report load failed:', error);
    showError(error);
  }
}

byId('printReport').addEventListener('click', () => window.print());

byId('downloadJson').addEventListener('click', () => {
  if (!loadedReport) return;
  const exportPayload = { report: loadedReport, storage: loadedStorage };
  const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const runId = loadedReport.mission_identity?.command_run_id || 'mission';
  const version = loadedReport.report_metadata?.report_version || 1;
  anchor.href = url;
  anchor.download = `mission-report-${runId}-v${version}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
});

byId('copyReportId').addEventListener('click', async () => {
  if (!loadedReport) return;
  const text = [
    `command_run_id: ${loadedReport.mission_identity?.command_run_id || 'NOT REPORTED'}`,
    `report_id: ${loadedReport.report_metadata?.report_id || 'NOT REPORTED'}`,
    `report_version: ${loadedReport.report_metadata?.report_version || 'NOT REPORTED'}`
  ].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    byId('reportControlMessage').textContent = 'Report identifiers copied.';
  } catch {
    byId('reportControlMessage').textContent = text;
  }
});

window.addEventListener('apie:authenticated', loadReport);
