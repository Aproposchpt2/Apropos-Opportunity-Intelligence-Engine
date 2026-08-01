const { response, requireDashboardAuth, db } = require('../lib/native-runtime');

const lower = value => String(value || '').toLowerCase();

exports.handler = async (event) => {
  if (event?.httpMethod === 'OPTIONS') return response(200, { ok: true });
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event)) return response(401, { error: 'Unauthorized' });

  try {
    const [runs, publishers, acquisitionRuns, rawRecords, systemRows] = await Promise.all([
      db('command_runs?select=*&order=created_at.desc&limit=100'),
      db('publisher_registry?select=id,publisher_name,state_code,verified,last_verified_at&order=state_code.asc,publisher_name.asc'),
      db('acquisition_runs?select=*&order=created_at.desc&limit=100'),
      db('acquisition_raw_records?select=id,acquisition_run_id,publisher_id,processing_status,retrieval_timestamp&order=retrieval_timestamp.desc&limit=500'),
      db('system_status?singleton=eq.true&select=*')
    ]);

    const activeStatuses = new Set(['queued', 'running', 'retrying', 'stopping']);
    const activeRuns = (runs || []).filter(run => activeStatuses.has(lower(run.status)));
    const attentionRuns = (runs || []).filter(run => run.action_required || ['failed', 'interrupted', 'completed_with_failures'].includes(lower(run.status)));
    const system = systemRows?.[0] || {};
    const latestAcquisition = acquisitionRuns?.[0] || null;

    return response(200, {
      generated_at: new Date().toISOString(),
      system: { ...system, operational_status: 'OPERATIONAL' },
      totals: {
        active_missions: activeRuns.length,
        missions_requiring_attention: attentionRuns.length,
        publishers: (publishers || []).length
      },
      runs: runs || [],
      active_runs: activeRuns,
      attention_runs: attentionRuns,
      publisher_registry: publishers || [],
      acquisition: {
        recent_runs: acquisitionRuns || [],
        recent_raw_records: rawRecords || [],
        recent_raw_record_count: (rawRecords || []).length,
        latest_run: latestAcquisition
      },
      health: {
        database: {
          status: 'CONNECTED',
          source: 'Netlify direct PostgREST reads',
          observed_at: new Date().toISOString()
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
    return response(500, { error: error instanceof Error ? error.message : String(error) });
  }
};
