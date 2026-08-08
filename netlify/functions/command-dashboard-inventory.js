import { response, requireDashboardAuth, db } from './_shared/native-runtime.js';

const lower = value => String(value || '').toLowerCase();
const upper = value => String(value || '').toUpperCase();

async function readAll(path, pageSize = 1000, maxPages = 100) {
  const rows = [];
  for (let page = 0; page < maxPages; page += 1) {
    const start = page * pageSize;
    const end = start + pageSize - 1;
    const batch = await db(path, { headers: { Range: `${start}-${end}`, 'Range-Unit': 'items' } });
    if (!Array.isArray(batch)) throw new Error('Inventory query did not return a record array.');
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
  throw new Error('Inventory query exceeded the governed pagination ceiling.');
}

function isNineDayOpportunity(contract, cutoff) {
  if (contract.state_code !== 'CA') return false;
  if (lower(contract.status) !== 'open') return false;
  if (contract.is_latest_version !== true) return false;
  if (!contract.response_deadline) return false;
  const deadline = new Date(contract.response_deadline);
  return Number.isFinite(deadline.getTime()) && deadline >= cutoff;
}

export const handler = async event => {
  if (event?.httpMethod === 'OPTIONS') return response(200, { ok: true });
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event)) return response(401, { error: 'Unauthorized' });
  try {
    const [contracts, documents, publishers, discoveryRuns] = await Promise.all([
      readAll('state_contract_opportunities?select=id,state_code,status,response_deadline,source_platform,is_latest_version,package_status,package_document_count'),
      readAll('contract_package_documents?select=id,canonical_opportunity_id,byte_size,storage_bucket,storage_path,sha256,retrieval_status,is_current'),
      readAll('publisher_registry?select=id,verified,access_status,machine_to_machine_supported,state_code,county_name'),
      db('command_runs?mission_type_key=eq.ACQUISITION_DISCOVERY&select=id,status,aadp_state,current_stage,mission_name,assigned_agent,records_discovered,records_acquired,records_accepted,records_rejected,failure_count,warning_count,result_summary,started_at,completed_at,last_activity_at,execution_evidence,reconciliation_status,qualification_status,validation_status&order=started_at.desc&limit=50')
    ]);

    const observedAt = new Date();
    const nineDayCutoff = new Date(observedAt.getTime() + 9 * 24 * 60 * 60 * 1000);
    const caNineDay = contracts.filter(contract => isNineDayOpportunity(contract, nineDayCutoff));
    const docsByOpportunity = new Map();
    for (const document of documents) {
      if (!document.canonical_opportunity_id) continue;
      if (!docsByOpportunity.has(document.canonical_opportunity_id)) docsByOpportunity.set(document.canonical_opportunity_id, []);
      docsByOpportunity.get(document.canonical_opportunity_id).push(document);
    }

    const packageCompleteCandidates = caNineDay.filter(contract => upper(contract.package_status) === 'PACKAGE_COMPLETE');
    const physicallyVerifiedMarketable = packageCompleteCandidates.filter(contract => {
      const rows = docsByOpportunity.get(contract.id) || [];
      const expected = Number(contract.package_document_count || 0);
      if (!rows.length || expected <= 0 || rows.length !== expected) return false;
      return rows.every(document => Number(document.byte_size || 0) > 0 && Boolean(document.storage_bucket) && Boolean(document.storage_path) && Boolean(document.sha256));
    });
    const packageReconciliationExceptions = packageCompleteCandidates.length - physicallyVerifiedMarketable.length;
    const recoverableIncomplete = caNineDay.filter(contract => upper(contract.package_status) !== 'PACKAGE_COMPLETE');

    const m2mPublishers = publishers.filter(publisher => publisher.machine_to_machine_supported === true);
    const caM2mPublishers = m2mPublishers.filter(publisher => publisher.state_code === 'CA');
    const runs = Array.isArray(discoveryRuns) ? discoveryRuns : [];
    const activeDiscoveryRuns = runs.filter(run => ['queued','running','retrying','processing'].includes(lower(run.status)));
    const completedDiscoveryRuns = runs.filter(run => ['completed','completed_with_warnings','partially_complete'].includes(lower(run.status)));
    const failedDiscoveryRuns = runs.filter(run => ['failed','blocked','interrupted'].includes(lower(run.status)));
    const latestDiscoveryRun = runs[0] || null;

    return response(200, {
      generated_at: observedAt.toISOString(),
      marketability_window_days: 9,
      current_contracts: physicallyVerifiedMarketable.length,
      total_contract_records: contracts.length,
      ca_nine_day_opportunities: caNineDay.length,
      package_complete_candidates: packageCompleteCandidates.length,
      package_reconciliation_exceptions: packageReconciliationExceptions,
      recoverable_incomplete_packages: recoverableIncomplete.length,
      publishers: publishers.length,
      verified_publishers: publishers.filter(publisher => publisher.verified === true).length,
      m2m_publishers: m2mPublishers.length,
      ca_m2m_publishers: caM2mPublishers.length,
      m2m: {
        publishers: caM2mPublishers.length,
        marketable_contracts: physicallyVerifiedMarketable.length,
        marketable_target: 500,
        nine_day_opportunities: caNineDay.length,
        package_complete_candidates: packageCompleteCandidates.length,
        package_recovery_queue: recoverableIncomplete.length,
        package_reconciliation_exceptions: packageReconciliationExceptions,
        active_discovery_runs: activeDiscoveryRuns.length,
        completed_discovery_runs: completedDiscoveryRuns.length,
        failed_discovery_runs: failedDiscoveryRuns.length,
        execution: {
          status: activeDiscoveryRuns.length ? 'RUNNING' : 'READY',
          mode: 'SINGLE_M2M_PUBLISHER_DISCOVERY',
          publishers_per_run: 1,
          operator_managed: true
        },
        last_discovery_run: latestDiscoveryRun ? {
          id: latestDiscoveryRun.id,
          status: latestDiscoveryRun.status,
          aadp_state: latestDiscoveryRun.aadp_state,
          current_stage: latestDiscoveryRun.current_stage,
          records_discovered: Number(latestDiscoveryRun.records_discovered || 0),
          records_acquired: Number(latestDiscoveryRun.records_acquired || 0),
          records_accepted: Number(latestDiscoveryRun.records_accepted || 0),
          records_rejected: Number(latestDiscoveryRun.records_rejected || 0),
          failure_count: Number(latestDiscoveryRun.failure_count || 0),
          warning_count: Number(latestDiscoveryRun.warning_count || 0),
          result_summary: latestDiscoveryRun.result_summary || null,
          started_at: latestDiscoveryRun.started_at || null,
          completed_at: latestDiscoveryRun.completed_at || null,
          last_activity_at: latestDiscoveryRun.last_activity_at || null,
          publisher_name: latestDiscoveryRun.execution_evidence?.publisher_name || null,
          reconciliation_status: latestDiscoveryRun.reconciliation_status || null,
          qualification_status: latestDiscoveryRun.qualification_status || null,
          validation_status: latestDiscoveryRun.validation_status || null
        } : null
      },
      definitions: {
        current_contracts: 'California OPEN + latest version + response deadline at least 9 days away + PACKAGE_COMPLETE + physical document rows match package_document_count + each document has non-zero bytes, storage location, and SHA-256',
        recoverable_incomplete_packages: 'California OPEN + latest version + response deadline at least 9 days away + package_status is not PACKAGE_COMPLETE',
        package_reconciliation_exceptions: 'Records that satisfy the 9-day marketability window and claim PACKAGE_COMPLETE but fail physical package evidence reconciliation',
        m2m_publishers: 'publisher_registry records classified machine_to_machine_supported=true'
      },
      sources: {
        marketable_contracts: 'state_contract_opportunities + contract_package_documents',
        publishers: 'publisher_registry',
        m2m_discovery: 'command_runs'
      }
    });
  } catch (error) {
    console.error('command-dashboard-inventory failed', error);
    return response(500, { error: error instanceof Error ? error.message : String(error) });
  }
};