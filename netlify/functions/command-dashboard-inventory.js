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

export const handler = async event => {
  if (event?.httpMethod === 'OPTIONS') return response(200, { ok: true });
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event)) return response(401, { error: 'Unauthorized' });
  try {
    const [contracts, publishers, packageRuns] = await Promise.all([
      readAll('state_contract_opportunities?select=id,status,response_deadline,source_platform,is_latest_version,package_status'),
      readAll('publisher_registry?select=id,verified,machine_to_machine_supported'),
      db('command_runs?mission_type_key=eq.CONTRACT_PACKAGE_ACQUISITION&select=id,status,aadp_state,current_stage,mission_name,assigned_agent,records_discovered,records_acquired,records_rejected,failure_count,result_summary,started_at,completed_at,last_activity_at&order=started_at.desc&limit=25')
    ]);
    const observedAt = new Date();
    const currentContracts = contracts.filter(contract => {
      if (lower(contract.status) !== 'open') return false;
      if (!contract.response_deadline) return true;
      const deadline = new Date(contract.response_deadline);
      return Number.isFinite(deadline.getTime()) && deadline > observedAt;
    }).length;
    const caleprocure = contracts.filter(contract => lower(contract.source_platform) === 'caleprocure');
    const latestOpenCaleprocure = caleprocure.filter(contract => contract.is_latest_version === true && lower(contract.status) === 'open');
    const eligiblePackageStatuses = new Set(['','PACKAGE_NOT_STARTED','PACKAGE_DISCOVERED','PACKAGE_DOWNLOADING','PACKAGE_PARTIAL','PACKAGE_EXTRACTED']);
    const latestCaleprocureRun = (Array.isArray(packageRuns) ? packageRuns : []).find(run => /cal\s*eprocure/i.test(String(run.mission_name || '')) || /cal\s*eprocure/i.test(String(run.assigned_agent || ''))) || null;
    const runStatus = lower(latestCaleprocureRun?.status);
    const automationHealth = runStatus === 'running' || runStatus === 'queued' ? 'RUNNING' : runStatus === 'completed' ? 'OPERATIONAL' : runStatus === 'completed_with_failures' ? 'WARNING' : runStatus === 'failed' ? 'ATTENTION' : 'READY';
    return response(200, {
      generated_at: observedAt.toISOString(),
      current_contracts: currentContracts,
      total_contract_records: contracts.length,
      publishers: publishers.length,
      verified_publishers: publishers.filter(publisher => publisher.verified === true).length,
      m2m_publishers: publishers.filter(publisher => publisher.machine_to_machine_supported === true).length,
      caleprocure: {
        records: caleprocure.length,
        package_complete: caleprocure.filter(contract => upper(contract.package_status) === 'PACKAGE_COMPLETE').length,
        inventory_target: 500,
        open_normal_queue: latestOpenCaleprocure.filter(contract => eligiblePackageStatuses.has(upper(contract.package_status))).length,
        quarantined: latestOpenCaleprocure.filter(contract => upper(contract.package_status) === 'PACKAGE_FAILED').length,
        automation: {
          status: automationHealth,
          mode: 'SERIALIZED_SINGLE_CONTRACT_LANE',
          contracts_per_run: 1,
          interval_minutes: 5,
          continuation_enabled: true,
          continue_after_failure: true,
          serialized: true
        },
        last_batch: latestCaleprocureRun ? {
          id: latestCaleprocureRun.id, status: latestCaleprocureRun.status, aadp_state: latestCaleprocureRun.aadp_state,
          current_stage: latestCaleprocureRun.current_stage, records_discovered: Number(latestCaleprocureRun.records_discovered || 0),
          records_acquired: Number(latestCaleprocureRun.records_acquired || 0), records_rejected: Number(latestCaleprocureRun.records_rejected || 0),
          failure_count: Number(latestCaleprocureRun.failure_count || 0), result_summary: latestCaleprocureRun.result_summary || null,
          started_at: latestCaleprocureRun.started_at || null, completed_at: latestCaleprocureRun.completed_at || null,
          last_activity_at: latestCaleprocureRun.last_activity_at || null
        } : null
      },
      definitions: {
        current_contracts: 'status=open and response deadline is either absent or still in the future',
        publishers: 'all records currently stored in publisher_registry',
        caleprocure_open_normal_queue: 'latest open Cal eProcure contracts excluding PACKAGE_COMPLETE, PACKAGE_FAILED, and PACKAGE_REVALIDATION_REQUIRED'
      },
      sources: { current_contracts: 'state_contract_opportunities', publishers: 'publisher_registry', caleprocure: 'state_contract_opportunities + command_runs' }
    });
  } catch (error) {
    console.error('command-dashboard-inventory failed', error);
    return response(500, { error: error instanceof Error ? error.message : String(error) });
  }
};