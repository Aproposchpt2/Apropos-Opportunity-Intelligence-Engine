import { corsHeaders, db, invoke, json, parseBody } from '../_shared/command.ts';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
}

async function acquisitionRun(runId: string): Promise<JsonRecord> {
  const rows = await db(`acquisition_runs?command_run_id=eq.${runId}&select=*&order=created_at.desc&limit=1`);
  if (!rows?.[0]) throw new Error('Acquisition run has not been initialized');
  return rows[0];
}

async function createExecutiveReport(runId: string) {
  const run = await acquisitionRun(runId);
  const [raw, dispositions, rejections, analyses, reviews, tasks, failures] = await Promise.all([
    db(`acquisition_raw_records?acquisition_run_id=eq.${run.id}&select=id`),
    db(`acquisition_record_dispositions?acquisition_run_id=eq.${run.id}&select=disposition`),
    db(`acquisition_rejections?acquisition_run_id=eq.${run.id}&select=rejection_code`),
    db(`procurement_language_analysis?acquisition_run_id=eq.${run.id}&select=id,confidence`),
    db(`aoie_batch_reviews?acquisition_run_id=eq.${run.id}&select=*`),
    db(`command_tasks?run_id=eq.${runId}&select=task_type,state,measurable_result`),
    db(`command_failures?run_id=eq.${runId}&select=*`)
  ]);

  const review = reviews?.[0] ?? null;
  const recommendations = review
    ? await db(`aoie_change_recommendations?batch_review_id=eq.${review.id}&select=*`)
    : [];
  const reconciliationResult = await db('rpc/aadp_reconcile_run', {
    method: 'POST',
    body: JSON.stringify({ p_acquisition_run_id: run.id })
  });
  const reconciliation = Array.isArray(reconciliationResult) ? reconciliationResult[0] : reconciliationResult;

  const dispositionTotals: Record<string, number> = {};
  for (const row of dispositions) {
    const key = text(row.disposition) || 'UNKNOWN';
    dispositionTotals[key] = (dispositionTotals[key] ?? 0) + 1;
  }

  const finalStatus = failures.length ? 'PARTIALLY_COMPLETE' : 'COMPLETED';
  const report = {
    command_run_id: runId,
    acquisition: {
      acquisition_run_id: run.id,
      records_retrieved: raw.length,
      pages_processed: Number(run.pages_processed ?? 0),
      retrieval_failures: Number(run.retrieval_failures ?? 0),
      pagination_complete: Boolean(run.pagination_complete)
    },
    processing: {
      dispositions: dispositionTotals,
      rejection_count: rejections.length,
      qualified_count: Number(dispositionTotals.QUALIFIED ?? 0)
    },
    aoie: {
      analyses: analyses.length,
      review,
      recommendations: recommendations.length,
      result_indicator: review?.report?.result_indicator ?? 'NO RECOMMENDATIONS AT THIS TIME',
      production_matching_changed: false
    },
    command_center: {
      tasks,
      failures: failures.length,
      action_needed: review?.report?.result_indicator === 'NEEDS YOUR ATTENTION'
    },
    reconciliation
  };

  const existing = await db(`executive_run_reports?command_run_id=eq.${runId}&select=id`);
  const payload = { ...report, final_status: finalStatus };
  if (existing.length) {
    await db(`executive_run_reports?id=eq.${existing[0].id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  } else {
    await db('executive_run_reports', { method: 'POST', body: JSON.stringify(payload) });
  }
  await db(`acquisition_runs?id=eq.${run.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: finalStatus, completed_at: new Date().toISOString() })
  });

  return {
    success: true,
    task_type: 'EXECUTIVE_REPORT_CREATE',
    metrics: { executive_reports_created: existing.length ? 0 : 1, final_records_reconciled: raw.length },
    evidence: report
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = asRecord(await parseBody(request));
    const taskType = text(body.task_type);
    const runId = text(body.run_id);
    if (!taskType || !runId) return json({ error: 'run_id and task_type are required' }, 400);
    if (taskType === 'EXECUTIVE_REPORT_CREATE') return json(await createExecutiveReport(runId));
    return json(await invoke('aadp-task-executor', body));
  } catch (error) {
    return json({ success: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
