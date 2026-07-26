import { corsHeaders, db, json, parseBody, recordEvent } from '../_shared/command.ts';
import { createTaskGraph, runAadpTask, validateAssignment } from '../_shared/aadp.ts';

type JsonRecord = Record<string, unknown>;
const asRecord = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : value == null ? '' : String(value);

async function refreshStageProjection(runId: string, assignment: JsonRecord) {
  const tasks = await db(`command_tasks?run_id=eq.${runId}&select=*&order=created_at.asc`);
  const acquisitionRuns = await db(`acquisition_runs?command_run_id=eq.${runId}&select=id&order=created_at.desc&limit=1`);
  const acquisitionRunId = acquisitionRuns?.[0]?.id ?? null;
  const stageMap: Record<string,string> = {
    PUBLISHER_ASSIGNMENT_CREATE: 'PUBLISHER ASSIGNMENT',
    ACQUISITION_RUN_START: 'ACQUISITION START',
    ACQUISITION_PAGE_FETCH: 'RECORD RETRIEVAL',
    ACQUISITION_RECORD_STORE: 'RAW STORAGE',
    ACQUISITION_RUN_CLOSE: 'ACQUISITION CLOSE',
    RECORD_NORMALIZATION: 'POSTGRESQL PROCESSING',
    RECORD_DEDUPLICATION: 'VERSION AND DUPLICATE CONTROL',
    RECORD_QUALIFICATION: 'CONTRACT QUALIFICATION',
    QUALIFIED_RECORD_UPSERT: 'NEW CONTRACT APPROVED TO ADD',
    REJECTION_RECORD_CREATE: 'TERMINAL DISPOSITIONS',
    RUN_RECONCILIATION: 'RECONCILIATION',
    PROCUREMENT_LANGUAGE_ANALYSIS: 'CONTRACT ANALYSIS',
    AOIE_BATCH_REVIEW: 'AOIE REVIEW',
    MATCHING_RECOMMENDATION_CREATE: 'CHANGE OR NO CHANGE',
    MATCHING_RECOMMENDATION_TEST: 'RECOMMENDATION TESTING',
    EXECUTIVE_REPORT_CREATE: 'EXECUTIVE REPORT'
  };
  for (const task of tasks) {
    const displayState = task.state === 'COMPLETED' ? 'COMPLETED'
      : task.state === 'RUNNING' ? 'IN PROGRESS'
      : task.state === 'READY' || task.state === 'ASSIGNED' ? 'QUEUED'
      : task.state === 'RETRY_PENDING' ? 'ACTION NEEDED'
      : task.state === 'ESCALATED' || task.state === 'FAILED' ? 'FAILED'
      : task.state === 'CANCELLED' ? 'CANCELLED'
      : 'NOT STARTED';
    const attempts = Number(task.output_payload?.attempt_count ?? 0);
    const warnings = task.state === 'RETRY_PENDING' ? 1 : 0;
    const failures = ['FAILED','ESCALATED'].includes(task.state) ? 1 : 0;
    const records = Number(Object.values(asRecord(task.measurable_result)).find(value => typeof value === 'number') ?? 0);
    await db('aadp_process_stage_projection', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        command_run_id: runId,
        acquisition_run_id: acquisitionRunId,
        publisher_id: assignment.publisher_id,
        publisher_name: assignment.publisher_name,
        stage_key: task.task_type,
        display_name: stageMap[task.task_type] ?? task.task_type.replaceAll('_',' '),
        display_state: displayState,
        started_at: task.started_at,
        completed_at: task.completed_at,
        records_processed: records,
        warning_count: warnings,
        failure_count: failures,
        retry_count: Math.max(0, attempts - 1),
        evidence: { task_id: task.id, measurable_result: task.measurable_result, execution_evidence: task.execution_evidence },
        updated_at: new Date().toISOString()
      })
    });
  }
}

async function semanticValidation(runId: string) {
  const response = await db('rpc/aadp_validate_semantic_completion', { method: 'POST', body: JSON.stringify({ p_command_run_id: runId }) });
  return Array.isArray(response) ? response[0] : response;
}

async function executeRun(runId: string, assignment: JsonRecord) {
  let terminalFailure = false;
  let safetyCounter = 0;
  await db(`command_runs?id=eq.${runId}`, { method: 'PATCH', body: JSON.stringify({ status: 'running', aadp_state: 'RUNNING' }) });

  while (safetyCounter < 100) {
    safetyCounter += 1;
    const ready = await db(`command_tasks?run_id=eq.${runId}&state=in.(READY,RETRY_PENDING)&select=*&order=created_at.asc&limit=1`);
    if (!ready.length) break;
    const task = ready[0];
    if (task.state === 'RETRY_PENDING' && task.scheduled_for && new Date(task.scheduled_for).getTime() > Date.now()) {
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, new Date(task.scheduled_for).getTime() - Date.now())));
      continue;
    }
    await db(`command_runs?id=eq.${runId}`, { method: 'PATCH', body: JSON.stringify({ current_stage: task.task_type }) });
    const outcome = await runAadpTask(runId, task, assignment);
    await refreshStageProjection(runId, assignment);
    if (!outcome.ok && !outcome.retry) {
      terminalFailure = true;
      break;
    }
  }

  const remaining = await db(`command_tasks?run_id=eq.${runId}&state=not.in.(COMPLETED,CANCELLED)&select=id,state,task_type`);
  let semantic: JsonRecord = {};
  if (!terminalFailure && remaining.length === 0) {
    semantic = asRecord(await semanticValidation(runId));
  }
  const semanticallyComplete = semantic.valid === true;
  const finalAadpState = terminalFailure ? 'ESCALATED' : semanticallyComplete ? 'COMPLETED' : remaining.length ? 'PARTIALLY_COMPLETE' : 'PAUSED';
  const finalStatus = terminalFailure ? 'failed' : semanticallyComplete ? 'completed' : 'completed_with_failures';
  await db(`command_runs?id=eq.${runId}`, { method: 'PATCH', body: JSON.stringify({
    aadp_state: finalAadpState,
    status: finalStatus,
    completed_at: semanticallyComplete || terminalFailure ? new Date().toISOString() : null,
    current_stage: null,
    execution_evidence: { assignment_id: assignment.id, architecture: 'AADP-OS-V1.1', remaining_tasks: remaining, semantic_completion: semantic }
  }) });
  await refreshStageProjection(runId, assignment);
  await recordEvent(runId, null, semanticallyComplete ? 'AADP_RUN_SEMANTICALLY_COMPLETE' : terminalFailure ? 'AADP_RUN_FAILED' : 'AADP_RUN_ACTION_NEEDED', `AADP run finished as ${finalAadpState}`, { remaining_tasks: remaining.length, semantic_completion: semantic });
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = asRecord(await parseBody(request));
    const resumeRunId = text(body.resume_run_id);
    let run: JsonRecord;
    let assignment: JsonRecord;

    if (resumeRunId) {
      const runs = await db(`command_runs?id=eq.${resumeRunId}&select=*`);
      run = runs?.[0];
      if (!run) return json({ error: 'Command run not found' }, 404);
      const assignments = await db(`publisher_assignments?id=eq.${run.publisher_assignment_id}&select=*`);
      assignment = assignments?.[0];
      if (!assignment) return json({ error: 'Publisher assignment not found' }, 404);
      validateAssignment(assignment as any);
      const interrupted = await db(`command_tasks?run_id=eq.${resumeRunId}&state=in.(RETRY_PENDING,ESCALATED,FAILED,READY)&select=*&order=created_at.asc&limit=1`);
      const resumeStage = interrupted?.[0]?.task_type ?? null;
      if (interrupted?.[0] && ['ESCALATED','FAILED'].includes(interrupted[0].state)) {
        await db(`command_tasks?id=eq.${interrupted[0].id}`, { method: 'PATCH', body: JSON.stringify({ state: 'RETRY_PENDING', scheduled_for: new Date().toISOString() }) });
      }
      await db(`command_runs?id=eq.${resumeRunId}`, { method: 'PATCH', body: JSON.stringify({ aadp_state: 'RUNNING', status: 'running', resume_source_stage: resumeStage, resumed_at: new Date().toISOString(), completed_at: null }) });
      await recordEvent(resumeRunId, null, 'AADP_RUN_RESUMED', 'AADP publisher run resumed from last unresolved stage', { resume_source_stage: resumeStage });
    } else {
      const assignmentId = text(body.assignment_id);
      if (!assignmentId) return json({ error: 'assignment_id is required' }, 400);
      const assignments = await db(`publisher_assignments?id=eq.${assignmentId}&select=*`);
      assignment = assignments?.[0];
      if (!assignment) return json({ error: 'Publisher assignment not found' }, 404);
      validateAssignment(assignment as any);
      const idempotencyKey = text(body.idempotency_key) || `aadp:${assignmentId}:${new Date().toISOString().slice(0,10)}`;
      const existing = await db(`command_runs?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=*`);
      if (existing.length) return json({ run_id: existing[0].id, status: existing[0].aadp_state, idempotent_replay: true }, 202);
      const definitions = await db('command_definitions?command_key=eq.AADP_PUBLISHER_ACQUISITION&select=id&order=updated_at.desc&limit=1');
      const created = await db('command_runs', { method: 'POST', body: JSON.stringify({
        idempotency_key: idempotencyKey,
        definition_id: definitions?.[0]?.id ?? null,
        publisher_assignment_id: assignmentId,
        status: 'queued',
        aadp_state: 'QUEUED',
        current_stage: 'PUBLISHER_ASSIGNMENT_CREATE',
        execution_evidence: { assignment_id: assignmentId, architecture: 'AADP-OS-V1.1', asynchronous_submission: true }
      }) });
      run = created[0];
      const tasks = await createTaskGraph(run.id as string);
      await recordEvent(run.id as string, null, 'AADP_RUN_SUBMITTED', 'AADP publisher acquisition run submitted', { assignment_id: assignmentId, task_count: tasks.length });
    }

    EdgeRuntime.waitUntil(executeRun(run.id as string, assignment));
    return json({ run_id: run.id, status: 'QUEUED', asynchronous: true, poll: `command_runs?id=eq.${run.id}` }, 202);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
