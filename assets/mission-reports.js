const q = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const dateValue = value => {
  if (!value || value === 'NOT REPORTED') return 'NOT REPORTED';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
};

async function registryRequest(payload = {}) {
  const response = await fetch('/.netlify/functions/mission-reports', {
    method: 'POST',
    headers: dashboardHeaders(),
    body: JSON.stringify(payload),
    cache: 'no-store',
    signal: AbortSignal.timeout(60000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Registry request failed (${response.status})`);
  return data;
}

function formPayload() {
  const data = new FormData(q('registryFilters'));
  return Object.fromEntries([...data.entries()].filter(([, value]) => String(value).trim() !== ''));
}

function renderRows(rows) {
  q('registryRows').innerHTML = rows.map(row => `<tr>
    <td>${esc(row.report_id)}</td>
    <td>${esc(row.run_id)}</td>
    <td><strong>${esc(row.mission)}</strong><br><small>${esc(row.mission_type_key)} · ${esc(row.state)}</small></td>
    <td>${esc(row.publisher)}<br><small>${esc(row.connector)}</small></td>
    <td><span class="status-badge status-${esc(String(row.status).toLowerCase().replaceAll('_', '-'))}">${esc(row.status)}</span><br><small>${esc(row.report_state)}</small></td>
    <td>${esc(dateValue(row.started))}</td>
    <td>${esc(dateValue(row.completed))}</td>
    <td>${esc(row.report_version)}</td>
    <td>${esc(row.warnings)}</td>
    <td>${esc(row.failures)}</td>
    <td>${esc(row.final_determination)}</td>
    <td><a class="action-link" href="${esc(row.view_url)}">VIEW REPORT</a></td>
  </tr>`).join('');
}

async function loadRegistry(payload = {}) {
  q('registryMessage').textContent = 'Loading mission reports…';
  try {
    const data = await registryRequest(payload);
    renderRows(data.reports || []);
    q('registryCount').textContent = `${Number(data.total || 0).toLocaleString()} record(s)`;
    q('registryUpdated').textContent = `Updated ${dateValue(data.generated_at)}`;
    q('registryMessage').textContent = data.total ? 'Mission runs and immutable report snapshots are shown below.' : 'No reports match the selected filters.';
  } catch (error) {
    console.error('Registry load failed:', error);
    q('registryMessage').textContent = error.message || String(error);
    q('registryRows').innerHTML = '';
  }
}

q('registryFilters').addEventListener('submit', event => {
  event.preventDefault();
  loadRegistry(formPayload());
});

q('clearFilters').addEventListener('click', () => {
  q('registryFilters').reset();
  loadRegistry();
});

window.addEventListener('apie:authenticated', () => loadRegistry());
