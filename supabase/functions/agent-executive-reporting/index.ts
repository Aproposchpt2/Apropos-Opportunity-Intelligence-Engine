import { corsHeaders, db, json, parseBody, recordMetrics , requireServiceRole } from '../_shared/command.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const roleError = requireServiceRole(request); if (roleError) return roleError;
  try {
    const body = await parseBody(request) || {};
    const runId = body.run_id;
    const jobs = await db(`command_jobs?run_id=eq.${runId}&select=*`);
    const failures = await db(`command_failures?run_id=eq.${runId}&select=*`);
    const metricsRows = await db(`command_metrics?run_id=eq.${runId}&select=*`);
    const latest = {};
    for (const row of metricsRows) latest[row.metric_name] = row.metric_value ?? row.metric_text;
    const successfulJobs = jobs.filter((job) => job.status === 'completed').length;
    const failedJobs = jobs.filter((job) => job.status === 'failed').length;
    const retryActivity = jobs.reduce((sum, job) => sum + Math.max(0, (job.attempt_count || 0) - 1), 0);
    const content = {
      executive_summary: `Pipeline execution completed with ${successfulJobs} successful jobs and ${failedJobs} failed jobs.`,
      acquisition: `Publishers processed: ${latest.publishers_processed || 0}; opportunities discovered: ${latest.opportunities_discovered || 0}.`,
      intelligence_processing: `Documents processed: ${latest.documents_processed || 0}; Contract DNA completed: ${latest.contract_dna_completed || 0}.`,
      eligibility: `Eligible opportunities: ${latest.eligible_opportunities || 0}; average confidence: ${latest.average_confidence_score || 0}.`,
      delivery: `Published opportunities: ${latest.published_opportunities || 0}; removed opportunities: ${latest.removed_opportunities || 0}.`,
      system_health: `Successful jobs: ${successfulJobs}; failed jobs: ${failedJobs}; retry activity: ${retryActivity}.`
    };
    const brief = {
      run_id: runId,
      overall_status: failedJobs ? 'completed_with_failures' : 'completed',
      executive_summary: { successful_jobs: successfulJobs, failed_jobs: failedJobs, critical_issues: failures.length },
      acquisition: { jobs_executed: jobs.filter((j) => j.sequence_number === 1).length, publishers_processed: latest.publishers_processed || 0, opportunities_discovered: latest.opportunities_discovered || 0, new_opportunities: latest.opportunities_inserted || 0, updated_opportunities: latest.opportunities_updated || 0 },
      intelligence_processing: { documents_registered: latest.documents_registered || 0, documents_processed: latest.documents_processed || 0, contract_dna_completed: latest.contract_dna_completed || 0, intelligence_extraction_totals: latest.intelligence_extractions || 0 },
      eligibility: { opportunities_evaluated: latest.opportunities_evaluated || 0, eligible_opportunities: latest.eligible_opportunities || 0, match_statistics: { review_required: latest.review_required || 0 }, confidence_distribution: latest.confidence_distribution || {} },
      delivery: { published_opportunities: latest.published_opportunities || 0, removed_opportunities: latest.removed_opportunities || 0, delivery_success_rate: latest.delivery_success_rate || 0 },
      system_health: { successful_jobs: successfulJobs, failed_jobs: failedJobs, retry_activity: retryActivity, performance_metrics: latest },
      content
    };
    const rows = await db('daily_executive_briefs', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(brief) });
    await recordMetrics(runId, body.job_id, { successful_jobs: successfulJobs, failed_jobs: failedJobs, retry_count: retryActivity });
    return json({ stage: 'executive_reporting', brief: rows[0] || brief });
  } catch (error) { return json({ error: error.message }, 500); }
});
