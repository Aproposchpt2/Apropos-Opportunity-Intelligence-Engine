import { corsHeaders, db, json, requireDashboardAuth } from '../_shared/command.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const authError = await requireDashboardAuth(request); if (authError) return authError;
  try {
    const runs = await db('command_runs?select=*&order=created_at.desc&limit=20');
    const run = runs[0] || null;
    const jobs = run ? await db(`command_jobs?run_id=eq.${run.id}&select=*&order=sequence_number.asc`) : [];
    const failures = run ? await db(`command_failures?run_id=eq.${run.id}&select=*&order=created_at.desc&limit=50`) : [];
    const rows = run ? await db(`command_metrics?run_id=eq.${run.id}&select=metric_name,metric_value,metric_text,recorded_at&order=recorded_at.desc`) : [];
    const metrics = {};
    for (const row of rows.reverse()) metrics[row.metric_name] = row.metric_value ?? row.metric_text;
    const status = (await db('system_status?singleton=eq.true&select=*'))[0] || {};
    metrics.system_status = status.operational_status;
    metrics.connector_health = status.connector_health?.overall || status.connector_health?.status || 'Unknown';
    metrics.running_jobs = jobs.filter((job) => ['running','retrying'].includes(job.status)).length;
    metrics.completed_jobs = jobs.filter((job) => job.status === 'completed').length;
    metrics.failed_jobs = jobs.filter((job) => job.status === 'failed').length;
    metrics.retry_count = jobs.reduce((sum, job) => sum + Math.max(0, (job.attempt_count || 0) - 1), 0);
    metrics.queue_depth = jobs.filter((job) => job.status === 'pending').length;

    let aadp_process = [], aadp_action_needed = [], aadp_publisher_run = null, aadp_recommendations = [];
    if (run?.publisher_assignment_id) {
      aadp_process = await db(`aadp_process_stage_projection?command_run_id=eq.${run.id}&select=*&order=updated_at.asc`);
      aadp_action_needed = await db(`aadp_action_needed_alerts?command_run_id=eq.${run.id}&status=eq.OPEN&select=*&order=created_at.asc`);
      const acquisitionRuns = await db(`acquisition_runs?command_run_id=eq.${run.id}&select=*,publisher_assignments(publisher_name,publisher_registry(state_code))&order=created_at.desc&limit=1`);
      const acquisition = acquisitionRuns?.[0] || null;
      aadp_publisher_run = acquisition ? {
        ...acquisition,
        publisher_name: acquisition.publisher_assignments?.publisher_name,
        state_code: acquisition.publisher_assignments?.publisher_registry?.state_code
      } : null;
      if (acquisition) {
        const reviews = await db(`aoie_batch_reviews?acquisition_run_id=eq.${acquisition.id}&select=id`);
        if (reviews?.[0]) aadp_recommendations = await db(`aoie_change_recommendations?batch_review_id=eq.${reviews[0].id}&select=*&order=created_at.asc`);
      }
    }

    return json({ run, jobs, metrics, failures, history: runs, aadp_process, aadp_action_needed, aadp_publisher_run, aadp_recommendations });
  } catch (error) { return json({ error: error.message }, 500); }
});
