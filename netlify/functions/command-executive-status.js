import { response, requireDashboardAuth, db } from './_shared/native-runtime.js';

const lower = value => String(value || '').toLowerCase();
const errorMessage = reason => reason instanceof Error ? reason.message : String(reason || 'Unknown read failure');

async function safeRead(label, query) {
  try {
    return { label, ok: true, data: await db(query), error: null };
  } catch (error) {
    console.error(`command-executive-status ${label} read failed`, error);
    return { label, ok: false, data: [], error: errorMessage(error) };
  }
}

export const handler = async (event) => {
  if (event?.httpMethod === 'OPTIONS') return response(200, { ok: true });
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event)) return response(401, { error: 'Unauthorized' });

  try {
    const results = await Promise.all([
      safeRead('command_runs', 'command_runs?select=*&order=created_at.desc&limit=100'),
      safeRead('publisher_registry', 'publisher_registry?select=id,publisher_name,state_code,verified,last_verified_at&order=state_code.asc,publisher_name.asc'),
      safeRead('acquisition_runs', 'acquisition_runs?select=*&order=created_at.desc&limit=100'),
      safeRead('acquisition_raw_records', 'acquisition_raw_records?select=id,acquisition_run_id,publisher_id,processing_status,retrieval_timestamp&order=retrieval_timestamp.desc&limit=500'),
      safeRead('system_status', 'system_status?singleton=eq.true&select=*')
    ]);

    const byLabel = Object.fromEntries(results.map(result => [result.label, result]));
    const runs = byLabel.command_runs.data || [];
    const publishers = byLabel.publisher_registry.data || [];
    const acquisitionRuns = byLabel.acquisition_runs.data || [];
    const rawRecords = byLabel.acquisition_raw_records.data || [];
    const systemRows = byLabel.system_status.data || [];
    const degradedReads = results.filter(result => !result.ok).map(result => ({ source: result.label, error: result.error }));

    if (!byLabel.command_runs.ok) {
      return response(503, {
        error: 'Executive status cannot load the authoritative command run stream.',
        degraded_reads: degradedReads,
        generated_at: new Date().toISOString()
      });
    }

    const activeStatuses = new Set(['queued', 'running', 'retrying', 'stopping']);
    const activeRuns = runs.filter(run => activeStatuses.has(lower(run.status)));
    const attentionRuns = runs.filter(run => run.action_required || ['failed', 'interrupted', 'completed_with_failures'].includes(lower(run.status)));
    const system = systemRows?.[0] || {};
    const latestAcquisition = acquisitionRuns?.[0] || null;
    const operationalStatus = degradedReads.length ? 'DEGRADED' : 'OPERATIONAL';

    return response(200, {
      generated_at: new Date().toISOString(),
      system: { ...system, operational_status: operationalStatus },
      totals: {
        active_missions: activeRuns.length,
        missions_requiring_attention: attentionRuns.length,
        publishers: publishers.length
      },
      runs,
      active_runs: activeRuns,
      attention_runs: attentionRuns,
      publisher_registry: publishers,
      acquisition: {
        recent_runs: acquisitionRuns,
        recent_raw_records: rawRecords,
        recent_raw_record_count: rawRecords.length,
        latest_run: latestAcquisition
      },
      health: {
        database: {
          status: degradedReads.length ? 'DEGRADED' : 'CONNECTED',
          source: 'Netlify direct PostgREST reads',
          observed_at: new Date().toISOString(),
          degraded_reads: degradedReads
        },
        command_runtime: {
          status: activeRuns.length ? 'RUNNING' : 'IDLE',
          source: 'command_runs',
          observed_at: runs?.[0]?.last_activity_at || runs?.[0]?.updated_at || runs?.[0]?.created_at || new Date().toISOString()
        }
      }
    });
  } catch (error) {
    console.error('command-executive-status failed', error);
    return response(500, { error: errorMessage(error) });
  }
};
