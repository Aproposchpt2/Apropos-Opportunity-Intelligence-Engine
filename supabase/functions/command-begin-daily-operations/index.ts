import { AGENT_SEQUENCE, corsHeaders, db, invoke, json, parseBody, recordEvent, requireDashboardAuth } from '../_shared/command.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const authError = await requireDashboardAuth(request); if (authError) return authError;
  try {
    const body = await parseBody(request) || {};
    const date = body.operation_date || new Date().toISOString().slice(0, 10);
    const idempotencyKey = `daily:${date}`;
    const active = await db(`command_runs?status=in.(queued,running,retrying,stopping)&select=*&limit=1`);
    if (active.length) return json({ run: active[0], duplicate_prevented: true }, 409);

    let runs = await db(`command_runs?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=*`);
    let run = runs[0];
    if (!run) {
      [run] = await db('command_runs', { method: 'POST', body: JSON.stringify({ idempotency_key: idempotencyKey, status: 'running', current_stage: AGENT_SEQUENCE[0].name, started_at: new Date().toISOString() }) });
      const jobs = AGENT_SEQUENCE.map(agent => ({ run_id: run.id, sequence_number: agent.sequence, agent_name: agent.name, function_name: agent.functionName }));
      await db('command_jobs', { method: 'POST', body: JSON.stringify(jobs) });
    } else if (run.status === 'completed') {
      return json({ run, duplicate_prevented: true });
    }

    await db('system_status?singleton=eq.true', { method: 'PATCH', body: JSON.stringify({ current_run_id: run.id, current_execution_state: 'running', current_workflow_stage: run.current_stage }) });
    await recordEvent(run.id, null, 'run_started', 'Daily operations started.', { idempotency_key: idempotencyKey });

    for (const agent of AGENT_SEQUENCE) {
      const latestRun = (await db(`command_runs?id=eq.${run.id}&select=*`))[0];
      if (latestRun.stop_requested_at) {
        await db(`command_runs?id=eq.${run.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'stopped', completed_at: new Date().toISOString() }) });
        await recordEvent(run.id, null, 'run_stopped', 'Execution stopped by operator.');
        return json({ run_id: run.id, status: 'stopped' });
      }

      let job = (await db(`command_jobs?run_id=eq.${run.id}&sequence_number=eq.${agent.sequence}&select=*`))[0];
      if (job.status === 'completed') continue;
      await db(`command_runs?id=eq.${run.id}`, { method: 'PATCH', body: JSON.stringify({ current_stage: agent.name, status: 'running' }) });
      await db('system_status?singleton=eq.true', { method: 'PATCH', body: JSON.stringify({ current_execution_state: 'running', current_workflow_stage: agent.name }) });

      let completed = false;
      for (let attempt = job.attempt_count + 1; attempt <= job.max_attempts; attempt++) {
        await db(`command_jobs?id=eq.${job.id}`, { method: 'PATCH', body: JSON.stringify({ status: attempt > 1 ? 'retrying' : 'running', attempt_count: attempt, started_at: job.started_at || new Date().toISOString() }) });
        try {
          const output = await invoke(agent.functionName, { run_id: run.id, job_id: job.id, input: job.input_payload || {} });
          await db(`command_jobs?id=eq.${job.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'completed', output_payload: output, completed_at: new Date().toISOString() }) });
          await recordEvent(run.id, job.id, 'job_completed', `${agent.name} completed.`, output);
          completed = true;
          break;
        } catch (error) {
          const recoverable = attempt < job.max_attempts;
          await db('command_failures', { method: 'POST', body: JSON.stringify({ run_id: run.id, job_id: job.id, agent_name: agent.name, failure_type: recoverable ? 'recoverable' : 'permanent', recoverable, attempt_number: attempt, error_message: error.message }) });
          await recordEvent(run.id, job.id, recoverable ? 'job_retry' : 'job_failed', `${agent.name}: ${error.message}`);
          if (!recoverable) {
            await db(`command_jobs?id=eq.${job.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed', completed_at: new Date().toISOString() }) });
          }
        }
      }
      if (!completed) {
        await db(`command_runs?id=eq.${run.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed', completed_at: new Date().toISOString() }) });
        await db('system_status?singleton=eq.true', { method: 'PATCH', body: JSON.stringify({ current_execution_state: 'failed', current_workflow_stage: agent.name }) });
        return json({ run_id: run.id, status: 'failed', failed_agent: agent.name }, 500);
      }
    }

    await db(`command_runs?id=eq.${run.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'completed', current_stage: 'Complete', completed_at: new Date().toISOString(), archived_at: new Date().toISOString() }) });
    await db('system_status?singleton=eq.true', { method: 'PATCH', body: JSON.stringify({ current_execution_state: 'completed', current_workflow_stage: 'Complete' }) });
    await recordEvent(run.id, null, 'run_completed', 'Daily operations completed and archived.');
    return json({ run_id: run.id, status: 'completed' });
  } catch (error) {
    return json({ error: error.message }, 500);
  }
});
