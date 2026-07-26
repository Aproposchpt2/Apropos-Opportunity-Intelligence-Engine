import { corsHeaders, db, json, parseBody, recordEvent } from '../_shared/command.ts';
import { createTaskGraph, runAadpTask, validateAssignment } from '../_shared/aadp.ts';

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body: any = await parseBody(request);
    const assignmentId = body?.assignment_id;
    if (!assignmentId) return json({ error: 'assignment_id is required' }, 400);

    const assignments = await db(`publisher_assignments?id=eq.${assignmentId}&select=*`);
    const assignment = assignments?.[0];
    if (!assignment) return json({ error: 'Publisher assignment not found' }, 404);
    validateAssignment(assignment);

    const idempotencyKey = body.idempotency_key ?? `aadp:${assignmentId}:${new Date().toISOString().slice(0, 10)}`;
    const existing = await db(`command_runs?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=*`);
    if (existing.length) return json({ run: existing[0], idempotent_replay: true });

    const definitions = await db('command_definitions?command_key=eq.AADP_PUBLISHER_ACQUISITION&version=eq.1.0&select=id');
    const created = await db('command_runs', {
      method: 'POST',
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        definition_id: definitions?.[0]?.id ?? null,
        publisher_assignment_id: assignmentId,
        status: 'running',
        aadp_state: 'RUNNING',
        current_stage: 'PUBLISHER_ASSIGNMENT_CREATE',
        started_at: new Date().toISOString(),
        execution_evidence: { assignment_id: assignmentId, architecture: 'AADP-OS-V1' }
      })
    });
    const run = created[0];
    const tasks = await createTaskGraph(run.id);
    await recordEvent(run.id, null, 'AADP_RUN_STARTED', 'AADP publisher acquisition run started', { assignment_id: assignmentId, task_count: tasks.length });

    let finalState = 'COMPLETED';
    for (const task of tasks) {
      const current = (await db(`command_tasks?id=eq.${task.id}&select=*`))[0];
      if (!['READY','RETRY_PENDING'].includes(current.state)) continue;
      await db(`command_runs?id=eq.${run.id}`, { method: 'PATCH', body: JSON.stringify({ current_stage: current.task_type }) });
      try {
        await runAadpTask(run.id, current, assignment);
      } catch {
        finalState = 'ESCALATED';
        break;
      }
    }

    const remaining = await db(`command_tasks?run_id=eq.${run.id}&state=not.in.(COMPLETED,CANCELLED)&select=id,state,task_type`);
    if (remaining.length && finalState === 'COMPLETED') finalState = 'PARTIALLY_COMPLETE';
    await db(`command_runs?id=eq.${run.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        aadp_state: finalState,
        status: finalState === 'COMPLETED' ? 'completed' : finalState === 'ESCALATED' ? 'failed' : 'completed_with_failures',
        completed_at: new Date().toISOString(),
        current_stage: null,
        execution_evidence: { assignment_id: assignmentId, architecture: 'AADP-OS-V1', remaining_tasks: remaining }
      })
    });
    await recordEvent(run.id, null, 'AADP_RUN_FINISHED', `AADP run finished as ${finalState}`, { remaining_tasks: remaining.length });
    return json({ run_id: run.id, status: finalState, remaining_tasks: remaining });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
