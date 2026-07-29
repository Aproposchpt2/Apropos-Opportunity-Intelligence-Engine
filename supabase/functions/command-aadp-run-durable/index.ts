import { corsHeaders, db, invoke, json, parseBody, recordEvent } from '../_shared/command.ts';
import { createTaskGraph, validateAssignment } from '../_shared/aadp.ts';

type JsonRecord = Record<string, unknown>;
const asRecord = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : value == null ? '' : String(value);

async function bindMission(missionId: string, runId: string) {
  if (!missionId) return;
  await db('rpc/command_bind_mission_run', {
    method: 'POST',
    body: JSON.stringify({ p_mission_id: missionId, p_command_run_id: runId })
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = asRecord(await parseBody(request));
    const missionId = text(body.mission_id);
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
      if (missionId) await bindMission(missionId, resumeRunId);
      const unresolved = await db(`command_tasks?run_id=eq.${resumeRunId}&state=not.in.(COMPLETED,CANCELLED)&select=*&order=created_at.asc&limit=1`);
      const resumeStage = unresolved?.[0]?.task_type ?? null;
      if (unresolved?.[0] && ['ESCALATED','FAILED','RUNNING'].includes(unresolved[0].state)) {
        await db(`command_tasks?id=eq.${unresolved[0].id}`, { method: 'PATCH', body: JSON.stringify({ state: 'RETRY_PENDING', scheduled_for: new Date().toISOString() }) });
      }
      await db(`command_runs?id=eq.${resumeRunId}`, { method: 'PATCH', body: JSON.stringify({ aadp_state: 'RUNNING', status: 'running', current_stage: resumeStage, resume_source_stage: resumeStage, resumed_at: new Date().toISOString(), completed_at: null, execution_evidence: { ...(run.execution_evidence ?? {}), architecture: 'AADP-OS-V1.3-DURABLE', resume_requested_at: new Date().toISOString(), mission_id: missionId || run.execution_evidence?.mission_id || null } }) });
      await recordEvent(resumeRunId, null, 'AADP_RUN_RESUMED', 'AADP publisher run resumed through durable dispatcher', { resume_source_stage: resumeStage, mission_id: missionId || null });
    } else {
      const assignmentId = text(body.assignment_id);
      if (!assignmentId) return json({ error: 'assignment_id is required' }, 400);
      const assignments = await db(`publisher_assignments?id=eq.${assignmentId}&select=*`);
      assignment = assignments?.[0];
      if (!assignment) return json({ error: 'Publisher assignment not found' }, 404);
      validateAssignment(assignment as any);
      const idempotencyKey = text(body.idempotency_key) || `aadp:${assignmentId}:${new Date().toISOString().slice(0,10)}`;
      const existing = await db(`command_runs?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=*`);
      if (existing.length) {
        if (missionId) await bindMission(missionId, existing[0].id);
        EdgeRuntime.waitUntil(invoke('aadp-run-dispatcher', { run_id: existing[0].id }));
        return json({ run_id: existing[0].id, mission_id: missionId || null, status: existing[0].aadp_state, idempotent_replay: true, dispatch_scheduled: true }, 202);
      }
      const definitions = await db('command_definitions?command_key=eq.AADP_PUBLISHER_ACQUISITION&select=id&order=updated_at.desc&limit=1');
      const created = await db('command_runs', { method: 'POST', body: JSON.stringify({ idempotency_key: idempotencyKey, definition_id: definitions?.[0]?.id ?? null, publisher_assignment_id: assignmentId, status: 'queued', aadp_state: 'QUEUED', current_stage: 'PUBLISHER_ASSIGNMENT_CREATE', execution_evidence: { assignment_id: assignmentId, architecture: 'AADP-OS-V1.3-DURABLE', asynchronous_submission: true, mission_id: missionId || null } }) });
      run = created[0];
      if (missionId) await bindMission(missionId, run.id as string);
      const tasks = await createTaskGraph(run.id as string);
      await recordEvent(run.id as string, null, 'AADP_RUN_SUBMITTED', 'AADP publisher acquisition run submitted to durable dispatcher', { assignment_id: assignmentId, task_count: tasks.length, mission_id: missionId || null });
    }
    EdgeRuntime.waitUntil(invoke('aadp-run-dispatcher', { run_id: run.id }));
    return json({ run_id: run.id, mission_id: missionId || null, status: 'QUEUED', asynchronous: true, durable_dispatch: true, poll: `command_runs?id=eq.${run.id}` }, 202);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});