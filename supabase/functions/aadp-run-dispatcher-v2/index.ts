import { db, json, parseBody, recordEvent , requireServiceRole } from '../_shared/command.ts';
import { runAadpTask } from '../_shared/aadp.ts';

type JsonRecord = Record<string, unknown>;
const asRecord = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : value == null ? '' : String(value);

async function semanticValidation(runId: string) {
  const response = await db('rpc/aadp_validate_semantic_completion', { method: 'POST', body: JSON.stringify({ p_command_run_id: runId }) });
  return Array.isArray(response) ? response[0] : response;
}

async function finalize(runId: string) {
  const remaining = await db(`command_tasks?run_id=eq.${runId}&state=not.in.(COMPLETED,CANCELLED)&select=id,state,task_type`);
  const escalated = remaining.filter((task: any) => ['ESCALATED','FAILED'].includes(task.state));
  const semantic = remaining.length === 0 ? asRecord(await semanticValidation(runId)) : {};
  const complete = semantic.valid === true;
  const aadpState = escalated.length ? 'ESCALATED' : complete ? 'COMPLETED' : remaining.length ? 'RUNNING' : 'PAUSED';
  const status = escalated.length ? 'failed' : complete ? 'completed' : 'running';
  await db(`command_runs?id=eq.${runId}`, { method: 'PATCH', body: JSON.stringify({
    aadp_state: aadpState, status, current_stage: remaining?.[0]?.task_type ?? null,
    completed_at: complete || escalated.length ? new Date().toISOString() : null,
    execution_evidence: { architecture: 'AADP-OS-V1.4-BOUNDED-DURABLE', remaining_tasks: remaining, semantic_completion: semantic, heartbeat_at: new Date().toISOString() }
  }) });
  if (complete || escalated.length) await recordEvent(runId, null, complete ? 'AADP_RUN_SEMANTICALLY_COMPLETE' : 'AADP_RUN_FAILED', `AADP run finalized as ${aadpState}`, { remaining_tasks: remaining.length, semantic_completion: semantic });
  return { complete, aadp_state: aadpState, remaining: remaining.length };
}

Deno.serve(async (request: Request) => {
  const roleError = requireServiceRole(request); if (roleError) return roleError;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = asRecord(await parseBody(request));
    const runId = text(body.run_id);
    const batchLimit = Math.max(1, Math.min(8, Number(body.batch_limit ?? 5)));
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

    const processed: string[] = [];
    for (let index = 0; index < batchLimit; index += 1) {
      const ready = await db(`command_tasks?run_id=eq.${runId}&state=in.(READY,RETRY_PENDING)&select=*&order=created_at.asc&limit=1`);
      if (!ready.length) break;
      const task = ready[0];
      if (task.state === 'RETRY_PENDING' && task.scheduled_for && new Date(task.scheduled_for).getTime() > Date.now()) break;
      await db(`command_runs?id=eq.${runId}`, { method: 'PATCH', body: JSON.stringify({ status: 'running', aadp_state: 'RUNNING', current_stage: task.task_type, execution_evidence: { ...(run.execution_evidence ?? {}), architecture: 'AADP-OS-V1.4-BOUNDED-DURABLE', heartbeat_at: new Date().toISOString(), dispatched_task_id: task.id } }) });
      const outcome = await runAadpTask(runId, task, assignment);
      processed.push(task.task_type);
      if (!outcome.ok && !outcome.retry) break;
      if (!outcome.ok && outcome.retry) break;
    }
    const final = await finalize(runId);
    return json({ run_id: runId, processed, batch_limit: batchLimit, ...final }, final.complete ? 200 : 202);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
