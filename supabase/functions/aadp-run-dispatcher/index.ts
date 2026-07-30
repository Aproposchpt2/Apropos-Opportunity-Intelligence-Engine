import { db, invoke, json, parseBody, recordEvent , requireServiceRole } from '../_shared/command.ts';
import { runAadpTask } from '../_shared/aadp.ts';

type JsonRecord = Record<string, unknown>;
const asRecord = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : value == null ? '' : String(value);

async function semanticValidation(runId: string) {
  const response = await db('rpc/aadp_validate_semantic_completion', { method: 'POST', body: JSON.stringify({ p_command_run_id: runId }) });
  return Array.isArray(response) ? response[0] : response;
}

async function refreshProjection(runId: string, assignment: JsonRecord) {
  const tasks = await db(`command_tasks?run_id=eq.${runId}&select=*&order=created_at.asc`);
  const acquisitionRuns = await db(`acquisition_runs?command_run_id=eq.${runId}&select=id&order=created_at.desc&limit=1`);
  const acquisitionRunId = acquisitionRuns?.[0]?.id ?? null;
  for (const task of tasks) {
    const displayState = task.state === 'COMPLETED' ? 'COMPLETED'
      : task.state === 'RUNNING' ? 'IN PROGRESS'
      : ['READY','ASSIGNED'].includes(task.state) ? 'QUEUED'
      : task.state === 'RETRY_PENDING' ? 'ACTION NEEDED'
      : ['ESCALATED','FAILED'].includes(task.state) ? 'FAILED'
      : task.state === 'CANCELLED' ? 'CANCELLED' : 'NOT STARTED';
    const attempts = Number(task.output_payload?.attempt_count ?? 0);
    const records = Number(Object.values(asRecord(task.measurable_result)).find(value => typeof value === 'number') ?? 0);
    await db('aadp_process_stage_projection', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        command_run_id: runId, acquisition_run_id: acquisitionRunId,
        publisher_id: assignment.publisher_id, publisher_name: assignment.publisher_name,
        stage_key: task.task_type, display_name: String(task.task_type).replaceAll('_',' '),
        display_state: displayState, started_at: task.started_at, completed_at: task.completed_at,
        records_processed: records, warning_count: task.state === 'RETRY_PENDING' ? 1 : 0,
        failure_count: ['FAILED','ESCALATED'].includes(task.state) ? 1 : 0,
        retry_count: Math.max(0, attempts - 1),
        evidence: { task_id: task.id, measurable_result: task.measurable_result, execution_evidence: task.execution_evidence },
        updated_at: new Date().toISOString()
      })
    });
  }
}

async function finalize(runId: string, assignment: JsonRecord) {
  const remaining = await db(`command_tasks?run_id=eq.${runId}&state=not.in.(COMPLETED,CANCELLED)&select=id,state,task_type`);
  const escalated = remaining.filter((task: any) => ['ESCALATED','FAILED'].includes(task.state));
  const semantic = remaining.length === 0 ? asRecord(await semanticValidation(runId)) : {};
  const complete = semantic.valid === true;
  const aadpState = escalated.length ? 'ESCALATED' : complete ? 'COMPLETED' : 'PAUSED';
  const status = escalated.length ? 'failed' : complete ? 'completed' : 'completed_with_failures';
  await db(`command_runs?id=eq.${runId}`, { method: 'PATCH', body: JSON.stringify({
    aadp_state: aadpState, status, current_stage: remaining?.[0]?.task_type ?? null,
    completed_at: complete || escalated.length ? new Date().toISOString() : null,
    execution_evidence: { architecture: 'AADP-OS-V1.3-DURABLE', remaining_tasks: remaining, semantic_completion: semantic }
  }) });
  await refreshProjection(runId, assignment);
  await recordEvent(runId, null, complete ? 'AADP_RUN_SEMANTICALLY_COMPLETE' : escalated.length ? 'AADP_RUN_FAILED' : 'AADP_RUN_PAUSED', `AADP durable dispatch finished as ${aadpState}`, { remaining_tasks: remaining.length, semantic_completion: semantic });
  return { complete, aadp_state: aadpState, remaining: remaining.length };
}

Deno.serve(async (request: Request) => {
  const roleError = requireServiceRole(request); if (roleError) return roleError;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = asRecord(await parseBody(request));
    const runId = text(body.run_id);
    if (!runId) return json({ error: 'run_id is required' }, 400);
    const runs = await db(`command_runs?id=eq.${runId}&select=*`);
    const run = runs?.[0];
    if (!run) return json({ error: 'Command run not found' }, 404);
    const assignments = await db(`publisher_assignments?id=eq.${run.publisher_assignment_id}&select=*`);
    const assignment = assignments?.[0];
    if (!assignment) return json({ error: 'Publisher assignment not found' }, 404);

    const staleRunning = await db(`command_tasks?run_id=eq.${runId}&state=eq.RUNNING&select=*`);
    for (const task of staleRunning) {
      const started = task.started_at ? new Date(task.started_at).getTime() : 0;
      if (started && Date.now() - started > 5 * 60 * 1000) {
        await db(`command_tasks?id=eq.${task.id}`, { method: 'PATCH', body: JSON.stringify({ state: 'RETRY_PENDING', scheduled_for: new Date().toISOString(), output_payload: { ...task.output_payload, watchdog_recovered: true } }) });
        await recordEvent(runId, null, 'AADP_WATCHDOG_RECOVERY', `${task.task_type} recovered from stale RUNNING state`, { task_id: task.id });
      }
    }

    const ready = await db(`command_tasks?run_id=eq.${runId}&state=in.(READY,RETRY_PENDING)&select=*&order=created_at.asc&limit=1`);
    if (!ready.length) return json(await finalize(runId, assignment));
    const task = ready[0];
    if (task.state === 'RETRY_PENDING' && task.scheduled_for && new Date(task.scheduled_for).getTime() > Date.now()) {
      return json({ run_id: runId, state: 'RETRY_PENDING', scheduled_for: task.scheduled_for }, 202);
    }

    await db(`command_runs?id=eq.${runId}`, { method: 'PATCH', body: JSON.stringify({
      status: 'running', aadp_state: 'RUNNING', current_stage: task.task_type,
      execution_evidence: { ...(run.execution_evidence ?? {}), architecture: 'AADP-OS-V1.3-DURABLE', last_dispatch_at: new Date().toISOString(), dispatched_task_id: task.id }
    }) });
    const outcome = await runAadpTask(runId, task, assignment);
    await refreshProjection(runId, assignment);

    if (!outcome.ok && !outcome.retry) return json(await finalize(runId, assignment));
    const nextDispatch = await invoke('aadp-run-dispatcher', { run_id: runId });
    return json({ run_id: runId, task: task.task_type, outcome, next_dispatch_acknowledged: true, next_dispatch: nextDispatch }, 202);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
